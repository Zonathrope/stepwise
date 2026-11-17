// Integration test against a real Postgres: skipped unless DATABASE_URL is set (migrations applied).
// Drives the whole path: HTTP event -> worker -> run completes/fails -> stepwise/run.* event ->
// notifier function runs -> client.waitForRun resolves via the SSE stream.
import { test } from "node:test"
import * as assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { Layer } from "effect"
import { sql } from "drizzle-orm"
import {
  defineFunction,
  RUN_COMPLETED_EVENT,
  RUN_FAILED_EVENT,
  type RunCompletedEventData,
  type RunFailedEventData,
} from "@integration-stepper/core"
import { createClient } from "@integration-stepper/client"
import { makeDb } from "./db/client.js"
import { PostgresStorageLive } from "./db/postgres-storage.js"
import { createApp } from "./app.js"

const url = process.env["DATABASE_URL"]
const skip = url ? false : "DATABASE_URL not set"

test("lifecycle events reach notifier functions and waitForRun resolves", { skip, timeout: 30_000 }, async () => {
  const db = makeDb(url!)
  const fnNames = ["lc-double", "lc-broken", "lc-notify-completed", "lc-notify-failed"]
  for (const name of fnNames) {
    await db.execute(sql`DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE integration_name = ${name})`)
    await db.execute(sql`DELETE FROM runs WHERE integration_name = ${name}`)
  }

  const notified: Array<RunCompletedEventData | RunFailedEventData> = []
  const double = defineFunction<{ n: number }>({
    name: "lc-double",
    event: "lc.num",
    handler: (event, step) => step.run("double", () => ({ doubled: event.data.n * 2 })),
  })
  const broken = defineFunction({
    name: "lc-broken",
    event: "lc.boom",
    handler: (_e, step) => step.run("explode", () => { throw new Error("nope") }, { maxAttempts: 1 }),
  })
  const notifyCompleted = defineFunction<RunCompletedEventData>({
    name: "lc-notify-completed",
    event: RUN_COMPLETED_EVENT,
    handler: (event, step) => step.run("send", () => void notified.push(event.data)),
  })
  const notifyFailed = defineFunction<RunFailedEventData>({
    name: "lc-notify-failed",
    event: RUN_FAILED_EVENT,
    handler: (event, step) => step.run("send", () => void notified.push(event.data)),
  })

  const { app, shutdown } = createApp({
    db,
    storageLayer: PostgresStorageLive(db),
    functions: [double, broken, notifyCompleted, notifyFailed],
    layer: Layer.empty,
  })
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise<void>((r) => server.once("listening", () => r()))
  const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = createClient([double, broken], { serverUrl })

  try {
    const ok = await client.send("lc.num", { n: 21 })
    const okResult = await client.waitForRun(ok.runs[0]!.runId, { timeoutMs: 10_000 })
    assert.deepEqual(okResult, { status: "completed", output: { doubled: 42 }, error: null })

    const bad = await client.send("lc.boom", {})
    const badResult = await client.waitForRun(bad.runs[0]!.runId, { timeoutMs: 10_000 })
    assert.equal(badResult.status, "failed")
    assert.match(badResult.error ?? "", /explode#0/)

    // Notifier runs are created by the worker; wait for both to finish
    const deadline = Date.now() + 10_000
    while (notified.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const byFn = Object.fromEntries(notified.map((d) => [d.functionName, d]))
    assert.deepEqual(byFn["lc-double"], {
      runId: ok.runs[0]!.runId,
      functionName: "lc-double",
      eventId: ok.id,
      output: { doubled: 42 },
    })
    assert.equal((byFn["lc-broken"] as RunFailedEventData).error, badResult.error)
    // No loop: the notifiers' own completions emitted nothing
    assert.equal(notified.length, 2)

    // Clients can't forge lifecycle events
    const forged = await fetch(`${serverUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: RUN_COMPLETED_EVENT, data: {} }),
    })
    assert.equal(forged.status, 400)
  } finally {
    await shutdown()
    await new Promise<void>((r) => server.close(() => r()))
    await db.$client.end()
  }
})
