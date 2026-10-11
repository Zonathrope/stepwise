import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { Effect, Layer } from "effect"
import { dispatchCronTicks, executeRun, Registry, selectClaimable, Storage } from "@integration-stepper/core"
import { sql, inArray } from "drizzle-orm"
import * as schema from "./db/schema.js"
import type { Db } from "./db/client.js"
import postgres from "postgres"
import { notifyRunUpdate } from "./run-updates.js"

const NOTIFY_CHANNEL = "stepper_runs"
const POLL_INTERVAL_MS = 5000
/** First key of the two-key advisory locks taken per concurrency key during pickup. */
const CONCURRENCY_LOCK_NAMESPACE = 0x5354_4550
const CRON_INTERVAL_MS = 5000
/**
 * On startup, also fire cron ticks from this far back, so a tick that fell inside a restart
 * (e.g. a rolling deploy) is not lost. Ticks already fired by another worker are deduplicated.
 */
const CRON_STARTUP_LOOKBACK_MS = 60_000

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
  private shutdownResolve: (() => void) | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private cronTimer: ReturnType<typeof setTimeout> | null = null
  private lastCronCheck = new Date(Date.now() - CRON_STARTUP_LOOKBACK_MS)
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
    await this.cronCycle()
    this.scheduleCron()
    await this.pickupCycle()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true

    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }

    if (this.cronTimer !== null) {
      clearTimeout(this.cronTimer)
      this.cronTimer = null
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

  private scheduleCron(): void {
    if (this.shuttingDown) return
    this.cronTimer = setTimeout(() => {
      if (!this.shuttingDown) {
        void this.cronCycle().then(() => this.scheduleCron())
      }
    }, CRON_INTERVAL_MS)
  }

  /**
   * Create runs for cron ticks since the last check. Every worker does this; deterministic
   * per-tick event/run ids make the dispatch idempotent, so each tick fires exactly once.
   */
  private async cronCycle(): Promise<void> {
    if (this.shuttingDown) return
    const to = new Date()
    const result = await Effect.runPromiseExit(
      dispatchCronTicks(this.lastCronCheck, to).pipe(
        Effect.provide(Layer.mergeAll(this.storageLayer, this.registryLayer)),
      ),
    )
    if (result._tag === "Failure") {
      // Keep lastCronCheck so the window is retried on the next cycle
      console.error("[worker] Cron dispatch failed:", result.cause)
      return
    }
    this.lastCronCheck = to
    if (result.value.length > 0) {
      console.log(
        "[worker] Scheduled cron runs:",
        result.value.map((r) => ({ runId: r.runId, functionName: r.functionName, scheduledAt: r.scheduledAt.toISOString() })),
      )
      await this.pickupCycle()
    }
  }

  private async pickupCycle(): Promise<void> {
    if (this.shuttingDown) return

    const slots = this.concurrency - this.inFlightCount
    if (slots <= 0) return

    try {
      // Only claim runs this worker can execute. Claiming a run of an unknown function (another
      // service's, or one removed in a deploy) would strand it in "running" forever.
      const registered = await Effect.runPromise(
        Effect.map(Registry, (r) => r.list().map((f) => f.name)).pipe(Effect.provide(this.registryLayer)),
      )
      if (registered.length === 0) return

      const { picked, heldBack } = await this.db.transaction(async (tx) => {
        // Candidates oldest first. Runs whose concurrency key is already at its limit are
        // filtered out here so a saturated key cannot starve runs queued behind it.
        // FOR UPDATE SKIP LOCKED keeps concurrent workers off the same rows until COMMIT.
        const rows = await tx.execute<{
          id: string
          concurrency_key: string | null
          concurrency_limit: number | null
        }>(
          sql`
            SELECT id, concurrency_key, concurrency_limit
            FROM runs
            WHERE (
                (
                  status IN ('pending', 'retrying')
                  AND (retry_after IS NULL OR retry_after <= NOW())
                ) OR (
                  status = 'waiting'
                  AND retry_after IS NOT NULL
                  AND retry_after <= NOW()
                )
              )
              AND integration_name IN (${sql.join(registered.map((n) => sql`${n}`), sql`, `)})
              AND (
                concurrency_key IS NULL
                OR concurrency_limit > (
                  SELECT count(*) FROM runs AS r
                  WHERE r.concurrency_key = runs.concurrency_key AND r.status = 'running'
                )
              )
            ORDER BY started_at
            FOR UPDATE SKIP LOCKED
            LIMIT ${slots * 4}
          `
        )

        const candidates = rows.map((r) => ({
          id: r.id,
          concurrency:
            r.concurrency_key !== null && r.concurrency_limit !== null
              ? { key: r.concurrency_key, limit: r.concurrency_limit }
              : null,
        }))

        // Serialise claimers per key: two workers holding different rows of the same key would
        // otherwise both see the old running count. Locks are taken in sorted order (no
        // deadlocks) and released at COMMIT, after which the next claimer counts our claims.
        const keys = [...new Set(candidates.flatMap((c) => (c.concurrency ? [c.concurrency.key] : [])))].sort()
        for (const key of keys) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${CONCURRENCY_LOCK_NAMESPACE}, hashtext(${key}))`)
        }

        const runningByKey = new Map<string, number>()
        if (keys.length > 0) {
          const counts = await tx.execute<{ concurrency_key: string; running: number }>(
            sql`
              SELECT concurrency_key, count(*)::int AS running
              FROM runs
              WHERE status = 'running' AND concurrency_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
              GROUP BY concurrency_key
            `
          )
          for (const row of counts) runningByKey.set(row.concurrency_key, row.running)
        }

        const { claim, heldBack } = selectClaimable(candidates, runningByKey, slots)

        if (claim.length > 0) {
          await tx.update(schema.runs)
            .set({ status: "running", claimedBy: this.workerId, heartbeatAt: sql`NOW()` })
            .where(inArray(schema.runs.id, claim))
        }

        return { picked: claim, heldBack }
      })

      for (const runId of picked) void notifyRunUpdate(this.db, runId)

      for (const runId of picked) {
        if (this.shuttingDown) break
        this.inFlightCount++
        void this.executeOne(runId)
      }

      // Runs held back by a full key may have hidden eligible runs further down the queue;
      // look again now that the saturated keys are filtered out by the candidate query.
      if (heldBack > 0 && picked.length < slots) this.triggerPickup()
    } catch (err) {
      console.error("[worker] Pickup cycle error:", err)
    }
  }

  private async executeOne(runId: string): Promise<void> {
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
      void notifyRunUpdate(this.db, runId)
      this.inFlightCount--

      if (this.shuttingDown && this.inFlightCount === 0 && this.shutdownResolve) {
        this.shutdownResolve()
        this.shutdownResolve = null
      }

      // A finished run frees a worker slot and possibly a concurrency-key slot
      this.triggerPickup()
    }
  }
}
