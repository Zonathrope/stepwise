import { randomUUID } from "node:crypto"
import { Effect, Option } from "effect"
import type { EventPayload } from "./schema.js"
import { Storage } from "./storage.js"
import { Registry } from "./registry.js"
import { makeStepContext } from "./step-context.js"
import { RunNotFoundError, StepperPark } from "./errors.js"

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

    const stepContext = makeStepContext(runId, storage)

    type Outcome =
      | { _tag: "completed" }
      | { _tag: "parked"; park: StepperPark }
      | { _tag: "failed"; error: unknown }

    // Run the handler, distinguishing StepperPark (park signal) from real errors
    const outcome: Outcome = yield* fn.handler(event, stepContext).pipe(
      Effect.map((): Outcome => ({ _tag: "completed" })),
      Effect.catchAll((error): Effect.Effect<Outcome> => {
        if (isStepperPark(error)) {
          return Effect.succeed({ _tag: "parked", park: error })
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
        })
      } else {
        // step-completed: park back to pending for next pickup
        yield* storage.updateRun(runId, {
          status: "pending",
          retryAfter: Option.none(),
        })
      }
    } else if (outcome._tag === "completed") {
      yield* storage.updateRun(runId, {
        status: "completed",
        completedAt: Option.some(new Date()),
      })
    } else {
      yield* storage.updateRun(runId, {
        status: "failed",
        completedAt: Option.some(new Date()),
        error: Option.some(String(outcome.error)),
      })
    }
  })

export const dispatchEvent = (event: EventPayload) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry

    yield* storage.saveEvent(event)

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
          })
          return { runId, functionName: fn.name }
        }),
      { concurrency: "unbounded" },
    )
  })
