# Domain Model

## Terms

**Event**
A named JSON payload sent by a downstream application to trigger Functions. Immutable once stored. Has a system-assigned `id`, a `name`, a `data` payload, and a `timestamp`.

**Function**
A named handler registered with the server that executes in response to a matching Event. Composed of Steps. One Event may trigger multiple Functions. A Function is defined once at startup; it is not created per-event.

**Step**
A named, idempotent unit of work within a Function. Identified within a Run by its name and call index (`"fetch-user#0"`, `"fetch-user#1"`). If a Step has already completed in a Run, its recorded output is returned immediately without re-executing — this is the memoization contract. Steps must be the only place side-effects occur inside a Function handler.

**Run**
One execution instance of a Function triggered by a specific Event. Tracks overall status and owns the Step records for that execution. A Run can be re-queued after failure; re-queued Runs resume from the first non-completed Step.

**Step key**
The storage identity of a Step within a Run: `runId + ":" + stepName + "#" + callIndex`. The call index is a per-name counter incremented each time `step.run(name, ...)` is called with the same name in a single execution, enabling loops.

**Run queue**
The mechanism by which dispatched Runs are held until a worker picks them up for execution. Decouples event receipt (HTTP) from execution (worker).

**Worker**
The process or loop that dequeues pending Runs and executes them by invoking the Function handler with a StepContext. Notified of new work via Postgres `LISTEN/NOTIFY` on the `stepper_runs` channel; also polls every 5s as a safety net. Runs in the same process as the Hono server by default (`createApp({ worker: true })`); can be separated via `createWorker()` for independent deployment. Executes up to `concurrency` (default 5, `DEFAULT_CONCURRENCY`) Runs simultaneously, further capped per Function by the Function's own `concurrency`. On startup, re-queues all Runs in `"running"` state (crash recovery).

**Retry backoff**
The delay before a failed Step is re-attempted. Configured per Step via `step.run(name, fn, { maxAttempts, backoff })`, where `backoff` is `immediate` (the default), `fixed`, `linear` or `exponential`, with optional `maxDelay` and jitter. While attempts remain the Run is parked as `"retrying"` with `retry_after` set to the next attempt time. Once a Step exhausts its `maxAttempts` (default 3), the Run is `failed`; it is only re-queued by an explicit retry (`POST /api/runs/:id/retry`).

**Determinism constraint**
A Function handler must execute the same Steps in the same order on every attempt of a Run. Step outputs are memoized by call order; if the handler branches differently on a retry, the wrong memoized output will be fed to the wrong Step. Enforced at runtime by the **Step journal**, and checked in tests by the Test runner.

