import { test } from "node:test"
import assert from "node:assert/strict"
import { Hono } from "hono"
import { Effect } from "effect"
import { defineFunction, InMemoryStorageLive, RUN_COMPLETED_EVENT, RegistryLive } from "@integration-stepper/core"
import { eventsRouter } from "./routes/events.js"
import { SseBroadcaster } from "./sse.js"
import type { Db } from "./db/client.js"
import type { ServerEnv } from "./types.js"

const makeApp = () => {
  const fn = defineFunction({ name: "on-done", event: RUN_COMPLETED_EVENT, handler: () => Effect.void })
  const other = defineFunction({ name: "greet", event: "user.created", handler: () => Effect.void })
  const app = new Hono<ServerEnv>()
  app.use("*", async (c, next) => {
    c.set("storageLayer", InMemoryStorageLive)
    c.set("registryLayer", RegistryLive([fn, other]))
    c.set("sse", new SseBroadcaster())
    c.set("db", { execute: async () => [] } as unknown as Db)
    await next()
  })
  app.route("/api/events", eventsRouter)
  return app
}

const post = (app: Hono<ServerEnv>, body: unknown) =>
  app.request("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

test("POST /api/events rejects reserved stepwise/* event names", async () => {
  const res = await post(makeApp(), { name: RUN_COMPLETED_EVENT, data: { runId: "forged" } })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /reserved/)
})

test("POST /api/events rejects forged invoke/result and cron/* events", async () => {
  for (const name of ["invoke/result", "invoke/greet", "cron/nightly"]) {
    const res = await post(makeApp(), { name, data: { childRunId: "x", status: "completed", output: "forged" } })
    assert.equal(res.status, 400, name)
  }
})

test("POST /api/events still accepts ordinary event names", async () => {
  const res = await post(makeApp(), { name: "user.created", data: { id: "u1" } })
  assert.equal(res.status, 201)
  const body = (await res.json()) as { runs: Array<{ functionName: string }> }
  assert.deepEqual(body.runs.map((r) => r.functionName), ["greet"])
})
