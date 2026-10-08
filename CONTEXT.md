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
The process or loop that dequeues pending Runs and executes them by invoking the Function handler with a StepContext. Notified of new work via Postgres `LISTEN/NOTIFY` on a dedicated channel; also polls periodically as a safety net.

**Retry backoff**
The delay before a failed Run is re-queued. Configurable per Function via a `retryDelay` schedule; falls back to exponential backoff with jitter (`min(30, 2^attempt)` seconds ± jitter). Once a Step exhausts its `maxAttempts`, the Run is permanently `failed` and never re-queued.

**Determinism constraint**
A Function handler must execute the same Steps in the same order on every attempt of a Run. Step outputs are memoized by call order; if the handler branches differently on a retry, the wrong memoized output will be fed to the wrong Step. This constraint is documented, not enforced at runtime.

**StepperFunction**
The canonical TypeScript type name for a defined Function (avoids collision with the JS built-in `Function`). Created via `defineFunction()`. Parameterised as `StepperFunction<TData, TError, TRequirements>` where `TRequirements` is the Effect service layer the handler needs.

**Worker**
Runs in the same process as the Hono server by default (`createApp({ worker: true })`). Can be separated via `createWorker()` for independent deployment. Executes up to `concurrency` (default 10) Runs simultaneously. On startup, re-queues all Runs in `"running"` state (crash recovery).

**retry_after**
A nullable timestamp column on `runs`. A Run with `status = "pending"` or `"retrying"` and a future `retry_after` is not eligible for pickup until that time passes. Set on re-queue according to the Function's `retryDelay` schedule, defaulting to exponential backoff with jitter.

**Run statuses**
- `pending` — queued for first attempt, never executed
- `running` — currently being executed by a worker
- `retrying` — failed at least once; waiting for `retry_after` before next attempt
- `completed` — all steps finished successfully
- `failed` — a Step exhausted its `maxAttempts`; terminal, never re-queued
- `cancelled` — explicitly cancelled via `POST /api/runs/:id/cancel`; only `pending` and `retrying` runs can be cancelled

**Event schema**
An optional Effect `Schema` declared on a `StepperFunction` for its event's `data` payload. Validated server-side before a Run is created; events that fail validation for a given function are silently skipped for that function (logged), not rejected globally. Multiple functions may handle the same event name with different schemas.

**App layer**
A single Effect `Layer` provided to the shared config that satisfies the union of all registered Functions' `R` type requirements. All functions share this layer. `createApp` is generic over `R` — the TypeScript compiler enforces that the provided `layer` satisfies every function's requirements at compile time.

**Shared config**
A plain object `{ functions, layer, storageLayer }` that can be passed to both `createApp` and `createWorker`, avoiding duplication when running them in separate processes. Each entry point accepts additional options specific to it (e.g. `port` for the server, `concurrency` for the worker).

**step.run contract**
`step.run(name, () => Promise<A> | A, opts?)` — the inner function is always a plain async function, never an Effect. Effect services needed between steps are accessed via `yield*` in the handler body outside step boundaries.

**step.sleep**
`step.sleep(name, duration)` — a named, memoized pause. On first execution: records the step as completed, sets the Run's `retry_after = now + duration`, sets status to `"retrying"`, and aborts further handler execution. On subsequent execution: step is already completed; handler continues past it immediately. Sleep steps survive process restarts because the `retry_after` timestamp is persisted.

**Event idempotency**
`POST /api/events` is idempotent on `event.id`. A duplicate `id` returns the original response with no new Runs created. Callers are responsible for generating unique IDs; the server enforces the deduplication contract.

**Dashboard auth**
`STEPPER_DASHBOARD_TOKEN` environment variable. All API calls from the dashboard include it as a bearer token. The server rejects requests without a valid token with `401`. Both the server and dashboard must be started with the same token value.

**Multi-worker safety**
Multiple worker processes may run against the same database. `SELECT ... FOR UPDATE SKIP LOCKED` prevents double-execution of Runs. Startup crash-recovery re-queuing is guarded by a Postgres advisory lock so only one worker re-queues stuck Runs during simultaneous restarts.

**Drain**
Graceful shutdown behaviour on `SIGTERM`: the server stops accepting new events; the worker waits for all currently-executing (`"running"`) Runs to finish before the process exits. Sleeping/retrying Runs are not drained — they resume on the next worker startup. Documented as a deploy constraint: sleeping Runs will be picked up by the new code version.

**Event dispatch response**
`POST /api/events` returns `{ id: string, runs: Array<{ runId: string, functionName: string }> }` — the caller receives the IDs of every Run created, enabling programmatic status tracking without a second query.

**Test runner**
`createTestRunner(fn: StepperFunction)` — a test helper that executes a Function against `InMemoryStorageLive` and returns `{ run, steps }` for assertions. Lives in `@integration-stepper/core` as a subpath export `@integration-stepper/core/testing`.

**Typed client**
`createClient<typeof functions>({ serverUrl })` — infers valid event names and their `data` shapes from a functions array at compile time. A wrong event name or mismatched `data` shape is a compile error.

**Versioning constraint**
Actively executing (`"running"`) Runs are drained before deploy via graceful shutdown. Sleeping/retrying Runs resume on the new handler version — the operator must not change step structure for Functions with in-flight sleeping Runs. On startup the worker logs a warning if any `"retrying"` Runs exist for registered Functions.

**Graceful shutdown**
`createApp` returns `{ app, shutdown: () => Promise<void> }`. Calling `shutdown()` (or receiving SIGTERM) stops event ingestion and waits for all `"running"` Runs to complete before the process exits.

**Test runner**
`import { createTestRunner } from "@integration-stepper/core/testing"`. Executes a Function against `InMemoryStorageLive` and returns `{ run, steps }` for assertions. Not included in production bundles via subpath export.
