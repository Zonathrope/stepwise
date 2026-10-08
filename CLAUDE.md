# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all dependencies
pnpm install

# Build all packages (respects dependency order via Turborepo)
pnpm build

# Run all packages in dev/watch mode
pnpm dev

# Type-check all packages
pnpm typecheck

# Run a single package's command
pnpm --filter @integration-stepper/core build
pnpm --filter @integration-stepper/server dev
pnpm --filter @integration-stepper/dashboard dev
```

### Database (server package)

```bash
# Run migrations manually
psql $DATABASE_URL -f packages/server/src/db/migrations/0000_initial.sql

# Generate new migrations after schema changes
cd packages/server && pnpm drizzle-kit generate

# Push schema directly to DB (dev only)
cd packages/server && pnpm drizzle-kit push
```

### Running the stack locally

```bash
# 1. Start the agent server (requires DATABASE_URL env var)
DATABASE_URL=postgres://... pnpm --filter @integration-stepper/server dev

# 2. Start the dashboard
NEXT_PUBLIC_SERVER_URL=http://localhost:4000 pnpm --filter @integration-stepper/dashboard dev
```

## Architecture

This is a **pnpm monorepo** managed by **Turborepo** with four packages:

```
packages/
  core/       # Effect-ts runtime (no HTTP, no DB) — the domain model
  server/     # Hono HTTP agent server + Drizzle/Postgres storage
  client/     # Thin HTTP SDK used by downstream apps to send events
  dashboard/  # Next.js 15 App Router dashboard
```

### packages/core

The domain model and execution engine. No I/O happens here — storage is injected via Effect `Layer`.

Key files:
- `schema.ts` — `RunRecord` (with `functionName`, `retryAfter`), `StepRecord`, `EventPayload`, `RunStatus` (includes `"retrying"`), `StepStatus`
- `errors.ts` — `StepError`, `StorageError`, `FunctionNotFoundError`, `StepperPark` (sentinel)
- `storage.ts` — `Storage` service interface + `InMemoryStorageLive`; `listRuns` accepts `eligibleForPickup` flag
- `function.ts` — `defineFunction()` factory; `StepperFunction<TData, TError, R>` type
- `registry.ts` — `Registry` maps event names → matching functions
- `step-context.ts` — `StepContext`; `step.run(name, fn, opts?)` and `step.sleep(name, duration)`; `step.waitForEvent(name, {event, match?, timeout?, onTimeout?})`
- `executor.ts` — `dispatchEvent()` creates pending runs and returns `Array<{runId, functionName}>`; `executeRun()` drives a single run
- `testing.ts` (subpath `@integration-stepper/core/testing`) — `createTestRunner(fn, layer)` for unit tests

**Memoised replay model**: on each pickup, the handler re-executes from the top. Completed steps return their stored output immediately. When a new step completes for the first time, `step.run` throws `StepperPark` to abort the handler — the run goes back to `"pending"` for the next pickup to continue from where it left off. **Handlers must be deterministic** (same step sequence on every execution).

**`StepperPark`** is a sentinel error (`_tag: "StepperPark"`) caught by `executeRun`. It is not a real failure — it signals either "step just completed, park the run" or "sleep, set retryAfter". `executeRun.catchAll` distinguishes it from real errors by tag.

**`step.waitForEvent`**: parks the run as `"waiting"` with a persisted `waitingFor` filter (`match` = dotted `event.data` paths -> required values; serialisable, not a predicate). `dispatchEvent` resumes matching waiting runs via `storage.resumeWaitingRun` (atomic; the event becomes the step output). `timeout` is stored in `retryAfter`; a waiting run is pickup-eligible only once it elapses, then the step resolves `null` (or fails with `StepError` if `onTimeout: "throw"`). Migration `0001_wait_for_event.sql`. Tests: `pnpm --filter @integration-stepper/core test`.

**Step retry**: `step.run(name, fn, { maxAttempts: 3 })` — on fn() failure, the step is marked `"failed"` (or left `"running"` if attempts remain), and either `StepperPark` re-queues the run or `StepError` terminally fails it.

### packages/server

Hono app wired to Postgres via Drizzle, plus the async worker.

- `db/schema.ts` — Drizzle table definitions; `runs` has `retry_after` column and `"retrying"` status
- `db/postgres-storage.ts` — `Storage` implementation; `listRuns` with `eligibleForPickup` uses `FOR UPDATE SKIP LOCKED`-friendly filter
- `db/migrations/0000_initial.sql` — apply once with `psql $DATABASE_URL -f ...`
- `app.ts` — `createApp<R>(opts)` returns `{ app, shutdown }`; auth middleware reads `STEPPER_DASHBOARD_TOKEN`; starts `Worker` internally unless `worker: false`
- `worker.ts` — `Worker` class: LISTEN/NOTIFY on `"stepper_runs"` + 5s poll fallback; advisory lock for crash recovery on startup; per-function concurrency tracking
- `worker-factory.ts` — `createWorker(config)` for running the worker in a separate process
- `sse.ts` — `SseBroadcaster` fan-out
- `bin.ts` — standalone entry; wires SIGTERM/SIGINT to `shutdown()`

HTTP API:
- `POST /api/events` — idempotent (duplicate `id` returns `200`); returns `{ id, runs: [{runId, functionName}] }`; fires `NOTIFY stepper_runs`
- `GET /api/runs` — filterable by `functionName`, `status`, `limit`, `offset`
- `GET /api/runs/:id` — run detail with step list; includes `retryAfter`
- `POST /api/runs/:id/cancel` — cancels `pending`/`retrying`/`waiting` runs; `409` if already running/completed/failed
- `GET /api/integrations` — lists registered functions
- `GET /api/stream` — SSE for live updates
- `GET /health`

All `/api/*` routes require `Authorization: Bearer <token>` when `STEPPER_DASHBOARD_TOKEN` env var is set.

### packages/client

`createClient<const Fns>(functions, { serverUrl })` — typed factory; infers valid event names and `data` shapes from the functions array at compile time via `InferEventMap<Fns>`. Zero runtime deps — types only depend on `@integration-stepper/core` as a devDependency.

### packages/dashboard

Next.js 15 App Router, all pages are React Server Components (fetch from server at request time, `cache: "no-store"`).

Routes:
- `/` — overview: status counts + recent runs + integrations list
- `/runs` — filterable run list (status filter via query params)
- `/runs/[id]` — run detail with step timeline, duration, output/error per step
- `/integrations` — list of registered integrations

`src/lib/api.ts` — typed fetch wrappers for all server endpoints.  
`src/lib/use-sse.ts` — `useSse(onMessage)` hook for client components that want live updates.

### Effect-ts patterns used

- All service dependencies (`Storage`, `Registry`) are resolved via `Effect.provide(Layer)` at the HTTP handler boundary in `packages/server`.
- The core executor is pure Effect code; it never calls `Effect.runPromise` — that happens in route handlers.
- Storage errors surface as typed `StorageError` values, not thrown exceptions.
- `Option.none()` / `Option.some()` are used for nullable DB columns (`completedAt`, `error`, `output`).
