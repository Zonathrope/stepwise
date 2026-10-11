import { randomUUID } from "node:crypto"
import { Hono, type Context } from "hono"
import { Cause, Effect, Layer, Option } from "effect"
import { dispatchEvent, Storage, ValidationError, type EventPayload } from "@integration-stepper/core"
import { sql } from "drizzle-orm"
import type { ServerEnv } from "../types.js"
import { serializeRun } from "./runs.js"

export const eventsRouter = new Hono<ServerEnv>()

const serializeEvent = (event: EventPayload) => ({
  id: event.id,
  name: event.name,
  data: event.data,
  timestamp: event.timestamp.toISOString(),
})

/** Dispatch `event`, notify the worker and SSE clients, and build the HTTP response. */
const dispatchAndRespond = async (c: Context<ServerEnv>, event: EventPayload, extra: Record<string, unknown> = {}) => {
  const result = await Effect.runPromiseExit(
    dispatchEvent(event).pipe(
      Effect.provide(Layer.mergeAll(c.get("storageLayer"), c.get("registryLayer"))),
    ),
  )

  if (result._tag === "Failure") {
    const failure = Cause.failureOption(result.cause)
    if (Option.isSome(failure) && failure.value instanceof ValidationError) {
      const e = failure.value
      return c.json(
        { error: "Validation failed", function: e.functionName, message: e.message, issues: e.issues },
        400,
      )
    }
    console.error("Failed to dispatch event", result.cause)
    return c.json({ error: "Failed to dispatch event" }, 500)
  }

  const runs = result.value // Array<{ runId: string; functionName: string }>

  // NOTIFY the worker so it picks up the new runs immediately
  try {
    await c.get("db").execute(sql`SELECT pg_notify('stepper_runs', '')`)
  } catch (err) {
    // Non-fatal — worker will pick up via poll
    console.warn("[events] Failed to NOTIFY stepper_runs:", err)
  }

  c.get("sse").broadcast({
    type: "event.dispatched",
    eventId: event.id,
    eventName: event.name,
    runIds: runs.map((r) => r.runId),
  })

  return c.json({ id: event.id, ...extra, runs }, 201)
}

eventsRouter.post("/", async (c) => {
  const body = await c.req.json<{ id?: string; name: string; data: unknown }>()

  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "event name is required" }, 400)
  }

  // Build event with caller-supplied id (for idempotency) or generate one
  const eventId = body.id ?? randomUUID()

  // Check idempotency: if runs already exist for this event id, return existing
  const existingCheck = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const storage = yield* Storage
      return yield* storage.listRuns({ eventId })
    }).pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (existingCheck._tag === "Success" && existingCheck.value.length > 0) {
    const runs = existingCheck.value.map((r) => ({ runId: r.id, functionName: r.functionName }))
    return c.json({ id: eventId, runs }, 200)
  }

  return dispatchAndRespond(c, {
    id: eventId,
    name: body.name,
    data: body.data ?? {},
    timestamp: new Date(),
  })
})

eventsRouter.get("/", async (c) => {
  const name = c.req.query("name")
  const limit = Number(c.req.query("limit") ?? 50)
  const offset = Number(c.req.query("offset") ?? 0)

  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const storage = yield* Storage
      const events = yield* storage.listEvents({ ...(name ? { name } : {}), limit, offset })
      return yield* Effect.forEach(
        events,
        (event) =>
          storage.countRuns({ eventId: event.id }).pipe(
            Effect.map((runCount) => ({ ...serializeEvent(event), runCount })),
          ),
        { concurrency: 10 },
      )
    }).pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to list events" }, 500)
  }
  return c.json(result.value)
})

eventsRouter.get("/:id", async (c) => {
  const eventId = c.req.param("id")
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const storage = yield* Storage
      const event = yield* storage.getEvent(eventId)
      const runs = yield* storage.listRuns({ eventId })
      return { event, runs }
    }).pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to get event" }, 500)
  }
  if (Option.isNone(result.value.event)) {
    return c.json({ error: "Event not found" }, 404)
  }
  return c.json({
    ...serializeEvent(result.value.event.value),
    runs: result.value.runs.map(serializeRun),
  })
})

/** Re-send a stored event's name and data under a new id, creating fresh runs. */
eventsRouter.post("/:id/replay", async (c) => {
  const eventId = c.req.param("id")
  const original = await Effect.runPromiseExit(
    Effect.flatMap(Storage, (s) => s.getEvent(eventId)).pipe(Effect.provide(c.get("storageLayer"))),
  )

  if (original._tag === "Failure") {
    return c.json({ error: "Failed to load event" }, 500)
  }
  if (Option.isNone(original.value)) {
    return c.json({ error: "Event not found" }, 404)
  }

  const { name, data } = original.value.value
  return dispatchAndRespond(
    c,
    { id: randomUUID(), name, data, timestamp: new Date() },
    { replayOf: eventId },
  )
})
