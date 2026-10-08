import { sql } from "drizzle-orm"
import type { Db } from "./db/client.js"

export const RUN_STATUSES = ["pending", "running", "retrying", "completed", "failed", "cancelled"] as const
export const QUANTILES = [0.5, 0.95, 0.99] as const
/** Duration quantiles are computed over runs that finished within this window. */
export const DURATION_WINDOW_SECONDS = 3600

export interface MetricsSnapshot {
  runsByStatus: Record<string, number>
  durations: Array<{ functionName: string; count: number; sum: number; quantiles: Record<string, number> }>
  activeRuns: number
  pickupLagSeconds: number
}

const escapeLabel = (v: string): string =>
  v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')

/** Pure renderer: Prometheus text exposition format (v0.0.4). */
export const renderMetrics = (s: MetricsSnapshot): string => {
  const out: string[] = []

  out.push("# HELP stepper_runs_total Number of runs currently in each status.")
  out.push("# TYPE stepper_runs_total gauge")
  for (const status of RUN_STATUSES) {
    out.push(`stepper_runs_total{status="${status}"} ${s.runsByStatus[status] ?? 0}`)
  }

  out.push(
    `# HELP stepper_runs_duration_seconds Run duration (start to completion) over runs finished in the last ${DURATION_WINDOW_SECONDS}s.`,
  )
  out.push("# TYPE stepper_runs_duration_seconds summary")
  for (const d of s.durations) {
    const fn = escapeLabel(d.functionName)
    for (const q of QUANTILES) {
      out.push(`stepper_runs_duration_seconds{function="${fn}",quantile="${q}"} ${d.quantiles[String(q)] ?? 0}`)
    }
    out.push(`stepper_runs_duration_seconds_sum{function="${fn}"} ${d.sum}`)
    out.push(`stepper_runs_duration_seconds_count{function="${fn}"} ${d.count}`)
  }

  out.push("# HELP stepper_worker_active_runs Runs currently being executed by workers.")
  out.push("# TYPE stepper_worker_active_runs gauge")
  out.push(`stepper_worker_active_runs ${s.activeRuns}`)

  out.push("# HELP stepper_worker_pickup_lag_seconds Age of the oldest run that is eligible for pickup.")
  out.push("# TYPE stepper_worker_pickup_lag_seconds gauge")
  out.push(`stepper_worker_pickup_lag_seconds ${s.pickupLagSeconds}`)

  return out.join("\n") + "\n"
}

/**
 * Computed from the database on each scrape so it is correct with the worker
 * running in-process, in a separate process, or across several replicas.
 */
export const collectMetrics = async (db: Db): Promise<MetricsSnapshot> => {
  const statusRows = (await db.execute(
    sql`SELECT status, COUNT(*)::int AS n FROM runs GROUP BY status`,
  )) as unknown as Array<{ status: string; n: number }>

  const durationRows = (await db.execute(sql`
    SELECT integration_name AS fn,
           COUNT(*)::int AS n,
           COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - started_at))), 0)::float8 AS sum,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)))::float8 AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)))::float8 AS p95,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)))::float8 AS p99
    FROM runs
    WHERE status IN ('completed', 'failed')
      AND completed_at IS NOT NULL
      AND completed_at >= NOW() - make_interval(secs => ${DURATION_WINDOW_SECONDS})
    GROUP BY integration_name
  `)) as unknown as Array<{ fn: string; n: number; sum: number; p50: number; p95: number; p99: number }>

  const lagRows = (await db.execute(sql`
    SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(retry_after, started_at)))), 0)::float8 AS lag
    FROM runs
    WHERE status IN ('pending', 'retrying')
      AND (retry_after IS NULL OR retry_after <= NOW())
  `)) as unknown as Array<{ lag: number }>

  const runsByStatus: Record<string, number> = {}
  for (const r of statusRows) runsByStatus[r.status] = Number(r.n)

  return {
    runsByStatus,
    durations: durationRows.map((r) => ({
      functionName: r.fn,
      count: Number(r.n),
      sum: Number(r.sum),
      quantiles: { "0.5": Number(r.p50), "0.95": Number(r.p95), "0.99": Number(r.p99) },
    })),
    activeRuns: runsByStatus["running"] ?? 0,
    pickupLagSeconds: Math.max(0, Number(lagRows[0]?.lag ?? 0)),
  }
}
