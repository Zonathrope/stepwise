import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, Option } from "effect"
import { computeBackoffDelay, defineFunction } from "../src/index.js"
import { createTestRunner } from "../src/testing.js"
import { Storage, InMemoryStorageLive } from "../src/storage.js"
import { RegistryLive } from "../src/registry.js"
import { dispatchEvent, executeRun } from "../src/executor.js"

describe("computeBackoffDelay", () => {
  it("immediate / undefined => 0", () => {
    expect(computeBackoffDelay(undefined, 1)).toBe(0)
    expect(computeBackoffDelay({ type: "immediate" }, 5)).toBe(0)
  })
  it("fixed", () => {
    const b = { type: "fixed", initialDelay: "2 seconds" } as const
    expect(computeBackoffDelay(b, 1)).toBe(2000)
    expect(computeBackoffDelay(b, 4)).toBe(2000)
  })
  it("linear", () => {
    const b = { type: "linear", initialDelay: Duration.seconds(1) } as const
    expect([1, 2, 3].map((n) => computeBackoffDelay(b, n))).toEqual([1000, 2000, 3000])
  })
  it("exponential with maxDelay", () => {
    const b = { type: "exponential", initialDelay: "1 second", maxDelay: "5 seconds" } as const
    expect([1, 2, 3, 4, 5].map((n) => computeBackoffDelay(b, n))).toEqual([1000, 2000, 4000, 5000, 5000])
  })
  it("jitter scales delay by random()", () => {
    const b = { type: "exponential", initialDelay: "1 second", jitter: true } as const
    expect(computeBackoffDelay(b, 3, () => 0.5)).toBe(2000)
    expect(computeBackoffDelay(b, 3, () => 0)).toBe(0)
    const d = computeBackoffDelay(b, 3)
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBeLessThan(4000)
  })
})

describe("step.run backoff", () => {
  const makeFn = (backoff: any, failures: number) => {
    let calls = 0
    return defineFunction<{}, never, never>({
      name: "flaky",
      event: "flaky.event",
      handler: (_e, step) =>
        Effect.gen(function* () {
          yield* step.run(
            "work",
            () => {
              if (calls++ < failures) throw new Error("boom")
              return "ok"
            },
            { maxAttempts: 4, backoff },
          )
        }) as any,
    })
  }

  const setup = (fn: ReturnType<typeof makeFn>) =>
    Layer.merge(InMemoryStorageLive, RegistryLive([fn as any]))

  it("sets step and run retryAfter on failure with backoff", async () => {
    const fn = makeFn({ type: "fixed", initialDelay: "10 seconds" }, 1)
    const program = Effect.gen(function* () {
      const storage = yield* Storage
      yield* dispatchEvent({ id: "e1", name: "flaky.event", data: {}, timestamp: new Date() })
      const [run] = yield* storage.listRuns({ functionName: "flaky" })
      const before = Date.now()
      yield* executeRun(run!.id)
      const r1 = yield* storage.getRun(run!.id)
      const s1 = yield* storage.getStep(run!.id, "work#0")
      return { before, r1, s1 }
    }).pipe(Effect.provide(setup(fn)))
    const { before, r1, s1 } = await Effect.runPromise(program as Effect.Effect<any>)
    expect(Option.getOrThrow(r1).status).toBe("retrying")
    const runRetry = Option.getOrThrow(Option.getOrThrow(r1).retryAfter).getTime()
    const stepRetry = Option.getOrThrow(Option.getOrThrow(s1).retryAfter).getTime()
    expect(runRetry).toBeGreaterThanOrEqual(before + 10_000)
    expect(stepRetry).toBe(runRetry)
  })

  it("immediate retry leaves run pending with no retryAfter", async () => {
    const fn = makeFn(undefined, 1)
    const program = Effect.gen(function* () {
      const storage = yield* Storage
      yield* dispatchEvent({ id: "e1", name: "flaky.event", data: {}, timestamp: new Date() })
      const [run] = yield* storage.listRuns({ functionName: "flaky" })
      yield* executeRun(run!.id)
      return yield* storage.getRun(run!.id)
    }).pipe(Effect.provide(setup(fn)))
    const r = Option.getOrThrow(await Effect.runPromise(program as Effect.Effect<any>))
    expect(r.status).toBe("pending")
    expect(Option.isNone(r.retryAfter)).toBe(true)
  })

  it("completes after retries and clears step retryAfter", async () => {
    const fn = makeFn({ type: "exponential", initialDelay: "1 second" }, 2)
    const result = await createTestRunner(fn, Layer.empty as any).send({ name: "flaky.event", data: {} })
    expect(result.run.status).toBe("completed")
    const step = result.steps[0]!
    expect(step.status).toBe("completed")
    expect(step.attempt).toBe(3)
    expect(Option.isNone(step.retryAfter)).toBe(true)
  })

  it("fails terminally without retryAfter when attempts exhausted", async () => {
    const fn = makeFn({ type: "fixed", initialDelay: "1 second" }, 99)
    const result = await createTestRunner(fn, Layer.empty as any).send({ name: "flaky.event", data: {} })
    expect(result.run.status).toBe("failed")
    expect(result.steps[0]!.status).toBe("failed")
    expect(Option.isNone(result.steps[0]!.retryAfter)).toBe(true)
  })
})
