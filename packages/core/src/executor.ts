import { randomUUID } from "node:crypto"
import { Effect, Option } from "effect"
import type { EventPayload, WaitingFor } from "./schema.js"
import { Storage } from "./storage.js"
import { Registry } from "./registry.js"
import { makeStepContext } from "./step-context.js"
import { RunNotFoundError, StepperPark } from "./errors.js"

const isStepperPark = (e: unknown): e is StepperPark =>
  e instanceof StepperPark ||
  (typeof e === "object" && e !== null && "_tag" in e && (e as any)._tag === "StepperPark")

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

    const stepContext = makeStepContext(runId, storage)

    type Outcome =
      | { _tag: "completed" }
      | { _tag: "parked"; park: StepperPark }
      | { _tag: "failed"; error: unknown }

    // Run the handler, distinguishing StepperPark (park signal) from real errors
    const outcome: Outcome = yield* fn.handler(event as never, stepContext).pipe(
      Effect.map((): Outcome => ({ _tag: "completed" })),
      Effect.catchAll((error): Effect.Effect<Outcome> => {
        if (isStepperPark(error)) {
          return Effect.succeed({ _tag: "parked", park: error as StepperPark })
        }
        return Effect.succeed({ _tag: "failed", error })
      }),
    )

    if (outcome._tag === "parked") {
      const park = outcome.park
      if (park.reason === "sleep") {
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
      })
    } else {
      yield* storage.updateRun(runId, {
        status: "failed",
        completedAt: Option.some(new Date()),
        error: Option.some(String(outcome.error)),
        waitingFor: Option.none(),
      })
    }
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

export const dispatchEvent = (event: EventPayload) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry

    yield* storage.saveEvent(event)

    // Wake any runs parked in step.waitForEvent that this event satisfies
    yield* resumeWaitingRuns(event)

    const fns = registry.getByEvent(event.name)

    return yield* Effect.forEach(
      fns,
      (fn) =>
        Effect.gen(function* () {
          const runId = randomUUID()
          yield* storage.createRun({
            id: runId,
            functionName: fn.name,
            eventId: event.id,
            status: "pending",
            startedAt: new Date(),
            completedAt: Option.none(),
            error: Option.none(),
            retryAfter: Option.none(),
            waitingFor: Option.none(),
          })
          return { runId, functionName: fn.name }
        }),
      { concurrency: "unbounded" },
    )
  })