**Step journal**
The Step keys a Run has requested, in order, stored on the Run. Every replay is checked against it; a divergence (inserted, removed, renamed or reordered Steps before the Run's current position) fails the Run with `HandlerVersionMismatchError`, or only logs when the Function sets `onVersionMismatch: "warn"`. Appending Steps after the recorded sequence is allowed.

**Handler version**
An optional `version` string declared on a Function and stored on each Run at creation. A Run resumed under a different version is treated as a version mismatch before its handler runs. Used for changes the Step journal cannot detect.

**Concurrency limit**
`concurrency` on a Function caps how many of its Runs are executing (`"running"`) at once, across all workers. `concurrency: n` is one bucket for the whole Function; `{ limit, key: "data.userId" }` gives each distinct value of that event field its own bucket (missing values share one). The bucket is fixed on the Run when it is dispatched. Runs that are sleeping, waiting or retrying do not hold a slot.

**StepperFunction**
The canonical TypeScript type name for a defined Function (avoids collision with the JS built-in `Function`). Created via `defineFunction()`. Parameterised as `StepperFunction<TData, TError, TRequirements>` where `TRequirements` is the Effect service layer the handler needs.

**retry_after**
A nullable timestamp column on `runs`. A Run with `status = "pending"` or `"retrying"` and a future `retry_after` is not eligible for pickup until that time passes. Set by `step.sleep` (wake time) and by Step retry backoff (next attempt time). For a `"waiting"` Run it holds the `step.waitForEvent` timeout; a waiting Run is only eligible for pickup once that timeout has passed.

**Run statuses**
- `pending` — queued for pickup (first attempt, or parked after a Step completed)
- `running` — currently being executed by a worker
- `retrying` — parked until `retry_after`: a Step failed with attempts remaining, or the handler is in `step.sleep`
- `waiting` — parked in `step.waitForEvent` until a matching Event arrives or the wait times out (see **Waiting run**)
- `completed` — the handler finished successfully
- `failed` — a Step exhausted its `maxAttempts` or the handler failed; terminal until explicitly retried via `POST /api/runs/:id/retry`
- `cancelled` — explicitly cancelled via `POST /api/runs/:id/cancel`; only `pending`, `retrying` and `waiting` Runs can be cancelled

**Waiting run**
A Run parked by `step.waitForEvent(name, { event, match?, timeout?, onTimeout? })`. Its `waiting_for` column stores the Event name, a `match` filter (dotted `event.data` paths mapped to required values) and the timeout. A dispatched Event that matches resumes the Run; the Event becomes the wait Step's output. On timeout the Step resolves `null`, or fails if `onTimeout: "throw"`. The dashboard's run detail shows what a waiting Run is waiting for.

**Event schema**
An optional validator declared on a `StepperFunction` as `schema`: any object with a `parse(data)` that throws on invalid input (Zod, ArkType, Valibot wrappers, ...). Checked in `dispatchEvent` before anything is persisted; if any matching Function rejects the data, the whole Event is rejected (`POST /api/events` returns `400` with the issues) and no Runs are created. Multiple functions may handle the same event name with different schemas.

**App layer**
A single Effect `Layer` provided to the shared config that satisfies the union of all registered Functions' `R` type requirements. All functions share this layer. `createApp` is generic over `R` — the TypeScript compiler enforces that the provided `layer` satisfies every function's requirements at compile time.

**Shared config**
A plain object `{ functions, layer, storageLayer }` that can be passed to both `createApp` and `createWorker`, avoiding duplication when running them in separate processes. Each entry point accepts additional options specific to it (e.g. `port` for the server, `concurrency` for the worker).

**step.run contract**
`step.run(name, () => Promise<A> | A, opts?)` — the inner function is always a plain async function, never an Effect. Effect services needed between steps are accessed via `yield*` in the handler body outside step boundaries.

**step.sleep**
`step.sleep(name, duration)` — a named, memoized pause. On first execution: records the step as completed, sets the Run's `retry_after = now + duration`, sets status to `"retrying"`, and aborts further handler execution. On subsequent execution: step is already completed; handler continues past it immediately. Sleep steps survive process restarts because the `retry_after` timestamp is persisted.

**Event idempotency**
`POST /api/events` is idempotent on `event.id`. A duplicate `id` returns the original response with no new Runs created, and does not resume `waiting` Runs a second time. This holds even for Events that trigger no Functions. Callers are responsible for generating unique IDs; the server enforces the deduplication contract.

**Dashboard auth**
`STEPPER_DASHBOARD_TOKEN` environment variable. All API calls from the dashboard include it as a bearer token. The server rejects requests without a valid token with `401`. Both the server and dashboard must be started with the same token value.

**Multi-worker safety**
Multiple worker processes may run against the same database. `SELECT ... FOR UPDATE SKIP LOCKED` prevents double-execution of Runs. Startup crash-recovery re-queuing is guarded by a Postgres advisory lock so only one worker re-queues stuck Runs during simultaneous restarts.

**Drain**
Graceful shutdown behaviour on `SIGTERM`: the server stops accepting new events; the worker waits for all currently-executing (`"running"`) Runs to finish before the process exits. Sleeping/retrying Runs are not drained — they resume on the next worker startup. Documented as a deploy constraint: sleeping Runs will be picked up by the new code version.

**Event replay**
Re-sending a stored Event's `name` and `data` under a new `id` (`POST /api/events/:id/replay`, or "Replay event" in the dashboard's events browser). It creates fresh Runs for the current Functions; the original Event and its Runs are untouched.

**Live updates**
The server relays run changes to dashboards over SSE (`GET /api/stream`). Workers `NOTIFY` the `stepper_run_updates` channel (payload: run id) when they claim or finish a Run, and the API does the same on cancel/retry; the server `LISTEN`s and broadcasts `run.updated` messages. The dashboard proxies the stream through its own `/api/stream` route so the bearer token never reaches the browser.

**Event dispatch response**
`POST /api/events` returns `{ id: string, runs: Array<{ runId: string, functionName: string }> }` — the caller receives the IDs of every Run created, enabling programmatic status tracking without a second query.

**Typed client**
`createClient<typeof functions>({ serverUrl })` — infers valid event names and their `data` shapes from a functions array at compile time. A wrong event name or mismatched `data` shape is a compile error.

**Versioning constraint**
Actively executing (`"running"`) Runs are drained before deploy via graceful shutdown. Sleeping/retrying Runs resume on the new handler version — the operator must not change step structure for Functions with in-flight sleeping Runs. On startup the worker logs a warning if any `"retrying"` Runs exist for registered Functions.

**Graceful shutdown**
`createApp` returns `{ app, shutdown: () => Promise<void> }`. Calling `shutdown()` (or receiving SIGTERM) stops event ingestion and waits for all `"running"` Runs to complete before the process exits.

**Test runner**
`createTestRunner(fn, layer)`, imported from the subpath `@integration-stepper/core/testing` so it stays out of production bundles. Executes a Function against `InMemoryStorageLive`, replaying until the Run settles, and returns `{ run, steps }` for assertions. Fails with `NonDeterministicHandlerError` if the handler's Step sequence changes between replay passes.
