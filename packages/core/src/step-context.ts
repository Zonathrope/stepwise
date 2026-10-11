import { randomUUID } from "node:crypto"
import { Context, Duration, Effect, Either, Option } from "effect"
import type { EventPayload, RunRecord, WaitingFor } from "./schema.js"
import type { Storage } from "./storage.js"
import type { Registry } from "./registry.js"
import type { StepperFunction } from "./function.js"
import { computeBackoffDelay, type BackoffOptions } from "./backoff.js"
import { runConcurrencyFor } from "./concurrency.js"
import { StepError, StorageError, StepperPark } from "./errors.js"

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

export interface InvokeOptions<TData> {
  /** The function to run, by reference (typed `data`) or by registered name. */
  function: StepperFunction<TData, any, any> | string
  /** `event.data` for the invoked run. Validated against the function's `schema`, if any. */
  data: TData
  /** Fail the step if the invoked run has not finished in time. Omit to wait indefinitely. */
  timeout?: Duration.DurationInput
}

/** Data of the internal event that reports an invoked run's result to its parent. */
export interface InvokeResultData {
  readonly childRunId: string
  readonly functionName: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly output: unknown
  readonly error: string | null
}

export const INVOKE_RESULT_EVENT = "invoke/result"
/** Deterministic id of the event that starts the run invoked by `parentRunId`'s step `stepKey`. */
export const invokeEventId = (parentRunId: string, stepKey: string) => `invoke:${parentRunId}:${stepKey}`
export const invokeResultEventId = (childRunId: string) => `invoke-result:${childRunId}`

/** A group of named steps for `step.parallel`: each value is a step body, as for `step.run`. */
export type ParallelSteps = Record<string, () => unknown>
export type ParallelResults<T extends ParallelSteps> = { [K in keyof T]: Awaited<ReturnType<T[K]>> }

export interface StepContext {
  readonly runId: string
  readonly run: <A>(
    name: string,
    fn: () => Promise<A> | A,
    opts?: StepOptions,
  ) => Effect.Effect<A, StepperPark | StepError | StorageError, never>
  /**
   * Run several steps concurrently in a single pickup (like `Promise.all` over `step.run`).
   * Keys of `steps` are the step names. Each step is memoised and retried independently with
   * `opts`; the run parks once after the group instead of once per step. Resolves with the
   * outputs keyed like `steps` once all have completed.
   */
  readonly parallel: <T extends ParallelSteps>(
    steps: T,
    opts?: StepOptions,
  ) => Effect.Effect<ParallelResults<T>, StepperPark | StepError | StorageError, never>
  readonly sleep: (
    name: string,
    duration: Duration.Duration,
  ) => Effect.Effect<void, StepperPark | StorageError, never>
  /** Park the run until a matching event arrives; resolves with that event (or null on timeout). */
  readonly waitForEvent: (
    name: string,
    opts: WaitForEventOptions,
  ) => Effect.Effect<EventPayload | null, StepperPark | StepError | StorageError, never>
  /**
   * Run another function as a child run and wait for it. Resolves with the child's output;
   * fails the step (StepError) if the child fails, is cancelled or times out. The parent does
   * not hold a worker slot while waiting.
   */
  readonly invoke: <TOutput = unknown, TData = unknown>(
    name: string,
    opts: InvokeOptions<TData>,
  ) => Effect.Effect<TOutput, StepperPark | StepError | StorageError, never>
}

export const StepContext = Context.GenericTag<StepContext>("@integration-stepper/core/StepContext")

export interface StepContextDeps {
  /** Needed by `step.invoke` to resolve and validate the invoked function. */
  readonly registry?: Registry
}

type StepOutcome<A> =
  | { readonly _tag: "memoised"; readonly value: A }
  | { readonly _tag: "completed"; readonly value: A }
  | { readonly _tag: "retry"; readonly retryAfter: Date | undefined }

