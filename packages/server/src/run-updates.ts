import { sql } from "drizzle-orm"
import postgres from "postgres"
import type { Db } from "./db/client.js"
import type { SseBroadcaster } from "./sse.js"

/**
 * Postgres channel carrying "a run changed" notifications (payload: run id, or "" for bulk
 * changes). Workers may run in other processes, so the server relays this channel to SSE
 * clients instead of relying on in-process callbacks.
 */
export const RUN_UPDATES_CHANNEL = "stepper_run_updates"

export const notifyRunUpdate = async (db: Db, runId = ""): Promise<void> => {
  try {
    await db.execute(sql`SELECT pg_notify(${RUN_UPDATES_CHANNEL}, ${runId})`)
  } catch (err) {
    // Non-fatal: dashboards just miss a live refresh
    console.warn("[run-updates] Failed to NOTIFY:", err)
  }
}

/** LISTEN on the run-updates channel and broadcast `run.updated` SSE messages. Returns a stop fn. */
export const relayRunUpdates = async (sse: SseBroadcaster): Promise<() => Promise<void>> => {
  const connectionString = process.env["DATABASE_URL"]
  if (!connectionString) {
    console.warn("[run-updates] DATABASE_URL not set; live run updates over SSE are disabled")
    return async () => {}
  }
  const listenSql = postgres(connectionString)
  try {
    await listenSql.listen(RUN_UPDATES_CHANNEL, (payload) => {
      sse.broadcast({ type: "run.updated", runId: payload || null })
    })
  } catch (err) {
    console.error("[run-updates] Failed to LISTEN:", err)
    await listenSql.end().catch(() => {})
    return async () => {}
  }
  return async () => {
    await listenSql.end().catch(() => {})
  }
}
