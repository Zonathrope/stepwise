import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  defineFunction,
  dispatchEvent,
  executeRun,
  type EventPayload,
} from "../src/index.js"

const makeEvent = (id: string, name: string, data: unknown): EventPayload => ({
  id,
  name,
  data,
  timestamp: new Date(),
})

const fn = defineFunction<{ orderId: string }, never, never>({
  name: "order-flow",
  event: "order.created",
  handler: (event, step) =>
    Effect.gen(function* () {
      yield* step.waitForEvent("await-approval", {
        event: "approval.received",
        match: { orderId: event.data.orderId },
      })
    }),
})

const setup = () => {
  const rt = ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive([fn])))
  return <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> => rt.runPromise(eff)
}

const startWaitingRun = (eventId: string) =>
  Effect.gen(function* () {
    const [{ runId }] = (yield* dispatchEvent(makeEvent(eventId, "order.created", { orderId: "o1" }))) as [
      { runId: string },
    ]
    yield* executeRun(runId)
    return runId
  })

const statusOf = (runId: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    return Option.getOrThrow(yield* storage.getRun(runId)).status
  })

describe("event idempotency", () => {
  it("returns the original runs and creates no new ones for a duplicate event id", async () => {
    const run = setup()
    const result = await run(
      Effect.gen(function* () {
        const first = yield* dispatchEvent(makeEvent("evt-1", "order.created", { orderId: "o1" }))
        const second = yield* dispatchEvent(makeEvent("evt-1", "order.created", { orderId: "o1" }))
        const storage = yield* Storage
        const all = yield* storage.listRuns({ eventId: "evt-1" })
        return { first, second, total: all.length }
      }),
    )
    expect(result.total).toBe(1)
    expect(result.second).toEqual(result.first)
  })

  it("does not resume waiting runs again when a resume-only event is resent", async () => {
    const run = setup()
    const result = await run(
      Effect.gen(function* () {
        const runA = yield* startWaitingRun("order-a")
        // No function is triggered by approval.received, so this event creates no runs.
        yield* dispatchEvent(makeEvent("approval-1", "approval.received", { orderId: "o1" }))
        const afterFirst = yield* statusOf(runA)

        // A second run starts waiting after the approval was already delivered once.
        const runB = yield* startWaitingRun("order-b")
        // The same approval is delivered again (e.g. a client retry).
        yield* dispatchEvent(makeEvent("approval-1", "approval.received", { orderId: "o1" }))
        return { afterFirst, runB: yield* statusOf(runB) }
      }),
    )
    expect(result.afterFirst).toBe("pending")
    expect(result.runB).toBe("waiting")
  })
})
