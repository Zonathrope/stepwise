import { randomUUID } from "node:crypto"
import { Context, Duration, Effect, Option } from "effect"
import type { EventPayload, WaitingFor } from "./schema.js"
import type { Storage } from "./storage.js"
import { computeBackoffDelay, type BackoffOptions } from "./backoff.js"
import { HandlerVersionMismatchError, StepError, StorageError, StepperPark } from "./errors.js"
import type { StepJournal } from "./journal.js"

export interface StepOptions {
  maxAttempts?: number
  /** Delay strategy between retries. Defaults to immediate. */
  backoff?: BackoffOptions
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
  ) => Effect.Effect<A, StepperPark | StepError | StorageError | HandlerVersionMismatchError, never>
  readonly sleep: (
    name: string,
    duration: Duration.Duration,
  ) => Effect.Effect<void, StepperPark | StorageError | HandlerVersionMismatchError, never>
  /** Park the run until a matching event arrives; resolves with that event (or null on timeout). */
  readonly waitForEvent: (
    name: string,
    opts: WaitForEventOptions,
  ) => Effect.Effect<EventPayload | null, StepperPark | StepError | StorageError | HandlerVersionMismatchError, never>
}

export const StepContext = Context.GenericTag<StepContext>("@integration-stepper/core/StepContext")

/** `journal`, when given, checks each step request against the run's recorded step sequence. */
export const makeStepContext = (runId: string, storage: Storage, journal?: StepJournal): StepContext => {
  // Track call counts per step name for auto-indexing (runId:name#callIndex)
  const callCounts = new Map<string, number>()

  const getIndexedName = (name: string): string => {
    const count = callCounts.get(name) ?? 0
    callCounts.set(name, count + 1)
    return `${name}#${count}`
  }

  // Look up a step and check its key against the run's journal before the caller acts on it
  // (returns a memoised output or runs the step). The read itself has no side effects.
  const loadStep = (key: string) =>
    Effect.zipLeft(storage.getStep(runId, key), journal ? journal.track(key) : Effect.void)

  return {
    runId,

    run: <A>(name: string, fn: () => Promise<A> | A, opts?: StepOptions) =>
      Effect.gen(function* () {
        const indexedName = getIndexedName(name)
        const maxAttempts = opts?.maxAttempts ?? 3

        const existing = yield* loadStep(indexedName)

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
            retryAfter: Option.none(),
          })
        } else {
          yield* storage.updateStep(stepId, {
            status: "running",
            attempt,
            startedAt: Option.some(new Date()),
            retryAfter: Option.none(),
          })
        }

        // Execute the step function
        const fnResult = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn()),
          catch: (cause) => new StepError({ stepName: indexedName, cause, attempt }),
        }).pipe(Effect.either)

        if (fnResult._tag === "Left") {
          const stepError = fnResult.left
          const terminal = attempt >= maxAttempts
          const delayMs = terminal ? 0 : computeBackoffDelay(opts?.backoff, attempt)
          const retryAfter = delayMs > 0 ? new Date(Date.now() + delayMs) : undefined
          yield* storage.updateStep(stepId, {
            status: terminal ? "failed" : "running",
            error: Option.some(String(stepError.cause)),
            retryAfter: Option.fromNullable(retryAfter),
          })
          // Terminal failure — all attempts exhausted
          if (terminal) {
            return yield* Effect.fail(stepError)
          }
          // Attempts remain — re-queue run, delayed if a backoff applies
          return yield* Effect.fail(
            retryAfter
              ? new StepperPark({ reason: "step-retry", retryAfter })
              : new StepperPark({ reason: "step-completed" }),
          )
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

        const existing = yield* loadStep(indexedName)

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
          retryAfter: Option.none(),
        })

        const retryAfter = new Date(Date.now() + Duration.toMillis(duration))
        return yield* Effect.fail(new StepperPark({ reason: "sleep", retryAfter }))
      }),

    waitForEvent: (name: string, opts: WaitForEventOptions) =>
      Effect.gen(function* () {
        const indexedName = getIndexedName(name)
        const onTimeout = opts.onTimeout ?? "null"

        const existing = yield* loadStep(indexedName)

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
            retryAfter: Option.none(),
          })
        } else if (timeoutAt !== null && timeoutAt.getTime() <= Date.now()) {
          // Replayed after the timeout elapsed without a matching event
          if (onTimeout === "throw") {
            const message = `Timed out waiting for event "${opts.event}"`
            yield* storage.updateStep(existing.value.id, {
              status: "failed",
              completedAt: Option.some(new Date()),
              error: Option.some(message),
            })
            return yield* Effect.fail(new StepError({ stepName: indexedName, cause: message, attempt: 1 }))
          }
          yield* storage.updateStep(existing.value.id, {
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
