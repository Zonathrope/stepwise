import { randomUUID } from "node:crypto"
import { Context, Duration, Effect, Option } from "effect"
import type { EventPayload, WaitingFor } from "./schema.js"
import type { Storage } from "./storage.js"
import { StepError, StorageError, StepperPark } from "./errors.js"

export interface StepOptions {
  maxAttempts?: number
}

export interface WaitForEventOptions {
  /** Name of the event to wait for. */
  event: string
  /**
   * Serialisable filter on the incoming event: dotted paths into `event.data` mapped to the
   * values they must equal, e.g. `{ orderId: event.data.orderId }`. Omit to match any event
   * with the given name. (Functions cannot be persisted across restarts, hence no predicate.)
   */
  match?: Record<string, unknown>
  /** How long to wait. Omit to wait indefinitely. */
  timeout?: Duration.DurationInput
  /** On timeout: resolve the step with `null` (default) or fail the run with a StepError. */
  onTimeout?: "null" | "throw"
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
  /** Park the run until a matching event arrives; resolves with that event (or null on timeout). */
  readonly waitForEvent: (
    name: string,
    opts: WaitForEventOptions,
  ) => Effect.Effect<EventPayload | null, StepperPark | StepError | StorageError, never>
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
        const stepKey = `${runId}:${indexedName}`
        const maxAttempts = opts?.maxAttempts ?? 3

        const existing = yield* storage.getStep(runId, indexedName)

        // Already completed — return memoized output and continue handler
        if (Option.isSome(existing) && existing.value.status === "completed") {
          return Option.getOrNull(existing.value.output) as A
        }

        const prevAttempt = Option.isSome(existing) ? existing.value.attempt : 0
        const attempt = prevAttempt + 1

        if (Option.isNone(existing)) {
          yield* storage.createStep({
            id: randomUUID(),
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
          yield* storage.updateStep(stepKey, {
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
          yield* storage.updateStep(stepKey, {
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
        yield* storage.updateStep(stepKey, {
          status: "completed",
          completedAt: Option.some(new Date()),
          output: Option.some(fnResult.right),
        })

        return yield* Effect.fail(new StepperPark({ reason: "step-completed" }))
      }),

    sleep: (name: string, duration: Duration.Duration) =>
      Effect.gen(function* () {
        const indexedName = getIndexedName(name)
        const stepKey = `${runId}:${indexedName}`

        const existing = yield* storage.getStep(runId, indexedName)

        // Already completed — return void and continue handler
        if (Option.isSome(existing) && existing.value.status === "completed") {
          return
        }

        // Record the sleep step as completed
        if (Option.isNone(existing)) {
          yield* storage.createStep({
            id: randomUUID(),
            runId,
            name: indexedName,
            status: "completed",
            attempt: 1,
            maxAttempts: 1,
            startedAt: Option.some(new Date()),
            completedAt: Option.some(new Date()),
            output: Option.none(),
            error: Option.none(),
          })
        } else {
          yield* storage.updateStep(stepKey, {
            status: "completed",
            completedAt: Option.some(new Date()),
          })
        }

        const retryAfter = new Date(Date.now() + Duration.toMillis(duration))
        return yield* Effect.fail(new StepperPark({ reason: "sleep", retryAfter }))
      }),

    waitForEvent: (name: string, opts: WaitForEventOptions) =>
      Effect.gen(function* () {
        const indexedName = getIndexedName(name)
        const stepKey = `${runId}:${indexedName}`
        const onTimeout = opts.onTimeout ?? "null"

        const existing = yield* storage.getStep(runId, indexedName)

        // Already resolved (by a matching event or a memoised timeout)
        if (Option.isSome(existing) && existing.value.status === "completed") {
          return Option.getOrNull(existing.value.output) as EventPayload | null
        }

        const startedAt = Option.isSome(existing)
          ? Option.getOrElse(existing.value.startedAt, () => new Date())
          : new Date()
        // Derived from the step's persisted start time so it is stable across replays/crashes
        const timeoutAt =
          opts.timeout === undefined ? null : new Date(startedAt.getTime() + Duration.toMillis(opts.timeout))

        if (Option.isNone(existing)) {
          yield* storage.createStep({
            id: randomUUID(),
            runId,
            name: indexedName,
            status: "running",
            attempt: 1,
            maxAttempts: 1,
            startedAt: Option.some(startedAt),
            completedAt: Option.none(),
            output: Option.none(),
            error: Option.none(),
          })
        } else if (timeoutAt !== null && timeoutAt.getTime() <= Date.now()) {
          // Replayed after the timeout elapsed without a matching event
          if (onTimeout === "throw") {
            const message = `Timed out waiting for event "${opts.event}"`
            yield* storage.updateStep(stepKey, {
              status: "failed",
              completedAt: Option.some(new Date()),
              error: Option.some(message),
            })
            return yield* Effect.fail(new StepError({ stepName: indexedName, cause: message, attempt: 1 }))
          }
          yield* storage.updateStep(stepKey, {
            status: "completed",
            completedAt: Option.some(new Date()),
            output: Option.some(null),
          })
          return yield* Effect.fail(new StepperPark({ reason: "step-completed" }))
        }

        const waitingFor: WaitingFor = {
          event: opts.event,
          stepName: indexedName,
          ...(opts.match !== undefined ? { match: opts.match } : {}),
          timeoutAt,
          onTimeout,
        }
        return yield* Effect.fail(new StepperPark({ reason: "wait", waitingFor }))
      }),
  }
}
