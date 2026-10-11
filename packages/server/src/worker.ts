import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { Effect, Layer } from "effect"
import { executeRun, Registry, Storage } from "@integration-stepper/core"
import { sql, inArray } from "drizzle-orm"
import * as schema from "./db/schema.js"
import type { Db } from "./db/client.js"
import postgres from "postgres"

const NOTIFY_CHANNEL = "stepper_runs"
const POLL_INTERVAL_MS = 5000

/** How often a worker refreshes `heartbeat_at` on the runs it is executing. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
/**
 * A running run whose heartbeat is older than this is presumed orphaned (its worker crashed or
 * hung) and re-queued. Must comfortably exceed the heartbeat interval plus DB latency.
 */
export const DEFAULT_STALE_AFTER_MS = 60_000

/** Default max concurrent runs per worker when `concurrency` is omitted. */
export const DEFAULT_CONCURRENCY = 5

export interface WorkerOptions {
  db: Db
  storageLayer: Layer.Layer<Storage>
  registryLayer: Layer.Layer<Registry>
  concurrency?: number
  /** Identifies this worker in `runs.claimed_by`. Defaults to `<hostname>:<pid>:<random>`. */
  workerId?: string
  heartbeatIntervalMs?: number
  staleAfterMs?: number
}

export class Worker {
  private readonly db: Db
  private readonly storageLayer: Layer.Layer<Storage>
  private readonly registryLayer: Layer.Layer<Registry>
  private readonly concurrency: number
  readonly workerId: string
  private readonly heartbeatIntervalMs: number
  private readonly staleAfterMs: number
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  private shuttingDown = false
  private inFlightCount = 0
  private readonly inFlightPerFunction = new Map<string, number>()
  private shutdownResolve: (() => void) | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private listenSql: ReturnType<typeof postgres> | null = null

