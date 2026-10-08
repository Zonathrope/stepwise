import { Context, Effect, Layer } from "effect"
import type { StepperFunction } from "./function.js"
import { FunctionNotFoundError } from "./errors.js"

export interface Registry {
  readonly register: (fn: StepperFunction<any, any, any>) => void
  readonly get: (name: string) => Effect.Effect<StepperFunction<any, any, any>, FunctionNotFoundError>
  readonly getByEvent: (eventName: string) => StepperFunction<any, any, any>[]
  readonly list: () => StepperFunction<any, any, any>[]
}

export const Registry = Context.GenericTag<Registry>("@integration-stepper/core/Registry")

export const makeRegistry = (fns: StepperFunction<any, any, any>[] = []): Registry => {
  const byName = new Map<string, StepperFunction<any, any, any>>(fns.map((f) => [f.name, f]))
  const byEvent = new Map<string, StepperFunction<any, any, any>[]>()

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

export const RegistryLive = (fns: StepperFunction<any, any, any>[]) =>
  Layer.sync(Registry, () => makeRegistry(fns))
