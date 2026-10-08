import { randomUUID } from "node:crypto"
import { Context, Duration, Effect, Option } from "effect"
import type { Storage } from "./storage.js"
import { StepError, StorageError, StepperPark } from "./errors.js"

export interface StepOptions {
  maxAttempts?: number
}

export interface StepContext {
  readonly runId: string
  readonly run: <A>(
    name: string,
    fn: () => Promise<A> | A,
    opts?: StepOptions,
  ) => Effect.Effect<A, StepperPark | StepError | StorageError, never>
  readonly sleep: (
    name: string,
    duration: Duration.Duration,
  ) => Effect.Effect<void, StepperPark | StorageError, never>
}

export const StepContext = Context.GenericTag<StepContext>("@integration-stepper/core/StepContext")

export const makeStepContext = (runId: string, storage: Storage): StepContext => {
  // Track call counts per step name for auto-indexing (runId:name#callIndex)
  const callCounts = new Map<string, number>()

  const getIndexedName = (name: string): string => {
    const count = callCounts.get(name) ?? 0
    callCounts.set(name, count + 1)
    return `${name}#${count}`
  }

  return {
    runId,

    run: <A>(name: string, fn: () => Promise<A> | A, opts?: StepOptions) =>
      Effect.gen(function* () {
        const indexedName = getIndexedName(name)
        const maxAttempts = opts?.maxAttempts ?? 3

        const existing = yield* storage.getStep(runId, indexedName)

        // Already completed — return memoized output and continue handler
        if (Option.isSome(existing) && existing.value.status === "completed") {
          return Option.getOrNull(existing.value.output) as A
        }

        const prevAttempt = Option.isSome(existing) ? existing.value.attempt : 0
        const attempt = prevAttempt + 1

        const stepId = Option.isSome(existing) ? existing.value.id : randomUUID()
        if (Option.isNone(existing)) {
          yield* storage.createStep({
            id: stepId,
            runId,
            name: indexedName,
            status: "running",
            attempt,
            maxAttempts,
            startedAt: Option.some(new Date()),
            completedAt: Option.none(),
            output: Option.none(),
            error: Option.none(),
          })
        } else {
          yield* storage.updateStep(stepId, {
            status: "running",
            attempt,
            startedAt: Option.some(new Date()),
          })
        }

        // Execute the step function
        const fnResult = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn()),
          catch: (cause) => new StepError({ stepName: indexedName, cause, attempt }),
        }).pipe(Effect.either)

        if (fnResult._tag === "Left") {
          const stepError = fnResult.left
          yield* storage.updateStep(stepId, {
            status: attempt >= maxAttempts ? "failed" : "running",
            error: Option.some(String(stepError.cause)),
          })
          // Terminal failure — all attempts exhausted
          if (attempt >= maxAttempts) {
            return yield* Effect.fail(stepError)
          }
          // Attempts remain — re-queue run for retry
          return yield* Effect.fail(new StepperPark({ reason: "step-completed" }))
        }

        // Success — store result and abort handler to defer remaining steps
        yield* storage.updateStep(stepId, {
          status: "completed",
          completedAt: Option.some(new Date()),
          output: Option.some(fnResult.right),
        })

        return yield* Effect.fail(new StepperPark({ reason: "step-completed" }))
      }),

    sleep: (name: string, duration: Duration.Duration) =>
      Effect.gen(function* () {
        const indexedName = getIndexedName(name)

        const existing = yield* storage.getStep(runId, indexedName)

        // Already completed � return void and continue handler
        if (Option.isSome(existing) && existing.value.status === "completed") {
          return
        }

        // Woken up: the sleep step was started on a previous pickup. Close it now so
        // startedAt..completedAt spans the actual sleep, then continue the handler.
        if (Option.isSome(existing)) {
          yield* storage.updateStep(existing.value.id, {
            status: "completed",
            completedAt: Option.some(new Date()),
          })
          return
        }

        // First execution: record the sleep as running (startedAt = now) and park.
        yield* storage.createStep({
          id: randomUUID(),
          runId,
          name: indexedName,
          status: "running",
          attempt: 1,
          maxAttempts: 1,
          startedAt: Option.some(new Date()),
          completedAt: Option.none(),
          output: Option.none(),
          error: Option.none(),
        })

        const retryAfter = new Date(Date.now() + Duration.toMillis(duration))
        return yield* Effect.fail(new StepperPark({ reason: "sleep", retryAfter }))
      }),
  }
}
