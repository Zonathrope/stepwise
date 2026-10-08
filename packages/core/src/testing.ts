import { Cause, Effect, Exit, Layer, Option } from "effect"
import type { RunRecord, StepRecord } from "./schema.js"
import type { StepperFunction } from "./function.js"
import { Storage, type Storage as StorageService, InMemoryStorageLive } from "./storage.js"
import { Registry, RegistryLive } from "./registry.js"
import { dispatchEvent, executeRun } from "./executor.js"
import { NonDeterministicHandlerError } from "./errors.js"
import { randomUUID } from "node:crypto"

/**
 * Diff the previous pass's step sequence against the current one. Because each pass
 * replays memoised steps and then advances by one, the previous sequence must be a
 * strict prefix of the current one. Returns a diff string, or null if consistent.
 */
export const diffStepSequences = (
  expected: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
): string | null => {
  const len = Math.max(expected.length, actual.length)
  let firstBad = -1
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      firstBad = i
      break
    }
  }
  if (firstBad === -1) return null
  const lines: string[] = []
  for (let i = 0; i < len; i++) {
    const e = expected[i]
    const a = actual[i]
    if (e === a) lines.push(`  ${i}: ${e}`)
    else {
      if (e !== undefined) lines.push(`- ${i}: ${e}`)
      if (a !== undefined) lines.push(`+ ${i}: ${a}`)
    }
  }
  return lines.join("\n")
}

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
      // Wrap storage so we can record the ordered step names requested on each pass.
      let observed: string[] = []
      const tracking: StorageService = {
        ...storage,
        getStep: (runId, stepKey) => {
          observed.push(stepKey)
          return storage.getStep(runId, stepKey)
        },
      }
      let previous: string[] = []
      let pass = 0
      let maxIterations = 100
      while (
        (currentRun.status === "pending" || currentRun.status === "retrying") &&
        maxIterations-- > 0
      ) {
        observed = []
        pass++
        yield* executeRun(currentRun.id).pipe(Effect.provideService(Storage, tracking))
        const diff = diffStepSequences(previous, observed)
        if (diff !== null) {
          return yield* Effect.fail(
            new NonDeterministicHandlerError({
              functionName: fn.name,
              expected: previous,
              actual: observed,
              pass,
              diff,
            }),
          )
        }
        previous = observed
        const maybeUpdated = yield* storage.getRun(currentRun.id)
        if (Option.isNone(maybeUpdated)) break
        currentRun = maybeUpdated.value
      }

      const steps = yield* storage.listSteps(currentRun.id)
      return { run: currentRun, steps } satisfies TestRunResult
    })

    // Bake fn's R requirements into the handler so the registry sees StepperFunction<_, _, never>.
    // This lets Effect.provide(program, baseLayer) resolve to Effect<_, _, never> without any leakage.
    const wrapped: StepperFunction<TData, TError, never> = {
      ...fn,
      handler: (event, step) => fn.handler(event, step).pipe(Effect.provide(layer)),
    }
    const registryLayer = RegistryLive([wrapped])
    const baseLayer = Layer.merge(InMemoryStorageLive, registryLayer)

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(baseLayer)))
    if (Exit.isSuccess(exit)) return exit.value
    // Surface the typed error itself (not a FiberFailure wrapper) so callers can instanceof it.
    const failure = Cause.failureOption(exit.cause)
    if (Option.isSome(failure)) throw failure.value
    throw Cause.squash(exit.cause)
  },
})
