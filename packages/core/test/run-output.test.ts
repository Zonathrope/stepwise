import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  StepError,
  defineFunction,
  dispatchEvent,
  executeRun,
  type FailureContext,
  type StepperFunction,
} from "../src/index.js"
import { createTestRunner } from "../src/testing.js"

const makeEvent = (name: string, data: unknown) => ({
  id: crypto.randomUUID(),
  name,
  data,
  timestamp: new Date(),
})

const setup = (fn: StepperFunction<any, any, never>) => {
  const rt = ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive([fn])))
  return <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> => rt.runPromise(eff)
}

// Dispatch an event and drive the resulting run until it leaves pending/retrying
const dispatchAndDrive = (name: string, data: unknown) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const [{ runId }] = (yield* dispatchEvent(makeEvent(name, data))) as [{ runId: string }]
    for (let i = 0; i < 50; i++) {
      const run = Option.getOrThrow(yield* storage.getRun(runId))
      if (run.status !== "pending" && run.status !== "retrying") return run
      yield* executeRun(runId)
    }
    throw new Error("run did not settle")
  })

describe("run output", () => {
  it("stores the handler's return value as the run output", async () => {
    const fn = defineFunction<{ n: number }>({
      name: "double",
      event: "num",
      handler: (event, step) =>
        Effect.gen(function* () {
          const doubled = yield* step.run("double", () => event.data.n * 2)
          return { doubled }
        }),
    })
    const { run } = await createTestRunner(fn, Layer.empty).send({ name: "num", data: { n: 21 } })
    expect(run.status).toBe("completed")
    expect(Option.getOrNull(run.output)).toEqual({ doubled: 42 })
  })

  it("stores no output when the handler returns nothing", async () => {
    const fn = defineFunction({ name: "noop", event: "noop", handler: () => Effect.void })
    const { run } = await createTestRunner(fn, Layer.empty).send({ name: "noop", data: {} })
    expect(run.status).toBe("completed")
    expect(Option.isNone(run.output)).toBe(true)
  })

  it("leaves output empty on failure", async () => {
    const fn = defineFunction({
      name: "boom",
      event: "boom",
      handler: (_e, step) =>
        step.run("explode", () => {
          throw new Error("nope")
        }, { maxAttempts: 1 }),
    })
    const { run } = await createTestRunner(fn, Layer.empty).send({ name: "boom", data: {} })
    expect(run.status).toBe("failed")
    expect(Option.isNone(run.output)).toBe(true)
  })
})

describe("onFailure", () => {
  it("is invoked once, after step retries are exhausted, with the failing event and error", async () => {
    const calls: FailureContext<{ orderId: string }>[] = []
    let attempts = 0
    const fn = defineFunction<{ orderId: string }>({
      name: "charge",
      event: "order.placed",
      handler: (_e, step) =>
        step.run("charge-card", () => {
          attempts++
          throw new Error("card declined")
        }, { maxAttempts: 3 }),
      onFailure: (ctx) => Effect.sync(() => void calls.push(ctx)),
    })
    const run = await setup(fn)(dispatchAndDrive("order.placed", { orderId: "o-1" }))

    expect(run.status).toBe("failed")
    expect(attempts).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.runId).toBe(run.id)
    expect(calls[0]!.functionName).toBe("charge")
    expect(calls[0]!.event.data).toEqual({ orderId: "o-1" })
    expect(calls[0]!.error).toBeInstanceOf(StepError)
  })

  it("is not invoked when the run completes", async () => {
    let called = false
    const fn = defineFunction({
      name: "ok",
      event: "ok",
      handler: () => Effect.succeed("fine"),
      onFailure: () => Effect.sync(() => { called = true }),
    })
    const run = await setup(fn)(dispatchAndDrive("ok", {}))
    expect(run.status).toBe("completed")
    expect(called).toBe(false)
  })

  it("does not change the run's terminal state when onFailure itself fails", async () => {
    const fn = defineFunction({
      name: "double-fault",
      event: "df",
      handler: () => Effect.fail("handler error"),
      onFailure: () => Effect.die(new Error("onFailure blew up")),
    })
    const run = await setup(fn)(dispatchAndDrive("df", {}))
    expect(run.status).toBe("failed")
    expect(Option.getOrNull(run.error)).toBe("handler error")
  })

  it("is skipped if the run was cancelled while executing", async () => {
    let called = false
    const fn = defineFunction({
      name: "cancelled-mid-run",
      event: "cm",
      handler: () =>
        Effect.gen(function* () {
          const storage = yield* Storage
          // Simulate a cancel landing while the handler is in flight
          const [run] = yield* storage.listRuns({ functionName: "cancelled-mid-run" })
          yield* storage.updateRun(run!.id, { status: "cancelled" })
          return yield* Effect.fail("failed after cancel")
        }) as Effect.Effect<never, string, never>,
      onFailure: () => Effect.sync(() => { called = true }),
    })
    const rt = ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive([fn])))
    // Provide Storage to the handler through the same runtime
    const run = await rt.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const [{ runId }] = (yield* dispatchEvent(makeEvent("cm", {}))) as [{ runId: string }]
        yield* executeRun(runId)
        return Option.getOrThrow(yield* storage.getRun(runId))
      }),
    )
    expect(run.status).toBe("cancelled")
    expect(called).toBe(false)
  })
})
