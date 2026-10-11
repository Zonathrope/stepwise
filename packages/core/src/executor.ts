import { createHash, randomUUID } from "node:crypto"
import { Effect, Option } from "effect"
import type { EventPayload, RunRecord, WaitingFor } from "./schema.js"
import type { CronEventData } from "./function.js"
import { cronTicksBetween, parseCron } from "./cron.js"
import { Storage } from "./storage.js"
import { Registry } from "./registry.js"
import {
  INVOKE_RESULT_EVENT,
  invokeResultEventId,
  makeStepContext,
  type InvokeResultData,
} from "./step-context.js"
import { RunNotFoundError, StepperPark, ValidationError, type ValidationIssue } from "./errors.js"

const isStepperPark = (e: unknown): e is StepperPark =>
  e instanceof StepperPark ||
  (typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: unknown })._tag === "StepperPark")

export const executeRun = (runId: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry

    const maybeRun = yield* storage.getRun(runId)
    const run = yield* Effect.fromNullable(Option.getOrNull(maybeRun)).pipe(
      Effect.mapError(() => new RunNotFoundError({ runId })),
    )

    const fn = yield* registry.get(run.functionName)
    const maybeEvent = yield* storage.getEvent(run.eventId)
    const event = yield* Effect.fromNullable(Option.getOrNull(maybeEvent)).pipe(
      Effect.mapError(() => new RunNotFoundError({ runId: run.eventId })),
    )

    yield* storage.updateRun(runId, { status: "running" })

    const stepContext = makeStepContext(runId, storage, { registry })

    type Outcome =
      | { _tag: "completed"; output: unknown }
      | { _tag: "parked"; park: StepperPark }
      | { _tag: "failed"; error: unknown }

    // Run the handler, distinguishing StepperPark (park signal) from real errors
    const outcome: Outcome = yield* fn.handler(event, stepContext).pipe(
      Effect.map((output): Outcome => ({ _tag: "completed", output })),
      Effect.catchAll((error): Effect.Effect<Outcome> => {
        if (isStepperPark(error)) {
          return Effect.succeed({ _tag: "parked", park: error })
        }
        return Effect.succeed({ _tag: "failed", error })
      }),
    )

    if (outcome._tag === "parked") {
      const park = outcome.park
      if (park.reason === "sleep" || park.reason === "step-retry") {
        yield* storage.updateRun(runId, {
          status: "retrying",
          retryAfter: Option.some(park.retryAfter!),
          waitingFor: Option.none(),
        })
      } else if (park.reason === "wait") {
        const waitingFor = park.waitingFor!
        yield* storage.updateRun(runId, {
          status: "waiting",
          retryAfter: Option.fromNullable(waitingFor.timeoutAt),
          waitingFor: Option.some(waitingFor),
        })
        // The awaited event may have landed before the run was parked (e.g. an invoked run
        // that finished first). Whoever writes second sees the other, so no wake-up is lost.
        if (waitingFor.resultEventId !== undefined) {
          const ready = yield* storage.getEvent(waitingFor.resultEventId)
          if (Option.isSome(ready)) yield* storage.resumeWaitingRun(runId, waitingFor.stepName, ready.value)
        }
      } else {
        // step-completed: park back to pending for next pickup
        yield* storage.updateRun(runId, {
          status: "pending",
          retryAfter: Option.none(),
          waitingFor: Option.none(),
        })
      }
    } else if (outcome._tag === "completed") {
      yield* storage.updateRun(runId, {
        status: "completed",
        completedAt: Option.some(new Date()),
        waitingFor: Option.none(),
        output: Option.fromNullable(outcome.output),
      })
      yield* notifyInvoker(run.id, run.eventId, fn.name, {
        status: "completed",
        output: outcome.output ?? null,
        error: null,
      })
    } else {
      // Conditional transition: only the execution that actually moves the run to "failed"
      // (not one that lost a race with a cancel) invokes onFailure, so it fires once per failure.
      const failed = yield* storage.transitionRun(runId, ["running"], {
        status: "failed",
        completedAt: Option.some(new Date()),
        error: Option.some(String(outcome.error)),
        waitingFor: Option.none(),
      })
      if (failed) {
        yield* notifyInvoker(run.id, run.eventId, fn.name, {
          status: "failed",
          output: null,
          error: String(outcome.error),
        })
      }
      if (failed && fn.onFailure) {
        yield* Effect.suspend(() =>
          fn.onFailure!({ runId, functionName: fn.name, event, error: outcome.error }),
        ).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(`onFailure handler for "${fn.name}" failed (run ${runId})`, cause),
          ),
        )
      }
    }
  })

/**
 * If `runId` was started by `step.invoke`, report its terminal result to the invoking run:
 * store an `invoke/result` event (deterministic id, so repeats are no-ops) and resume the
 * parent if it is already waiting. Call after the run reached a terminal status.
 */
export const notifyInvoker = (
  runId: string,
  eventId: string,
  functionName: string,
  result: Pick<InvokeResultData, "status" | "output" | "error">,
) =>
  Effect.gen(function* () {
    if (!eventId.startsWith("invoke:")) return
    const storage = yield* Storage
    const data: InvokeResultData = { childRunId: runId, functionName, ...result }
    const event: EventPayload = { id: invokeResultEventId(runId), name: INVOKE_RESULT_EVENT, data, timestamp: new Date() }
    if (Option.isNone(yield* storage.getEvent(event.id))) yield* storage.saveEvent(event)
    yield* resumeWaitingRuns(event)
  })

