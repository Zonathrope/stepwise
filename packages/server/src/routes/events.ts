import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { Effect, Layer, Option } from "effect"
import { dispatchEvent, Registry, Storage } from "@integration-stepper/core"
import { sql } from "drizzle-orm"
import type { ServerEnv } from "../types.js"

export const eventsRouter = new Hono<ServerEnv>()

eventsRouter.post("/", async (c) => {
  const body = await c.req.json<{ id?: string; name: string; data: unknown }>()

  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "event name is required" }, 400)
  }

  const db = c.get("db")
  const storageLayer = c.get("storageLayer")
  const registryLayer = c.get("registryLayer")

  // Build event with caller-supplied id (for idempotency) or generate one
  const eventId = body.id ?? randomUUID()
  const event = {
    id: eventId,
    name: body.name,
    data: body.data ?? {},
    timestamp: new Date(),
  }

  // Check idempotency: if runs already exist for this event id, return existing
  const existingCheck = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const storage = yield* Storage
      return yield* storage.listRuns({ eventId })
    }).pipe(Effect.provide(storageLayer)),
  )

  if (existingCheck._tag === "Success" && existingCheck.value.length > 0) {
    const runs = existingCheck.value.map((r) => ({ runId: r.id, functionName: r.functionName }))
    return c.json({ id: eventId, runs }, 200)
  }

  const program = dispatchEvent(event)

  const result = await Effect.runPromiseExit(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          storageLayer,
          registryLayer,
        ),
      ),
    ),
  )

  if (result._tag === "Failure") {
    console.error("Failed to dispatch event", result.cause)
    return c.json({ error: "Failed to dispatch event" }, 500)
  }

  const runs = result.value // Array<{ runId: string; functionName: string }>

  // NOTIFY the worker so it picks up the new runs immediately
  try {
    await db.execute(sql`SELECT pg_notify('stepper_runs', '')`)
  } catch (err) {
    // Non-fatal — worker will pick up via poll
    console.warn("[events] Failed to NOTIFY stepper_runs:", err)
  }

  c.get("sse").broadcast({ type: "event.dispatched", eventId: event.id, eventName: event.name })

  return c.json({ id: event.id, runs }, 201)
})
