import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  defineFunction,
  dispatchEvent,
  executeRun,
  type EventPayload,
  type StepperFunction,
} from "../src/index.js"

const makeEvent = (name: string, data: unknown): EventPayload => ({
  id: crypto.randomUUID(),
  name,
  data,
  timestamp: new Date(),
})

const setup = (fn: StepperFunction<any, any, never>) => {
  const rt = ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive([fn])))
  return { run: <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> => rt.runPromise(eff) }
}

describe("step.waitForEvent", () => {
  const seen: Array<EventPayload | null> = []
  const fn = defineFunction<{ orderId: string }, never, never>({
    name: "order-flow",
    event: "order.created",
    handler: (event, step) =>
      Effect.gen(function* () {
        const approval = yield* step.waitForEvent("await-approval", {
          event: "approval.received",
          match: { orderId: event.data.orderId },
          timeout: Duration.hours(24),
        })
        seen.push(approval)
        yield* step.run("finish", () => "done")
      }),
  })

  // Drives a run until it stops being pending (or retrying/eligible)
  const drive = (runId: string) =>
    Effect.gen(function* () {
      const storage = yield* Storage
      for (let i = 0; i < 20; i++) {
        const run = Option.getOrThrow(yield* storage.getRun(runId))
        if (run.status !== "pending") return run
        yield* executeRun(runId)
      }
      throw new Error("did not settle")
    })

  it("parks the run as waiting with a waitingFor filter and timeout", async () => {
    const { run } = setup(fn)
    const result = await run(
      Effect.gen(function* () {
        const [{ runId }] = yield* dispatchEvent(makeEvent("order.created", { orderId: "o1" }))
        return yield* drive(runId!)
      }),
    )
    expect(result.status).toBe("waiting")
    const w = Option.getOrThrow(result.waitingFor)
    expect(w.event).toBe("approval.received")
    expect(w.match).toEqual({ orderId: "o1" })
    expect(w.stepName).toBe("await-approval#0")
    expect(Option.getOrThrow(result.retryAfter).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000)
  })

  it("resumes only on a matching event and passes it as the step output", async () => {
    seen.length = 0
    const { run } = setup(fn)
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const [a, b] = [
          (yield* dispatchEvent(makeEvent("order.created", { orderId: "A" })))[0]!.runId,
          (yield* dispatchEvent(makeEvent("order.created", { orderId: "B" })))[0]!.runId,
        ]
        yield* drive(a)
        yield* drive(b)

        // wrong order id and wrong event name must not resume anything
        yield* dispatchEvent(makeEvent("approval.received", { orderId: "other" }))
        yield* dispatchEvent(makeEvent("something.else", { orderId: "A" }))
        expect(Option.getOrThrow(yield* storage.getRun(a)).status).toBe("waiting")

        const approval = makeEvent("approval.received", { orderId: "A" })
        yield* dispatchEvent(approval)
        expect(Option.getOrThrow(yield* storage.getRun(b)).status).toBe("waiting")
        const resumed = Option.getOrThrow(yield* storage.getRun(a))
        expect(resumed.status).toBe("pending")
        expect(Option.isNone(resumed.waitingFor)).toBe(true)

        const final = yield* drive(a)
        expect(final.status).toBe("completed")
        // handler replays after each step, so every observation must be the same event
        expect(seen.length).toBeGreaterThan(0)
        for (const e of seen) expect(e?.id).toBe(approval.id)
        expect((seen[0]?.data as any).orderId).toBe("A")
      }),
    )
  })

  it("resolves with null when the timeout elapses (default)", async () => {
    seen.length = 0
    const short = defineFunction<{}, never, never>({
      name: "short-wait",
      event: "start",
      handler: (_event, step) =>
        Effect.gen(function* () {
          const r = yield* step.waitForEvent("w", { event: "never", timeout: Duration.millis(1) })
          seen.push(r)
        }),
    })
    const { run } = setup(short)
    const final = await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const [{ runId }] = yield* dispatchEvent(makeEvent("start", {}))
        const parked = yield* drive(runId!)
        expect(parked.status).toBe("waiting")
        yield* Effect.sleep("20 millis")
        // Timeout pickup: waiting run with elapsed retryAfter is eligible
        const eligible = yield* storage.listRuns({ eligibleForPickup: true })
        expect(eligible.map((r) => r.id)).toContain(runId)
        // The worker claims the run (-> running) and executes it
        yield* executeRun(runId!)
        return yield* drive(runId!)
      }),
    )
    expect(final.status).toBe("completed")
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((e) => e === null)).toBe(true)
  })

  it("does not make a waiting run eligible before its timeout", async () => {
    const { run } = setup(fn)
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const [{ runId }] = yield* dispatchEvent(makeEvent("order.created", { orderId: "z" }))
        yield* drive(runId!)
        const eligible = yield* storage.listRuns({ eligibleForPickup: true })
        expect(eligible.map((r) => r.id)).not.toContain(runId)
      }),
    )
  })

  it("fails the run with a StepError when onTimeout is 'throw'", async () => {
    const strict = defineFunction<{}, never, never>({
      name: "strict-wait",
      event: "start",
      handler: (_event, step) =>
        step
          .waitForEvent("w", { event: "never", timeout: Duration.millis(1), onTimeout: "throw" })
          .pipe(Effect.asVoid),
    })
    const { run } = setup(strict)
    const final = await run(
      Effect.gen(function* () {
        const [{ runId }] = yield* dispatchEvent(makeEvent("start", {}))
        yield* drive(runId!)
        yield* Effect.sleep("20 millis")
        const storage = yield* Storage
        yield* executeRun(runId!)
        return Option.getOrThrow(yield* storage.getRun(runId!))
      }),
    )
    expect(final.status).toBe("failed")
    expect(Option.getOrThrow(final.error)).toContain("StepError")
  })

  it("waits indefinitely without a timeout (no retryAfter)", async () => {
    const forever = defineFunction<{}, never, never>({
      name: "forever",
      event: "start",
      handler: (_event, step) => step.waitForEvent("w", { event: "go" }).pipe(Effect.asVoid),
    })
    const { run } = setup(forever)
    await run(
      Effect.gen(function* () {
        const [{ runId }] = yield* dispatchEvent(makeEvent("start", {}))
        const parked = yield* drive(runId!)
        expect(parked.status).toBe("waiting")
        expect(Option.isNone(parked.retryAfter)).toBe(true)
        yield* dispatchEvent(makeEvent("go", {}))
        expect((yield* drive(runId!)).status).toBe("completed")
      }),
    )
  })
})
