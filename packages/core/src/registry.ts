import { Context, Effect, Layer } from "effect"
import type { StepperFunction } from "./function.js"
import { FunctionNotFoundError } from "./errors.js"

export interface Registry {
  readonly register: (fn: StepperFunction<any, any, never>) => void
  readonly get: (name: string) => Effect.Effect<StepperFunction<any, any, never>, FunctionNotFoundError>
  readonly getByEvent: (eventName: string) => StepperFunction<any, any, never>[]
  readonly list: () => StepperFunction<any, any, never>[]
}

export const Registry = Context.GenericTag<Registry>("@integration-stepper/core/Registry")

export const makeRegistry = (fns: StepperFunction<any, any, never>[] = []): Registry => {
  const byName = new Map<string, StepperFunction<any, any, never>>(fns.map((f) => [f.name, f]))
  const byEvent = new Map<string, StepperFunction<any, any, never>[]>()

  for (const fn of fns) {
    const existing = byEvent.get(fn.event) ?? []
    byEvent.set(fn.event, [...existing, fn])
  }

  return {
    register: (fn) => {
      byName.set(fn.name, fn)
      const existing = byEvent.get(fn.event) ?? []
      byEvent.set(fn.event, [...existing, fn])
    },
    get: (name) =>
      Effect.fromNullable(byName.get(name)).pipe(
        Effect.mapError(() => new FunctionNotFoundError({ name })),
      ),
    getByEvent: (eventName) => byEvent.get(eventName) ?? [],
    list: () => Array.from(byName.values()),
  }
}

export const RegistryLive = (fns: StepperFunction<any, any, never>[]) =>
  Layer.sync(Registry, () => makeRegistry(fns))
