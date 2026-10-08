import { Schema } from "effect"

export const RunStatus = Schema.Literal("pending", "running", "retrying", "waiting", "completed", "failed", "cancelled")
export type RunStatus = typeof RunStatus.Type

export const StepStatus = Schema.Literal("pending", "running", "completed", "failed", "skipped")
export type StepStatus = typeof StepStatus.Type

export const EventPayload = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  data: Schema.Unknown,
  timestamp: Schema.DateFromSelf,
})
export type EventPayload = typeof EventPayload.Type

export const StepRecord = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  name: Schema.String,
  status: StepStatus,
  attempt: Schema.Number,
  maxAttempts: Schema.Number,
  startedAt: Schema.OptionFromNullOr(Schema.DateFromSelf),
  completedAt: Schema.OptionFromNullOr(Schema.DateFromSelf),
  output: Schema.OptionFromNullOr(Schema.Unknown),
  error: Schema.OptionFromNullOr(Schema.String),
  retryAfter: Schema.OptionFromNullOr(Schema.DateFromSelf),
})
export type StepRecord = typeof StepRecord.Type

/**
 * Persisted description of what a parked run is waiting for (step.waitForEvent).
 * `match` is a serialisable filter: dotted paths into `event.data` mapped to the
 * exact values they must equal (e.g. `{ "orderId": "o-1", "customer.id": 7 }`).
 */
export const WaitingFor = Schema.Struct({
  event: Schema.String,
  stepName: Schema.String,
  match: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  timeoutAt: Schema.NullOr(Schema.DateFromSelf),
  onTimeout: Schema.Literal("null", "throw"),
})
export type WaitingFor = typeof WaitingFor.Type

export const RunRecord = Schema.Struct({
  id: Schema.String,
  functionName: Schema.String,
  eventId: Schema.String,
  status: RunStatus,
  startedAt: Schema.DateFromSelf,
  completedAt: Schema.OptionFromNullOr(Schema.DateFromSelf),
  error: Schema.OptionFromNullOr(Schema.String),
  retryAfter: Schema.OptionFromNullOr(Schema.DateFromSelf),
  waitingFor: Schema.OptionFromNullOr(WaitingFor),
})
export type RunRecord = typeof RunRecord.Type
