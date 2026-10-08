import { Effect } from "effect"
import type { StepContext } from "./step-context.js"
import type { EventPayload } from "./schema.js"
import type { StepperPark } from "./errors.js"

export interface FunctionHandler<TData, TError, TRequirements> {
  (
    event: EventPayload & { data: TData },
    step: StepContext,
  ): Effect.Effect<void, TError | StepperPark, TRequirements>
}

/** Any object with a `.parse(data)` that throws on invalid input (Zod, ArkType, Valibot wrappers, ...). */
export interface EventSchema<TData = unknown> {
  parse(data: unknown): TData
}

export interface StepperFunction<TData = unknown, TError = never, TRequirements = never> {
  readonly name: string
  readonly event: string
  readonly handler: FunctionHandler<TData, TError, TRequirements>
  readonly concurrency?: number
  /** Optional validator for `event.data`; checked in `dispatchEvent` before any run is created. */
  readonly schema?: EventSchema<TData>
}

export const defineFunction = <TData = unknown, TError = never, TRequirements = never>(
  def: StepperFunction<TData, TError, TRequirements>,
): StepperFunction<TData, TError, TRequirements> => def
