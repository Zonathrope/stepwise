import { Effect, Layer, Option } from "effect"
import type { RunRecord, StepRecord } from "./schema.js"
import type { StepperFunction } from "./function.js"
import { Storage, InMemoryStorageLive } from "./storage.js"
import { Registry, RegistryLive } from "./registry.js"
import { dispatchEvent, executeRun } from "./executor.js"
import { randomUUID } from "node:crypto"

export interface TestRunResult {
  run: RunRecord
  steps: StepRecord[]
}

export const createTestRunner = <TData, TError, R>(
  fn: StepperFunction<TData, TError, R>,
  layer: Layer.Layer<R>,
) => ({
  send: async (event: { name: string; data: TData }): Promise<TestRunResult> => {
    const eventPayload = {
      id: randomUUID(),
      name: event.name,
      data: event.data,
      timestamp: new Date(),
    }

    const program = Effect.gen(function* () {
      const storage = yield* Storage

      // Dispatch the event — creates run records with status "pending"
      yield* dispatchEvent(eventPayload)

      // Find the run that was created for our function
      const runs = yield* storage.listRuns({ functionName: fn.name })
      const run = runs[0]
      if (!run) {
        return yield* Effect.die(new Error(`No run created for function "${fn.name}"`))
      }

      // Drive the run to completion by replaying until it reaches a terminal state
      let currentRun: RunRecord = run
      let maxIterations = 100
      while (
        (currentRun.status === "pending" || currentRun.status === "retrying") &&
        maxIterations-- > 0
      ) {
        yield* executeRun(currentRun.id)
        const maybeUpdated = yield* storage.getRun(currentRun.id)
        if (Option.isNone(maybeUpdated)) break
        currentRun = maybeUpdated.value
      }

      const steps = yield* storage.listSteps(currentRun.id)
      return { run: currentRun, steps } satisfies TestRunResult
    })

    const registryLayer = RegistryLive([fn as StepperFunction<any, any, any>])
    const baseLayer = Layer.merge(InMemoryStorageLive, registryLayer)
    const fullLayer = Layer.merge(baseLayer, layer as Layer.Layer<never>)

    const runnable = program.pipe(
      Effect.provide(fullLayer),
    ) as unknown as Effect.Effect<TestRunResult, never, never>

    return Effect.runPromise(runnable)
  },
})