const getPath = (value: unknown, path: string): unknown => {
  let current: unknown = value
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** True if `event` satisfies a run's `waitingFor` filter. */
export const eventMatchesWait = (event: EventPayload, waitingFor: WaitingFor): boolean =>
  event.name === waitingFor.event &&
  Object.entries(waitingFor.match ?? {}).every(([path, expected]) =>
    deepEqual(getPath(event.data, path), expected),
  )

/**
 * Resume every `waiting` run whose filter matches `event`. The event becomes the output of the
 * run's waitForEvent step. Returns the ids of the runs that were resumed.
 */
export const resumeWaitingRuns = (event: EventPayload) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const waiting = yield* storage.listWaitingRuns(event.name)
    const resumed: string[] = []
    for (const run of waiting) {
      if (Option.isNone(run.waitingFor) || !eventMatchesWait(event, run.waitingFor.value)) continue
      const ok = yield* storage.resumeWaitingRun(run.id, run.waitingFor.value.stepName, event)
      if (ok) resumed.push(run.id)
    }
    return resumed
  })

const toIssues = (err: unknown): ValidationIssue[] => {
  const raw = (err as any)?.issues ?? (err as any)?.errors
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((i: any) => ({
      ...(Array.isArray(i?.path)
        ? { path: i.path.map((p: any) => (typeof p === "object" && p !== null && "key" in p ? p.key : p)) }
        : {}),
      message: String(i?.message ?? i),
    }))
  }
  return [{ message: err instanceof Error ? err.message : String(err) }]
}

export const dispatchEvent = (event: EventPayload) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry

    const fns = registry.getByEvent(event.name)

    // Validate before persisting anything: no event or runs on invalid data
    for (const fn of fns) {
      if (!fn.schema) continue
      try {
        fn.schema.parse(event.data)
      } catch (err) {
        const issues = toIssues(err)
        return yield* Effect.fail(
          new ValidationError({
            eventName: event.name,
            functionName: fn.name,
            message: `Event "${event.name}" failed validation for function "${fn.name}": ${issues.map((i) => i.message).join("; ")}`,
            issues,
          }),
        )
      }
    }

    const runs = fns.map((fn) => ({
      id: randomUUID(),
      functionName: fn.name,
      eventId: event.id,
      status: "pending" as const,
      startedAt: new Date(),
      completedAt: Option.none<Date>(),
      error: Option.none<string>(),
      retryAfter: Option.none<Date>(),
      waitingFor: Option.none<WaitingFor>(),
      output: Option.none<unknown>(),
    }))

    // Event and all runs are persisted atomically
    yield* storage.saveEventWithRuns(event, runs)

    // Wake any runs parked in step.waitForEvent that this event satisfies
    yield* resumeWaitingRuns(event)

    return runs.map((r) => ({ runId: r.id, functionName: r.functionName }))
  })

/** Deterministic id of the event representing one cron tick of one function. */
export const cronEventId = (functionName: string, tick: Date) => `cron:${functionName}:${tick.toISOString()}`

/** Format the first 16 bytes of a sha256 digest as a UUID, so derived ids look like generated ones. */
const deterministicUuid = (seed: string) => {
  const h = createHash("sha256").update(seed).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * Create runs for every cron tick in `(from, to]` of every cron-triggered function.
 *
 * Safe to call concurrently from several workers over overlapping windows: each tick maps to a
 * deterministic event id and run id, so only the first writer persists it. Later writers see the
 * stored event (or a primary-key conflict on the atomic event+run insert) and skip the tick.
 * Returns only the runs this call created.
 */
export const dispatchCronTicks = (from: Date, to: Date) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry
    const created: Array<{ runId: string; functionName: string; scheduledAt: Date }> = []

    for (const fn of registry.listCron()) {
      const cron = fn.cron!
      for (const tick of cronTicksBetween(parseCron(cron), from, to)) {
        const eventId = cronEventId(fn.name, tick)
        if (Option.isSome(yield* storage.getEvent(eventId))) continue

        const data: CronEventData = { cron, scheduledAt: tick.toISOString() }
        const event: EventPayload = { id: eventId, name: `cron/${fn.name}`, data, timestamp: tick }
        const run: RunRecord = {
          id: deterministicUuid(eventId),
          functionName: fn.name,
          eventId,
          status: "pending",
          startedAt: new Date(),
          completedAt: Option.none(),
          error: Option.none(),
          retryAfter: Option.none(),
          waitingFor: Option.none(),
          output: Option.none(),
        }

        const inserted = yield* storage.saveEventWithRuns(event, [run]).pipe(
          Effect.as(true),
          Effect.catchTag("StorageError", (err) =>
            // Another worker won the race for this tick: its event is now visible
            storage.getEvent(eventId).pipe(
              Effect.flatMap((existing) => (Option.isSome(existing) ? Effect.succeed(false) : Effect.fail(err))),
            ),
          ),
        )
        if (inserted) created.push({ runId: run.id, functionName: fn.name, scheduledAt: tick })
      }
    }
    return created
  })
