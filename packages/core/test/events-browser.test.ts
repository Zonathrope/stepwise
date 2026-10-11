import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  defineFunction,
  dispatchEvent,
  type EventPayload,
} from "../src/index.js"

const at = (iso: string, name: string, data: unknown = {}): EventPayload => ({
  id: crypto.randomUUID(),
  name,
  data,
  timestamp: new Date(iso),
})

const fnA = defineFunction({ name: "a", event: "user.created", handler: () => Effect.void })
const fnB = defineFunction({ name: "b", event: "user.created", handler: () => Effect.void })

const setup = () => ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive([fnA, fnB])))

describe("Storage.listEvents", () => {
  it("lists events newest first, filtered by name, with paging", async () => {
    const rt = setup()
    const e1 = at("2026-01-01T00:00:00Z", "user.created")
    const e2 = at("2026-01-02T00:00:00Z", "order.placed")
    const e3 = at("2026-01-03T00:00:00Z", "user.created")
    await rt.runPromise(Effect.forEach([e1, e2, e3], dispatchEvent))

    const page = await rt.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        return {
          all: yield* storage.listEvents(),
          users: yield* storage.listEvents({ name: "user.created" }),
          second: yield* storage.listEvents({ limit: 1, offset: 1 }),
        }
      }),
    )
    expect(page.all.map((e) => e.id)).toEqual([e3.id, e2.id, e1.id])
    expect(page.users.map((e) => e.id)).toEqual([e3.id, e1.id])
    expect(page.second.map((e) => e.id)).toEqual([e2.id])
  })
})

describe("Storage.countRuns by eventId", () => {
  it("counts the runs each event created", async () => {
    const rt = setup()
    const user = at("2026-01-01T00:00:00Z", "user.created")
    const order = at("2026-01-02T00:00:00Z", "order.placed")
    await rt.runPromise(Effect.forEach([user, order], dispatchEvent))

    const counts = await rt.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        return [
          yield* storage.countRuns({ eventId: user.id }),
          yield* storage.countRuns({ eventId: order.id }),
          yield* storage.countRuns({ eventId: user.id, functionName: "a" }),
        ]
      }),
    )
    expect(counts).toEqual([2, 0, 1])
  })
})

describe("event replay", () => {
  it("re-dispatching an event's name and data under a new id creates fresh runs", async () => {
    const rt = setup()
    const original = at("2026-01-01T00:00:00Z", "user.created", { userId: 7 })
    const replayed: EventPayload = { ...original, id: crypto.randomUUID(), timestamp: new Date() }

    const [first, second] = await rt.runPromise(
      Effect.all([dispatchEvent(original), dispatchEvent(replayed)]),
    )
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(second.map((r) => r.runId)).not.toEqual(first.map((r) => r.runId))

    const runs = await rt.runPromise(Effect.flatMap(Storage, (s) => s.listRuns({ eventId: original.id })))
    expect(runs).toHaveLength(2)
  })
})
