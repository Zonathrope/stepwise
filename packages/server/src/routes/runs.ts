import { Hono, type Context } from "hono"
import { sql } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Storage, RunStatus } from "@integration-stepper/core"
import type { RunRecord, StepRecord } from "@integration-stepper/core"
import type { ServerEnv } from "../types.js"

export const runsRouter = new Hono<ServerEnv>()

runsRouter.get("/", async (c) => {
  const functionName = c.req.query("functionName") ?? c.req.query("integrationName")
  const rawStatus = c.req.query("status")
  const status = rawStatus !== undefined
    ? Option.getOrUndefined(Schema.decodeUnknownOption(RunStatus)(rawStatus))
    : undefined
  const limit = Number(c.req.query("limit") ?? 50)
  const offset = Number(c.req.query("offset") ?? 0)

  const program = Effect.gen(function* () {
    const storage = yield* Storage
    return yield* storage.listRuns({
      ...(functionName !== undefined ? { functionName } : {}),
      ...(status !== undefined ? { status } : {}),
      limit,
      offset,
    })
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to list runs" }, 500)
  }

  return c.json(result.value.map(serializeRun))
})

runsRouter.get("/count", async (c) => {
  const functionName = c.req.query("functionName") ?? c.req.query("integrationName")
  const status = c.req.query("status") as RunStatus | undefined

  const program = Effect.gen(function* () {
    const storage = yield* Storage
    return yield* storage.countRuns({
      ...(functionName !== undefined ? { functionName } : {}),
      ...(status !== undefined ? { status } : {}),
    })
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to count runs" }, 500)
  }

  return c.json({ count: result.value })
})

runsRouter.get("/:id", async (c) => {
  const runId = c.req.param("id")

  const program = Effect.gen(function* () {
    const storage = yield* Storage
    const run = yield* storage.getRun(runId)
    const steps = yield* storage.listSteps(runId)
    return { run, steps }
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to get run" }, 500)
  }

  const { run, steps } = result.value

  if (Option.isNone(run)) {
    return c.json({ error: "Run not found" }, 404)
  }

  return c.json({
    ...serializeRun(run.value),
    steps: steps.map(serializeStep),
  })
})

const cancelOne = (runId: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    // Single atomic conditional UPDATE: avoids the check-then-update race with workers.
    return yield* storage.transitionRun(runId, ["pending", "retrying", "waiting"], { status: "cancelled" })
  })

const retryOne = (runId: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    // Failed is terminal, so resetting the failed steps before the transition is safe;
    // the worker cannot pick the run up until it leaves "failed".
    const current = yield* storage.getRun(runId)
    if (Option.isNone(current) || current.value.status !== "failed") return false
    const steps = yield* storage.listSteps(runId)
    for (const step of steps) {
      if (step.status === "failed") {
        yield* storage.updateStep(step.id, {
          status: "pending",
          attempt: 0,
          error: Option.none(),
        })
      }
    }
    return yield* storage.transitionRun(runId, ["failed"], {
      status: "pending",
      completedAt: Option.none(),
      retryAfter: Option.none(),
      error: Option.none(),
    })
  })

const notifyWorker = async (c: Context<ServerEnv>) => {
  try {
    await c.get("db").execute(sql`SELECT pg_notify('stepper_runs', '')`)
  } catch (err) {
    console.warn("[runs] Failed to NOTIFY stepper_runs:", err)
  }
}

runsRouter.post("/:id/cancel", async (c) => {
  const runId = c.req.param("id")

  const program = Effect.gen(function* () {
    const storage = yield* Storage
    const updated = yield* cancelOne(runId)
    if (updated) return { ok: true } as const
    const run = yield* storage.getRun(runId)
    if (Option.isNone(run)) return { ok: false, notFound: true } as const
    return { ok: false, notFound: false, status: run.value.status } as const
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to cancel run" }, 500)
  }

  const outcome = result.value
  if (outcome.ok) return c.json({ ok: true }, 200)
  if (outcome.notFound) return c.json({ error: "Run not found" }, 404)
  return c.json({ error: `Run cannot be cancelled in status ${outcome.status}` }, 409)
})

runsRouter.post("/:id/retry", async (c) => {
  const runId = c.req.param("id")

  const program = Effect.gen(function* () {
    const storage = yield* Storage
    const updated = yield* retryOne(runId)
    if (updated) return { ok: true } as const
    const run = yield* storage.getRun(runId)
    if (Option.isNone(run)) return { ok: false, notFound: true } as const
    return { ok: false, notFound: false, status: run.value.status } as const
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to retry run" }, 500)
  }

  const outcome = result.value
  if (outcome.ok) {
    await notifyWorker(c)
    return c.json({ ok: true }, 200)
  }
  if (outcome.notFound) return c.json({ error: "Run not found" }, 404)
  return c.json({ error: `Run cannot be retried in status ${outcome.status}` }, 409)
})

const BULK_PAGE = 200

const bulkApply = async (
  c: Context<ServerEnv>,
  fromStatuses: ReadonlyArray<RunStatus>,
  apply: (runId: string) => Effect.Effect<boolean, unknown, Storage>,
) => {
  let body: { filter?: { status?: string; functionName?: string } } = {}
  try {
    body = await c.req.json()
  } catch {
    // empty body is allowed
  }
  const filter = body.filter ?? {}
  let statuses = fromStatuses
  if (filter.status !== undefined) {
    if (!fromStatuses.includes(filter.status as RunStatus)) {
      return c.json({ error: `filter.status must be one of: ${fromStatuses.join(", ")}` }, 400)
    }
    statuses = [filter.status as RunStatus]
  }

  const program = Effect.gen(function* () {
    const storage = yield* Storage
    // Collect ids first: transitioning rows out of fromStatus would shift offset pagination.
    const ids: string[] = []
    for (const status of statuses) {
      for (let offset = 0; ; offset += BULK_PAGE) {
        const page = yield* storage.listRuns({
          status,
          ...(filter.functionName ? { functionName: filter.functionName } : {}),
          limit: BULK_PAGE,
          offset,
        })
        ids.push(...page.map((r) => r.id))
        if (page.length < BULK_PAGE) break
      }
    }
    let affected = 0
    for (const id of ids) {
      if (yield* apply(id)) affected++
    }
    return affected
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("storageLayer"))),
  )
  if (result._tag === "Failure") {
    return c.json({ error: "Bulk operation failed" }, 500)
  }
  return c.json({ affected: result.value }, 200)
}

runsRouter.post("/bulk-cancel", (c) => bulkApply(c, ["pending", "retrying"], cancelOne))

runsRouter.post("/bulk-retry", async (c) => {
  const res = await bulkApply(c, ["failed"], retryOne)
  if (res.status === 200) await notifyWorker(c)
  return res
})

const serializeRun = (run: RunRecord) => ({
  id: run.id,
  functionName: run.functionName,
  eventId: run.eventId,
  status: run.status,
  startedAt: run.startedAt.toISOString(),
  completedAt: Option.getOrNull(run.completedAt)?.toISOString() ?? null,
  retryAfter: Option.getOrNull(run.retryAfter)?.toISOString() ?? null,
  error: Option.getOrNull(run.error),
  waitingFor: Option.match(run.waitingFor, {
    onNone: () => null,
    onSome: (w) => ({
      event: w.event,
      match: w.match ?? null,
      timeoutAt: w.timeoutAt?.toISOString() ?? null,
      onTimeout: w.onTimeout,
    }),
  }),
})

const serializeStep = (step: StepRecord) => ({
  id: step.id,
  runId: step.runId,
  name: step.name,
  status: step.status,
  attempt: step.attempt,
  maxAttempts: step.maxAttempts,
  startedAt: Option.getOrNull(step.startedAt)?.toISOString() ?? null,
  completedAt: Option.getOrNull(step.completedAt)?.toISOString() ?? null,
  output: Option.getOrNull(step.output),
  error: Option.getOrNull(step.error),
})
