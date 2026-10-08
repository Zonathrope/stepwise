import { test } from "node:test"
import assert from "node:assert/strict"
import { renderMetrics } from "./metrics.js"

test("renders Prometheus text format", () => {
  const text = renderMetrics({
    runsByStatus: { completed: 3, pending: 1 },
    durations: [{ functionName: 'a"b', count: 3, sum: 6, quantiles: { "0.5": 1, "0.95": 2, "0.99": 3 } }],
    activeRuns: 2,
    pickupLagSeconds: 4.5,
  })
  assert.match(text, /^# TYPE stepper_runs_total gauge$/m)
  assert.match(text, /^stepper_runs_total\{status="completed"\} 3$/m)
  assert.match(text, /^stepper_runs_total\{status="failed"\} 0$/m)
  assert.match(text, /^stepper_runs_duration_seconds\{function="a\\"b",quantile="0.95"\} 2$/m)
  assert.match(text, /^stepper_runs_duration_seconds_count\{function="a\\"b"\} 3$/m)
  assert.match(text, /^stepper_worker_active_runs 2$/m)
  assert.match(text, /^stepper_worker_pickup_lag_seconds 4.5$/m)
  assert.ok(text.endsWith("\n"))
})
