// Integration test against a real Postgres: skipped unless DATABASE_URL is set (migrations applied).
import { test } from "node:test"
import * as assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { dispatchEvent } from "@integration-stepper/core"
import { makeDb } from "./db/client.js"
import { PostgresStorageLive } from "./db/postgres-storage.js"
import { Worker } from "./worker.js"
import { HEARTBEAT_MS, STALE_AFTER_MS, WORK_MS, registryFor } from "./test-fixtures/heartbeat-fixture.js"

const url = process.env["DATABASE_URL"]
const skip = url ? false : "DATABASE_URL not set"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("worker heartbeats survive a rolling restart and recover a crashed worker", { skip, timeout: 60_000 }, async () => {
  const dbs: ReturnType<typeof makeDb>[] = []
  const newDb = () => {
    const d = makeDb(url!)
    dbs.push(d)
    return d
  }
  const db = newDb()
  const q = <T>(query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>
  await q(sql`CREATE TABLE IF NOT EXISTS hb_exec (n int NOT NULL, worker text NOT NULL, at timestamptz NOT NULL DEFAULT now())`)
  await q(sql`TRUNCATE hb_exec`)
  await q(sql`DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE integration_name = 'hb-long')`)
  await q(sql`DELETE FROM runs WHERE integration_name = 'hb-long'`)

  const layer = Layer.merge(PostgresStorageLive(db), registryFor(db, "dispatcher"))
  const send = (n: number) =>
    Effect.runPromise(
      dispatchEvent({ id: crypto.randomUUID(), name: "hb.go", data: { n }, timestamp: new Date() }).pipe(Effect.provide(layer)),
    )

  const children: ChildProcess[] = []
  const spawnWorker = (workerId: string) =>
    new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./test-fixtures/heartbeat-worker.ts", import.meta.url))],
        { env: { ...process.env, WORKER_ID: workerId }, stdio: ["ignore", "pipe", "inherit"] },
      )
      children.push(child)
      child.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("ready")) resolve(child) })
      child.on("error", reject)
    })
  const runningBy = async (worker: string) =>
    (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM runs WHERE integration_name = 'hb-long' AND status = 'running' AND claimed_by = ${worker}`))[0]!.n
  const waitFor = async (cond: () => Promise<boolean>, ms: number, what: string) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await cond()) return
      await sleep(50)
    }
    assert.fail(`timed out waiting for ${what}`)
  }
  const executions = async () =>
    q<{ n: number; worker: string; count: number }>(
      sql`SELECT n, worker, count(*)::int AS count FROM hb_exec GROUP BY n, worker ORDER BY n, worker`,
    )

  let b: Worker | null = null
  try {
    // --- Rolling restart: B starts (and runs crash recovery) while A is mid-execution
    for (const n of [1, 2, 3]) await send(n)
    await spawnWorker("A")
    await waitFor(async () => (await runningBy("A")) === 3, 10_000, "A to claim 3 runs")

    b = new Worker({
      db: newDb(),
      storageLayer: PostgresStorageLive(newDb()),
      registryLayer: registryFor(db, "B"),
      workerId: "B",
      heartbeatIntervalMs: HEARTBEAT_MS,
      staleAfterMs: STALE_AFTER_MS,
    })
    await b.start()
    // Past the stale threshold: A's heartbeats must keep its runs from being reaped
    await sleep(STALE_AFTER_MS + 2 * HEARTBEAT_MS)
    assert.equal(await runningBy("A"), 3, "B must not re-queue runs A is still executing")

    await waitFor(
      async () =>
        (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM runs WHERE integration_name = 'hb-long' AND status = 'completed'`))[0]!.n === 3,
      WORK_MS + 10_000,
      "the 3 runs to complete",
    )
    assert.deepEqual(
      (await executions()).map((e) => [e.n, e.worker, e.count]),
      [[1, "A", 1], [2, "A", 1], [3, "A", 1]],
      "each run executed exactly once, by A",
    )

    // --- Crash: A2 claims two runs and is killed; B re-queues them once they go stale
    await q(sql`TRUNCATE hb_exec`)
    const a2 = await spawnWorker("A2")
    // B is idle and would also pick these up; hold it off by claiming through A2 first
    await b.shutdown()
    b = null
    for (const n of [10, 11]) await send(n)
    await q(sql`SELECT pg_notify('stepper_runs', '')`)
    await waitFor(async () => (await runningBy("A2")) === 2, 10_000, "A2 to claim 2 runs")
    a2.kill("SIGKILL")

    b = new Worker({
      db: newDb(),
      storageLayer: PostgresStorageLive(newDb()),
      registryLayer: registryFor(db, "B"),
      workerId: "B",
      heartbeatIntervalMs: HEARTBEAT_MS,
      staleAfterMs: STALE_AFTER_MS,
    })
    await b.start()
    const killedAt = Date.now()
    await waitFor(
      async () =>
        (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM runs WHERE integration_name = 'hb-long' AND status = 'completed' AND claimed_by = 'B'`))[0]!.n === 2,
      STALE_AFTER_MS + WORK_MS + 15_000,
      "B to recover and complete A2's runs",
    )
    const recoveredAfter = Date.now() - killedAt
    const execs = await executions()
    assert.deepEqual(
      execs.map((e) => [e.n, e.worker, e.count]),
      [[10, "A2", 1], [10, "B", 1], [11, "A2", 1], [11, "B", 1]],
      "A2 started each run once before dying; B re-ran each once",
    )
    console.log(`[heartbeat test] crashed worker's runs recovered and completed ${recoveredAfter}ms after the kill`)
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL")
    if (b) await b.shutdown()
    // Close pooled connections so the test process can exit
    await Promise.all(dbs.map((d) => (d as unknown as { $client: { end: () => Promise<void> } }).$client.end()))
  }
})
