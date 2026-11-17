import { Effect, Option } from "effect"
import type { EventPayload, RunRecord } from "./schema.js"
import { Storage } from "./storage.js"
import { Registry } from "./registry.js"
import { dispatchEvent } from "./executor.js"

/**
 * Run lifecycle events: when a run reaches a terminal state the executor dispatches one of
 * these as an ordinary event, so notifications (Slack, webhooks, email, ...) are just
 * functions triggered by them, with normal steps and retries. See docs/adr/0004.
 */
export const RUN_COMPLETED_EVENT = "stepwise/run.completed"
export const RUN_FAILED_EVENT = "stepwise/run.failed"
export const RUN_CANCELLED_EVENT = "stepwise/run.cancelled"

/** Event names under this prefix are emitted by the runtime and rejected from `POST /api/events`. */
export const RESERVED_EVENT_PREFIX = "stepwise/"

export const isReservedEventName = (name: string) => name.startsWith(RESERVED_EVENT_PREFIX)

/** `event.data` of `stepwise/run.completed`. */
export interface RunCompletedEventData {
  readonly runId: string
  readonly functionName: string
  /** Id of the event that triggered the finished run. */
  readonly eventId: string
  readonly output: unknown
}

/** `event.data` of `stepwise/run.failed`. */
export interface RunFailedEventData {
  readonly runId: string
  readonly functionName: string
  /** Id of the event that triggered the finished run. */
  readonly eventId: string
  /** The run's error, as stored on the run record. */
  readonly error: string
}

/** `event.data` of `stepwise/run.cancelled`. */
export interface RunCancelledEventData {
  readonly runId: string
  readonly functionName: string
  /** Id of the event that triggered the cancelled run. */
  readonly eventId: string
}

export type RunLifecycleResult =
  | { readonly status: "completed"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled" }

const EVENT_FOR_STATUS = {
  completed: RUN_COMPLETED_EVENT,
  failed: RUN_FAILED_EVENT,
  cancelled: RUN_CANCELLED_EVENT,
} as const satisfies Record<RunLifecycleResult["status"], string>

/**
 * Deterministic id of the lifecycle event for one terminal transition of a run. A run can
 * fail, be retried and fail again, so the transition's `completedAt` is part of the id:
 * repeating the emission for the same transition is a no-op, a later transition is new.
 */
export const lifecycleEventId = (runId: string, status: RunLifecycleResult["status"], completedAt: Date) =>
  `lifecycle:${runId}:${status}:${completedAt.getTime()}`

const MAX_INVOKE_DEPTH = 32

/**
 * True if `event` is a lifecycle event, or started a run inside an invoke chain rooted in one
 * (a lifecycle handler that `step.invoke`s a child). Runs with such an origin don't emit
 * lifecycle events, so lifecycle handlers can never trigger themselves.
 */
export const hasLifecycleOrigin = (event: EventPayload) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    let current: EventPayload = event
    for (let depth = 0; depth < MAX_INVOKE_DEPTH; depth++) {
      if (isReservedEventName(current.name)) return true
      // invoke:<parentRunId>:<stepKey>; run ids are UUIDs, so the second segment is the parent
      if (!current.id.startsWith("invoke:")) return false
      const parentRunId = current.id.split(":")[1]
      if (!parentRunId) return false
      const parent = yield* storage.getRun(parentRunId)
      if (Option.isNone(parent)) return false
      const parentEvent = yield* storage.getEvent(parent.value.eventId)
      if (Option.isNone(parentEvent)) return false
      current = parentEvent.value
    }
    // Pathologically deep chain: err on the side of not emitting
    return true
  })

/**
 * Dispatch the lifecycle event for a run that just reached a terminal state. Does nothing if
 * no registered function listens for it, or if the run itself has a lifecycle origin.
 * Never fails: a dispatch error (e.g. a listener's schema rejecting the data) is logged.
 * Returns the runs it created, so the caller can wake workers.
 */
export const emitLifecycleEvent = (
  run: Pick<RunRecord, "id" | "functionName" | "eventId">,
  event: EventPayload,
  result: RunLifecycleResult,
  completedAt: Date,
) =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const name = EVENT_FOR_STATUS[result.status]
    if (registry.getByEvent(name).length === 0) return []
    if (yield* hasLifecycleOrigin(event)) return []

    const base = { runId: run.id, functionName: run.functionName, eventId: run.eventId }
    const data: RunCompletedEventData | RunFailedEventData | RunCancelledEventData =
      result.status === "completed"
        ? { ...base, output: result.output ?? null }
        : result.status === "failed"
          ? { ...base, error: result.error }
          : base

    return yield* dispatchEvent({
      id: lifecycleEventId(run.id, result.status, completedAt),
      name,
      data,
      timestamp: completedAt,
    })
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError(`Failed to emit lifecycle event for run ${run.id}`, cause).pipe(
        Effect.as([] as Array<{ runId: string; functionName: string }>),
      ),
    ),
  )
