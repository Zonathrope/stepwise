import { Hono } from "hono"
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

runsRouter.post("/:id/cancel", async (c) => {
  const runId = c.req.param("id")

  const program = Effect.gen(function* () {
    const storage = yield* Storage
    const runOption = yield* storage.getRun(runId)
    if (Option.isNone(runOption)) {
      return { ok: false, notFound: true } as const
    }
    const run = runOption.value
    if (run.status !== "pending" && run.status !== "retrying") {
      return { ok: false, notFound: false, status: run.status } as const
    }
    yield* storage.updateRun(runId, { status: "cancelled" })
    return { ok: true } as const
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to cancel run" }, 500)
  }

  const outcome = result.value

  if ("notFound" in outcome && outcome.notFound) {
    return c.json({ error: "Run not found" }, 404)
  }

  if (!outcome.ok) {
    const status = (outcome as { ok: false; notFound: false; status: string }).status
    return c.json({ error: `Run cannot be cancelled in status ${status}` }, 409)
  }

  return c.json({ ok: true }, 200)
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
