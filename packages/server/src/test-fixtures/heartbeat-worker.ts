// A worker in its own process, so worker-heartbeat.test.ts can kill it like a crashed machine.
import { makeDb } from "../db/client.js"
import { PostgresStorageLive } from "../db/postgres-storage.js"
import { Worker } from "../worker.js"
import { HEARTBEAT_MS, STALE_AFTER_MS, registryFor } from "./heartbeat-fixture.js"

const url = process.env["DATABASE_URL"]!
const workerId = process.env["WORKER_ID"]!
const db = makeDb(url)

const worker = new Worker({
  db,
  storageLayer: PostgresStorageLive(db),
  registryLayer: registryFor(db, workerId),
  workerId,
  heartbeatIntervalMs: HEARTBEAT_MS,
  staleAfterMs: STALE_AFTER_MS,
})

await worker.start()
console.log("ready")