export const makeStepContext = (runId: string, storage: Storage, deps: StepContextDeps = {}): StepContext => {
  // Track call counts per step name for auto-indexing (runId:name#callIndex)
  const callCounts = new Map<string, number>()

  const getIndexedName = (name: string): string => {
    const count = callCounts.get(name) ?? 0
    callCounts.set(name, count + 1)
    return `${name}#${count}`
  }

  /**
   * One attempt of a `step.run`-style step under an already assigned key. Never parks itself:
   * reports whether the output was memoised, newly completed, or needs a retry, so callers
   * decide when to park. Fails with StepError once attempts are exhausted.
   */
  const attemptStep = <A>(key: string, fn: () => Promise<A> | A, opts?: StepOptions) =>
    Effect.gen(function* () {
      const maxAttempts = opts?.maxAttempts ?? 3

      const existing = yield* storage.getStep(runId, key)

      // Already completed — return memoized output and continue handler
      if (Option.isSome(existing) && existing.value.status === "completed") {
        return { _tag: "memoised", value: Option.getOrNull(existing.value.output) as A } as StepOutcome<A>
      }

      const prevAttempt = Option.isSome(existing) ? existing.value.attempt : 0
      const attempt = prevAttempt + 1

      const stepId = Option.isSome(existing) ? existing.value.id : randomUUID()
      if (Option.isNone(existing)) {
        yield* storage.createStep({
          id: stepId,
          runId,
          name: key,
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
        catch: (cause) => new StepError({ stepName: key, cause, attempt }),
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
        return { _tag: "retry", retryAfter } as StepOutcome<A>
      }

      yield* storage.updateStep(stepId, {
        status: "completed",
        completedAt: Option.some(new Date()),
        output: Option.some(fnResult.right),
      })
      return { _tag: "completed", value: fnResult.right } as StepOutcome<A>
    })

  const retryPark = (retryAfter: Date | undefined) =>
    retryAfter
      ? new StepperPark({ reason: "step-retry", retryAfter })
      : new StepperPark({ reason: "step-completed" })

  /**
   * Park the run until an event arrives (the body of `step.waitForEvent`, under an assigned
   * key). `resultEventId`, if set, lets the executor resume immediately when the awaited event
   * already exists, closing the race where it arrives before the run is parked.
   */
  const waitStep = (key: string, opts: WaitForEventOptions, resultEventId?: string) =>
    Effect.gen(function* () {
      const onTimeout = opts.onTimeout ?? "null"

      const existing = yield* storage.getStep(runId, key)

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
          name: key,
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
          return yield* Effect.fail(new StepError({ stepName: key, cause: message, attempt: 1 }))
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
        stepName: key,
        ...(opts.match !== undefined ? { match: opts.match } : {}),
        timeoutAt,
        onTimeout,
        ...(resultEventId !== undefined ? { resultEventId } : {}),
      }
      return yield* Effect.fail(new StepperPark({ reason: "wait", waitingFor }))
    })

  return {
    runId,

    run: <A>(name: string, fn: () => Promise<A> | A, opts?: StepOptions) =>
      Effect.gen(function* () {
        const outcome = yield* attemptStep(getIndexedName(name), fn, opts)
        switch (outcome._tag) {
          case "memoised":
            return outcome.value
          case "retry":
            return yield* Effect.fail(retryPark(outcome.retryAfter))
          case "completed":
            // Success — abort the handler to defer remaining steps to the next pickup
            return yield* Effect.fail(new StepperPark({ reason: "step-completed" }))
        }
      }),

    parallel: <T extends ParallelSteps>(steps: T, opts?: StepOptions) =>
      Effect.gen(function* () {
        // Assign keys in declaration order before anything runs, so they are deterministic
        const entries = Object.entries(steps).map(([name, fn]) => ({ name, key: getIndexedName(name), fn }))
        const outcomes = yield* Effect.forEach(
          entries,
          (e) => Effect.either(attemptStep(e.key, e.fn as () => unknown, opts)),
          { concurrency: "unbounded" },
        )

        // Storage errors are not step failures: surface the first one as-is
        const storageError = outcomes.find(
          (o): o is Either.Left<StorageError, never> => Either.isLeft(o) && o.left instanceof StorageError,
        )
        if (storageError) return yield* Effect.fail(storageError.left)

        const failed = outcomes.find(Either.isLeft)
        if (failed) return yield* Effect.fail(failed.left as StepError)

        const settled = outcomes.map((o) => (o as Either.Right<never, StepOutcome<unknown>>).right)
        const retries = settled.flatMap((o) => (o._tag === "retry" ? [o] : []))
        if (retries.length > 0) {
          // Park until the latest requested retry time so every retrying step is due on wake-up
          const times = retries.map((r) => r.retryAfter?.getTime() ?? 0)
          const latest = Math.max(...times)
          return yield* Effect.fail(retryPark(latest > 0 ? new Date(latest) : undefined))
        }
        // One pickup for the whole group: park once if anything ran for the first time
        if (settled.some((o) => o._tag === "completed")) {
          return yield* Effect.fail(new StepperPark({ reason: "step-completed" }))
        }

        const results: Record<string, unknown> = {}
        entries.forEach((e, i) => {
          results[e.name] = (settled[i] as { value: unknown }).value
        })
        return results as ParallelResults<T>
      }),

    sleep: (name: string, duration: Duration.Duration) =>
      Effect.gen(function* () {
        const indexedName = getIndexedName(name)

        const existing = yield* storage.getStep(runId, indexedName)

        // Already completed — return void and continue handler
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

    waitForEvent: (name: string, opts: WaitForEventOptions) => waitStep(getIndexedName(name), opts),

    invoke: <TOutput = unknown, TData = unknown>(name: string, opts: InvokeOptions<TData>) =>
      Effect.gen(function* () {
        const key = getIndexedName(name)
        const functionName = typeof opts.function === "string" ? opts.function : opts.function.name
        const eventId = invokeEventId(runId, key)
        const fail = (cause: unknown) => Effect.fail(new StepError({ stepName: key, cause, attempt: 1 }))

        const existing = yield* storage.getStep(runId, key)

        if (Option.isNone(existing)) {
          // First execution: start the child run, unless a crashed earlier attempt already did
          if (Option.isNone(yield* storage.getEvent(eventId))) {
            const target = deps.registry?.list().find((f) => f.name === functionName)
            if (!target) return yield* fail(`step.invoke: function "${functionName}" is not registered`)
            try {
              target.schema?.parse(opts.data)
            } catch (err) {
              return yield* fail(err)
            }
            const event: EventPayload = {
              id: eventId,
              name: `invoke/${functionName}`,
              data: opts.data,
              timestamp: new Date(),
            }
            const child: RunRecord = {
              id: randomUUID(),
              functionName,
              eventId,
              status: "pending",
              startedAt: new Date(),
              completedAt: Option.none(),
              error: Option.none(),
              retryAfter: Option.none(),
              waitingFor: Option.none(),
              output: Option.none(),
              concurrency: Option.fromNullable(runConcurrencyFor(functionName, target.concurrency, event)),
            }
            yield* storage.saveEventWithRuns(event, [child])
          }
        }

        const [child] = yield* storage.listRuns({ eventId, limit: 1 })
        if (!child) return yield* fail(`step.invoke: invoked run for "${functionName}" not found`)

        const result = yield* waitStep(
          key,
          {
            event: INVOKE_RESULT_EVENT,
            match: { childRunId: child.id },
            ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
            onTimeout: "throw",
          },
          invokeResultEventId(child.id),
        )
        const data = result?.data as InvokeResultData | undefined
        if (!data) return yield* fail(`step.invoke: no result for invoked run ${child.id}`)
        if (data.status !== "completed") {
          return yield* fail(`Invoked function "${functionName}" (run ${child.id}) ${data.status}: ${data.error ?? ""}`.trim())
        }
        return data.output as TOutput
      }),
  }
}
