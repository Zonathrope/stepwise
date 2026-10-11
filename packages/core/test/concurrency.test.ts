import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  defineFunction,
  dispatchEvent,
  runConcurrencyFor,
  selectClaimable,
  type EventPayload,
} from "../src/index.js"

const event = (data: unknown): EventPayload => ({
  id: crypto.randomUUID(),
  name: "order.placed",
  data,
  timestamp: new Date(),
})

describe("runConcurrencyFor", () => {
  it("returns null when the function has no limit", () => {
    expect(runConcurrencyFor("f", undefined, event({}))).toBeNull()
  })

  it("uses one function-wide bucket for a numeric limit", () => {
    expect(runConcurrencyFor("f", 3, event({ userId: 1 }))).toEqual({ key: "f", limit: 3 })
    expect(runConcurrencyFor("f", { limit: 2 }, event({}))).toEqual({ key: "f", limit: 2 })
  })

  it("partitions by the value at the key path", () => {
    const opt = { limit: 1, key: "data.user.id" }
    expect(runConcurrencyFor("f", opt, event({ user: { id: 7 } }))).toEqual({ key: "f:7", limit: 1 })
    expect(runConcurrencyFor("f", opt, event({ user: { id: "7" } }))).toEqual({ key: 'f:"7"', limit: 1 })
    expect(runConcurrencyFor("f", { limit: 1, key: "event.data.user.id" }, event({ user: { id: 7 } }))).toEqual({
      key: "f:7",
      limit: 1,
    })
  })

  it("puts runs with a missing key value in one shared bucket", () => {
    const opt = { limit: 1, key: "data.userId" }
    expect(runConcurrencyFor("f", opt, event({}))).toEqual({ key: "f:null", limit: 1 })
    expect(runConcurrencyFor("f", opt, event(null))).toEqual({ key: "f:null", limit: 1 })
  })
})

describe("defineFunction concurrency validation", () => {
  const handler = () => Effect.void
  it.each([0, -1, 1.5])("rejects limit %s", (limit) => {
    expect(() => defineFunction({ name: "f", event: "e", handler, concurrency: limit })).toThrow(/positive integer/)
    expect(() => defineFunction({ name: "f", event: "e", handler, concurrency: { limit, key: "data.x" } })).toThrow(
      /positive integer/,
    )
  })

  it("rejects an empty key", () => {
    expect(() => defineFunction({ name: "f", event: "e", handler, concurrency: { limit: 1, key: " " } })).toThrow(
      /non-empty dotted path/,
    )
  })
})

describe("selectClaimable", () => {
  const run = (id: string, key?: string, limit = 1) => ({
    id,
    concurrency: key ? { key, limit } : null,
  })

  it("claims at most `limit` runs per key and skips past saturated keys", () => {
    const candidates = [run("a1", "u:A"), run("a2", "u:A"), run("b1", "u:B"), run("free")]
    expect(selectClaimable(candidates, new Map(), 10)).toEqual({ claim: ["a1", "b1", "free"], heldBack: 1 })
  })

  it("counts runs already executing on other workers", () => {
    const candidates = [run("a1", "u:A", 2), run("a2", "u:A", 2), run("b1", "u:B", 2)]
    expect(selectClaimable(candidates, new Map([["u:A", 1]]), 10)).toEqual({ claim: ["a1", "b1"], heldBack: 1 })
  })

  it("respects the worker's free slots", () => {
    const candidates = [run("x"), run("y"), run("z")]
    expect(selectClaimable(candidates, new Map(), 2).claim).toEqual(["x", "y"])
  })
})

describe("dispatchEvent", () => {
  it("records each run's concurrency bucket", async () => {
    const perUser = defineFunction({
      name: "per-user",
      event: "order.placed",
      concurrency: { limit: 1, key: "data.userId" },
      handler: () => Effect.void,
    })
    const unlimited = defineFunction({ name: "unlimited", event: "order.placed", handler: () => Effect.void })
    const rt = ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive([perUser, unlimited])))

    const runs = await rt.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const created = yield* dispatchEvent(event({ userId: 42 }))
        return yield* Effect.forEach(created, (c) =>
          storage.getRun(c.runId).pipe(Effect.map((r) => [c.functionName, Option.getOrThrow(r).concurrency] as const)),
        )
      }),
    )
    expect(Object.fromEntries(runs.map(([name, c]) => [name, Option.getOrNull(c)]))).toEqual({
      "per-user": { key: "per-user:42", limit: 1 },
      unlimited: null,
    })
  })
})
