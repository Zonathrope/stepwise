import { Effect, type Layer } from "effect"
import type { StepContext } from "./step-context.js"
import type { EventPayload } from "./schema.js"
import type { StepperPark } from "./errors.js"
import { parseCron } from "./cron.js"

/**
 * A handler's success value becomes the run's `output` once the run completes, so it should be
 * JSON-serialisable. Returning nothing stores a null output.
 */
export interface FunctionHandler<TData, TError, TRequirements> {
  (
    event: EventPayload & { data: TData },
    step: StepContext,
  ): Effect.Effect<unknown, TError | StepperPark, TRequirements>
}

/** Context passed to `onFailure` when a run fails terminally. */
export interface FailureContext<TData> {
  readonly runId: string
  readonly functionName: string
  readonly event: EventPayload & { data: TData }
  /** The error that failed the run (e.g. a `StepError` once a step exhausts its attempts). */
  readonly error: unknown
}

/** `event.data` for runs created by a cron trigger. */
export interface CronEventData {
  readonly cron: string
  /** ISO timestamp of the tick this run was scheduled for. */
  readonly scheduledAt: string
}

/** Any object with a `.parse(data)` that throws on invalid input (Zod, ArkType, Valibot wrappers, ...). */
export interface EventSchema<TData = unknown> {
  parse(data: unknown): TData
}

interface StepperFunctionBase<TData, TError, TRequirements> {
  readonly name: string
  readonly handler: FunctionHandler<TData, TError, TRequirements>
  readonly concurrency?: number
  /** Optional validator for `event.data`; checked in `dispatchEvent` before any run is created. */
  readonly schema?: EventSchema<TData>
  /**
   * Called once when a run of this function fails terminally (not on retried step attempts,
   * not on cancellation). Errors it raises are logged and otherwise ignored.
   */
  readonly onFailure?: ((ctx: FailureContext<TData>) => Effect.Effect<unknown, unknown, TRequirements>) | undefined
}

/**
 * A function is triggered either by an event name or by a 5-field UTC cron schedule
 * (e.g. `"0 * * * *"`), never both.
 */
export type StepperFunction<TData = unknown, TError = never, TRequirements = never> =
  StepperFunctionBase<TData, TError, TRequirements> &
    (
      | { readonly event: string; readonly cron?: undefined }
      | { readonly cron: string; readonly event?: undefined }
    )

export const defineFunction = <TData = unknown, TError = never, TRequirements = never>(
  def: StepperFunction<TData, TError, TRequirements>,
): StepperFunction<TData, TError, TRequirements> => {
  const hasEvent = typeof def.event === "string"
  const hasCron = typeof def.cron === "string"
  if (hasEvent === hasCron) {
    throw new Error(`Function "${def.name}" must define exactly one of "event" or "cron"`)
  }
  // Fail fast on a malformed schedule instead of at the first scheduler tick
  if (hasCron) parseCron(def.cron!)
  return def
}

/**
 * Bake a function's requirements into its handler and onFailure, so it can be registered as a
 * `StepperFunction<_, _, never>` and executed without leaking `R`.
 */
export const provideFunctionLayer = <TData, TError, R>(
  fn: StepperFunction<TData, TError, R>,
  layer: Layer.Layer<R>,
): StepperFunction<TData, TError, never> => {
  const { onFailure } = fn
  return {
    ...fn,
    handler: (event, step) => fn.handler(event, step).pipe(Effect.provide(layer)),
    onFailure: onFailure && ((ctx) => onFailure(ctx).pipe(Effect.provide(layer))),
  }
}
