import { test } from "node:test"
import assert from "node:assert/strict"
import { Hono } from "hono"
import { Effect, Layer, Option } from "effect"
import {
  defineFunction,
  dispatchEvent,
  InMemoryStorageLive,
  lifecycleEventId,
  RUN_CANCELLED_EVENT,
  Registry,
  RegistryLive,
  Storage,
  type RunCancelledEventData,
} from "@integration-stepper/core"
import { runsRouter } from "./routes/runs.js"
import { SseBroadcaster } from "./sse.js"
import type { Db } from "./db/client.js"
import type { ServerEnv } from "./types.js"

const setup = (listen: boolean) => {
  const work = defineFunction({ name: "work", event: "work", handler: () => Effect.void })
  const onCancelled = defineFunction({ name: "on-cancelled", event: RUN_CANCELLED_EVENT, handler: () => Effect.void })
  // One store shared by every request
  const storageLayer = Layer.succeed(Storage, Effect.runSync(Effect.provide(Storage, InMemoryStorageLive)))
  const registryLayer = RegistryLive(listen ? [work, onCancelled] : [work])
  const app = new Hono<ServerEnv>()
  app.use("*", async (c, next) => {
    c.set("storageLayer", storageLayer)
    c.set("registryLayer", registryLayer)
    c.set("sse", new SseBroadcaster())
    c.set("db", { execute: async () => [] } as unknown as Db)
    await next()
  })
  app.route("/api/runs", runsRouter)
  const run = <A, E>(eff: Effect.Effect<A, E, Storage | Registry>) =>
    Effect.runPromise(eff.pipe(Effect.provide(Layer.merge(storageLayer, registryLayer))))
  return { app, run }
}

test("cancelling a run dispatches stepwise/run.cancelled to listeners", async () => {
  const { app, run } = setup(true)
  const [created] = await run(dispatchEvent({ id: "evt-1", name: "work", data: {}, timestamp: new Date() }))
  const res = await app.request(`/api/runs/${created!.runId}/cancel`, { method: "POST" })
  assert.equal(res.status, 200)

  const { cancelled, listenerRuns, event } = await run(
    Effect.gen(function* () {
      const storage = yield* Storage
      const cancelled = Option.getOrThrow(yield* storage.getRun(created!.runId))
      const listenerRuns = yield* storage.listRuns({ functionName: "on-cancelled" })
      const event = Option.getOrThrow(
        yield* storage.getEvent(lifecycleEventId(cancelled.id, "cancelled", Option.getOrThrow(cancelled.completedAt))),
      )
      return { cancelled, listenerRuns, event }
    }),
  )
  assert.equal(cancelled.status, "cancelled")
  assert.equal(listenerRuns.length, 1)
  assert.equal(event.name, RUN_CANCELLED_EVENT)
  assert.deepEqual(event.data, { runId: cancelled.id, functionName: "work", eventId: "evt-1" } satisfies RunCancelledEventData)
})

test("bulk cancel emits one event per cancelled run, and nothing without listeners", async () => {
  for (const listen of [true, false]) {
    const { app, run } = setup(listen)
    for (const id of ["a", "b"]) await run(dispatchEvent({ id, name: "work", data: {}, timestamp: new Date() }))
    const res = await app.request("/api/runs/bulk-cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { functionName: "work" } }),
    })
    assert.deepEqual(await res.json(), { affected: 2 })
    const events = await run(Effect.flatMap(Storage, (s) => s.listEvents({ name: RUN_CANCELLED_EVENT })))
    assert.equal(events.length, listen ? 2 : 0)
  }
})
