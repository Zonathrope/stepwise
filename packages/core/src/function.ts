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

export interface StepperFunction<TData = unknown, TError = never, TRequirements = never> {
  readonly name: string
  readonly event: string
  readonly handler: FunctionHandler<TData, TError, TRequirements>
  readonly concurrency?: number
}

export const defineFunction = <TData = unknown, TError = never, TRequirements = never>(
  def: StepperFunction<TData, TError, TRequirements>,
): StepperFunction<TData, TError, TRequirements> => def
