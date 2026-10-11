// Shared by worker-heartbeat.test.ts and the worker process it spawns (heartbeat-worker.ts).
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { defineFunction, RegistryLive } from "@integration-stepper/core"
import type { Db } from "../db/client.js"

export const HEARTBEAT_MS = 300
export const STALE_AFTER_MS = 1_500
/** Longer than STALE_AFTER_MS: without heartbeats, a live worker's runs would look orphaned. */
export const WORK_MS = 2_500

/** One step that records which worker executed it, then works for WORK_MS. */
export const longFunction = (db: Db, workerId: string) =>
  defineFunction<{ n: number }>({
    name: "hb-long",
    event: "hb.go",
    handler: (event, step) =>
      step.run("work", async () => {
        await db.execute(sql`INSERT INTO hb_exec (n, worker) VALUES (${event.data.n}, ${workerId})`)
        await new Promise((r) => setTimeout(r, WORK_MS))
        return event.data.n
      }),
  })

export const registryFor = (db: Db, workerId: string) => RegistryLive([longFunction(db, workerId)])

export const runEffect = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff)