  constructor(opts: WorkerOptions) {
    this.db = opts.db
    this.storageLayer = opts.storageLayer
    this.registryLayer = opts.registryLayer
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  async start(): Promise<void> {
    await this.reapOrphanedRuns()
    // Heartbeat and reap on the same cadence: a live worker keeps its runs fresh, and any
    // worker re-queues runs whose owner stopped heartbeating.
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().then(() => this.reapOrphanedRuns())
    }, this.heartbeatIntervalMs)
    await this.warnRetryingRuns()
    await this.setupListen()
    this.schedulePoll()
    await this.pickupCycle()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true

    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }

    if (this.listenSql !== null) {
      try {
        await this.listenSql.end()
      } catch {
        // ignore
      }
      this.listenSql = null
    }

    // Keep heartbeating while in-flight runs drain, so nobody re-queues them meanwhile
    if (this.inFlightCount > 0) {
      await new Promise<void>((resolve) => {
        this.shutdownResolve = resolve
      })
    }

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  triggerPickup(): void {
    if (!this.shuttingDown) {
      setImmediate(() => { void this.pickupCycle() })
    }
  }

  /** Refresh the lease on every run this worker is executing. */
  private async heartbeat(): Promise<void> {
    if (this.inFlightCount === 0) return
    try {
      await this.db.execute(
        sql`UPDATE runs SET heartbeat_at = NOW() WHERE claimed_by = ${this.workerId} AND status = 'running'`
      )
    } catch (err) {
      console.error("[worker] Heartbeat failed:", err)
    }
  }

  /**
   * Crash recovery: re-queue running runs whose worker stopped heartbeating. Runs with no
   * heartbeat at all were claimed by a worker that predates heartbeats and are treated as
   * stale. Safe to run concurrently from every worker (one conditional UPDATE).
   */
  private async reapOrphanedRuns(): Promise<void> {
    try {
      const staleSeconds = this.staleAfterMs / 1000
      const reaped = await this.db.execute<{ id: string; claimed_by: string | null }>(
        sql`
          UPDATE runs
          SET status = 'pending', retry_after = NULL, claimed_by = NULL, heartbeat_at = NULL
          WHERE status = 'running'
            AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - make_interval(secs => ${staleSeconds}))
          RETURNING id, claimed_by
        `
      )
      if (reaped.length > 0) {
        console.log(
          `[worker] Re-queued ${reaped.length} orphaned run(s) with stale heartbeats:`,
          reaped.map((r) => r.id),
        )
        this.triggerPickup()
      }
    } catch (err) {
      console.error("[worker] Failed to re-queue orphaned runs:", err)
    }
  }

  private async warnRetryingRuns(): Promise<void> {
    try {
      const storageLayer = this.storageLayer
      const registryLayer = this.registryLayer

      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const storage = yield* Storage
          const registry = yield* Registry
          const retryingRuns = yield* storage.listRuns({ status: "retrying" })
          const registered = registry.list().map((f: { name: string }) => f.name)
          return retryingRuns.filter((r) => !registered.includes(r.functionName))
        }).pipe(
          Effect.provide(Layer.mergeAll(storageLayer, registryLayer)),
        ),
      )

      if (result._tag === "Success" && result.value.length > 0) {
        console.warn(
          `[worker] Warning: ${result.value.length} run(s) in 'retrying' state belong to functions not in the current registry. This may indicate a version mismatch.`,
          result.value.map((r) => ({ id: r.id })),
        )
      }
    } catch (err) {
      console.error("[worker] Failed to check retrying runs:", err)
    }
  }

  private async setupListen(): Promise<void> {
    const connectionString = process.env["DATABASE_URL"]

    if (!connectionString) {
      console.warn("[worker] DATABASE_URL not set; LISTEN/NOTIFY unavailable, using poll-only mode")
      return
    }

    try {
      this.listenSql = postgres(connectionString)
      await this.listenSql.listen(NOTIFY_CHANNEL, () => {
        void this.pickupCycle()
      })
      console.log(`[worker] Listening on PostgreSQL channel '${NOTIFY_CHANNEL}'`)
    } catch (err) {
      console.error("[worker] Failed to set up LISTEN:", err)
      if (this.listenSql) {
        try { await this.listenSql.end() } catch { /* ignore */ }
        this.listenSql = null
      }
    }
  }

  private schedulePoll(): void {
    if (this.shuttingDown) return
    this.pollTimer = setTimeout(() => {
      if (!this.shuttingDown) {
        void this.pickupCycle().then(() => this.schedulePoll())
      }
    }, POLL_INTERVAL_MS)
  }

  private async pickupCycle(): Promise<void> {
    if (this.shuttingDown) return

    const globalSlots = this.concurrency - this.inFlightCount
    if (globalSlots <= 0) return

    try {
      // Get registry to know per-function concurrency limits
      const registryResult = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const registry = yield* Registry
          return registry.list()
        }).pipe(Effect.provide(this.registryLayer)),
      )

      const functions: Array<{ name: string; concurrency?: number }> =
        registryResult._tag === "Success" ? registryResult.value : []

      const funcConcurrencyMap = new Map<string, number>(
        functions.map((f) => [f.name, f.concurrency ?? Infinity]),
      )

      // Atomically select and claim eligible runs inside a transaction so that
      // concurrent workers cannot claim the same row (FOR UPDATE holds until COMMIT).
      const picked = await this.db.transaction(async (tx) => {
        const rows = await tx.execute<{ id: string; integration_name: string }>(
          sql`
            SELECT id, integration_name
            FROM runs
            WHERE (
                status IN ('pending', 'retrying')
                AND (retry_after IS NULL OR retry_after <= NOW())
              ) OR (
                status = 'waiting'
                AND retry_after IS NOT NULL
                AND retry_after <= NOW()
              )
            ORDER BY started_at
            FOR UPDATE SKIP LOCKED
            LIMIT ${globalSlots * 2}
          `
        )

        const eligible: { id: string; integration_name: string }[] = []
        const tempPerFunc = new Map(this.inFlightPerFunction)

        for (const row of rows) {
          if (eligible.length >= globalSlots) break
          const funcName = row.integration_name
          const perFuncLimit = funcConcurrencyMap.get(funcName) ?? Infinity
          const inFlightForFunc = tempPerFunc.get(funcName) ?? 0
          if (inFlightForFunc >= perFuncLimit) continue
          eligible.push(row)
          tempPerFunc.set(funcName, inFlightForFunc + 1)
        }

        if (eligible.length > 0) {
          await tx.update(schema.runs)
            .set({ status: "running", claimedBy: this.workerId, heartbeatAt: sql`NOW()` })
            .where(inArray(schema.runs.id, eligible.map((r) => r.id)))
        }

        return eligible
      })

      for (const row of picked) {
        if (this.shuttingDown) break
        const funcName = row.integration_name
        const inFlightForFunc = this.inFlightPerFunction.get(funcName) ?? 0
        this.inFlightCount++
        this.inFlightPerFunction.set(funcName, inFlightForFunc + 1)
        void this.executeOne(row.id, funcName)
      }
    } catch (err) {
      console.error("[worker] Pickup cycle error:", err)
    }
  }

  private async executeOne(runId: string, funcName: string): Promise<void> {
    try {
      const result = await Effect.runPromiseExit(
        executeRun(runId).pipe(
          Effect.provide(Layer.mergeAll(this.storageLayer, this.registryLayer)),
        ),
      )

      if (result._tag === "Failure") {
        console.error(`[worker] executeRun failed for run ${runId}:`, result.cause)
      }
    } catch (err) {
      console.error(`[worker] Unexpected error executing run ${runId}:`, err)
    } finally {
      this.inFlightCount--
      const prev = this.inFlightPerFunction.get(funcName) ?? 1
      if (prev <= 1) {
        this.inFlightPerFunction.delete(funcName)
      } else {
        this.inFlightPerFunction.set(funcName, prev - 1)
      }

      if (this.shuttingDown && this.inFlightCount === 0 && this.shutdownResolve) {
        this.shutdownResolve()
        this.shutdownResolve = null
      }
    }
  }
}
