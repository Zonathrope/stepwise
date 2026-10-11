import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  StorageError,
  cronEventId,
  cronTicksBetween,
  defineFunction,
  dispatchCronTicks,
  executeRun,
  nextCronTick,
  parseCron,
  type StepperFunction,
} from "../src/index.js"

const utc = (s: string) => new Date(`${s}Z`)

describe("parseCron / nextCronTick", () => {
  it("parses wildcards, ranges, steps and lists", () => {
    const s = parseCron("*/15 9-17 * * 1-5")
    expect([...s.minutes]).toEqual([0, 15, 30, 45])
    expect([...s.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...s.daysOfWeek]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron("5,10 0 1 1,6 *").months]).toEqual([1, 6])
  })

  it("treats day-of-week 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").daysOfWeek.has(0)).toBe(true)
  })

  it.each([
    ["0 * * *", /expected 5 fields/],
    ["60 * * * *", /out of range/],
    ["*/0 * * * *", /step must be > 0/],
    ["5-1 * * * *", /reversed/],
    ["a * * * *", /bad minute/],
  ])("rejects %s", (expr, msg) => {
    expect(() => parseCron(expr)).toThrow(msg)
  })

  it("finds the next tick strictly after the given time", () => {
    const hourly = parseCron("0 * * * *")
    expect(nextCronTick(hourly, utc("2026-01-01T10:00:00"))).toEqual(utc("2026-01-01T11:00:00"))
    expect(nextCronTick(hourly, utc("2026-01-01T10:59:59"))).toEqual(utc("2026-01-01T11:00:00"))
    expect(nextCronTick(parseCron("30 2 * * *"), utc("2026-12-31T03:00:00"))).toEqual(
      utc("2027-01-01T02:30:00"),
    )
    // 2026-02-01 is a Sunday; first Monday is the 2nd
    expect(nextCronTick(parseCron("0 9 * * 1"), utc("2026-02-01T00:00:00"))).toEqual(
      utc("2026-02-02T09:00:00"),
    )
  })

  it("ORs day-of-month and day-of-week when both are restricted", () => {
    // 1st of the month OR any Friday; 2026-03-06 is a Friday
    const s = parseCron("0 0 1 * 5")
    expect(nextCronTick(s, utc("2026-03-01T00:00:00"))).toEqual(utc("2026-03-06T00:00:00"))
  })

  it("returns null for a schedule that never fires", () => {
    expect(nextCronTick(parseCron("0 0 31 2 *"), utc("2026-01-01T00:00:00"))).toBeNull()
  })

  it("lists ticks in a half-open window", () => {
    const ticks = cronTicksBetween(parseCron("*/20 * * * *"), utc("2026-01-01T10:00:00"), utc("2026-01-01T11:00:00"))
    expect(ticks).toEqual([utc("2026-01-01T10:20:00"), utc("2026-01-01T10:40:00"), utc("2026-01-01T11:00:00")])
  })
})

describe("defineFunction triggers", () => {
  const handler = () => Effect.void
  it("requires exactly one of event or cron", () => {
    expect(() => defineFunction({ name: "x", handler } as never)).toThrow(/exactly one/)
    expect(() => defineFunction({ name: "x", event: "e", cron: "* * * * *", handler } as never)).toThrow(/exactly one/)
  })

  it("rejects an invalid cron expression at definition time", () => {
    expect(() => defineFunction({ name: "x", cron: "every hour", handler })).toThrow(/Invalid cron/)
  })
})

describe("dispatchCronTicks", () => {
  const seen: unknown[] = []
  const hourly = defineFunction({
    name: "hourly-report",
    cron: "0 * * * *",
    handler: (event) =>
      Effect.sync(() => {
        seen.push(event.data)
        return { reported: true }
      }),
  })
  const onEvent = defineFunction({ name: "on-event", event: "user.created", handler: () => Effect.void })

  const setup = (fns: StepperFunction<any, any, never>[], storage = InMemoryStorageLive) =>
    ManagedRuntime.make(Layer.merge(storage, RegistryLive(fns)))

  it("creates one pending run per tick for cron functions only, and the run executes", async () => {
    seen.length = 0
    const rt = setup([hourly, onEvent])
    const created = await rt.runPromise(
      dispatchCronTicks(utc("2026-01-01T09:30:00"), utc("2026-01-01T11:00:00")),
    )
    expect(created.map((c) => [c.functionName, c.scheduledAt])).toEqual([
      ["hourly-report", utc("2026-01-01T10:00:00")],
      ["hourly-report", utc("2026-01-01T11:00:00")],
    ])

    const run = await rt.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* executeRun(created[0]!.runId)
        return Option.getOrThrow(yield* storage.getRun(created[0]!.runId))
      }),
    )
    expect(run.status).toBe("completed")
    expect(run.eventId).toBe(cronEventId("hourly-report", utc("2026-01-01T10:00:00")))
    expect(Option.getOrNull(run.output)).toEqual({ reported: true })
    expect(seen).toEqual([{ cron: "0 * * * *", scheduledAt: "2026-01-01T10:00:00.000Z" }])
  })

  it("fires each tick once across workers with overlapping windows", async () => {
    const rt = setup([hourly])
    const a = await rt.runPromise(dispatchCronTicks(utc("2026-01-01T09:30:00"), utc("2026-01-01T10:30:00")))
    const b = await rt.runPromise(dispatchCronTicks(utc("2026-01-01T09:59:00"), utc("2026-01-01T11:00:00")))
    expect(a).toHaveLength(1)
    expect(b.map((c) => c.scheduledAt)).toEqual([utc("2026-01-01T11:00:00")])
    const runs = await rt.runPromise(Effect.flatMap(Storage, (s) => s.listRuns({ functionName: "hourly-report" })))
    expect(runs).toHaveLength(2)
  })

  it("fires each tick once when workers race on the same window", async () => {
    const rt = setup([hourly])
    const window = [utc("2026-01-01T09:30:00"), utc("2026-01-01T12:00:00")] as const
    const results = await rt.runPromise(
      Effect.all(
        Array.from({ length: 4 }, () => dispatchCronTicks(...window)),
        { concurrency: "unbounded" },
      ),
    )
    expect(results.flat()).toHaveLength(3)
    const runs = await rt.runPromise(Effect.flatMap(Storage, (s) => s.listRuns({ functionName: "hourly-report" })))
    expect(runs).toHaveLength(3)
  })

  it("treats an insert conflict after a stale read as a lost race", async () => {
    // Worker B's existence check runs before worker A commits, so B only learns of A's tick
    // from the conflicting insert. Model that with a storage whose first two reads per id are
    // stale (A's and B's pre-checks); B's re-check after the conflict sees A's event.
    const staleOnce = Layer.effect(
      Storage,
      Effect.map(Storage, (s) => {
        const reads = new Map<string, number>()
        return {
          ...s,
          getEvent: (id: string) => {
            const n = (reads.get(id) ?? 0) + 1
            reads.set(id, n)
            return n <= 2 ? Effect.succeed(Option.none()) : s.getEvent(id)
          },
        }
      }),
    ).pipe(Layer.provide(InMemoryStorageLive))
    const rt = setup([hourly], staleOnce)
    const window = [utc("2026-01-01T09:30:00"), utc("2026-01-01T10:30:00")] as const
    const workerA = await rt.runPromise(dispatchCronTicks(...window))
    const workerB = await rt.runPromise(dispatchCronTicks(...window))
    expect(workerA).toHaveLength(1)
    expect(workerB).toHaveLength(0)
    const runs = await rt.runPromise(Effect.flatMap(Storage, (s) => s.listRuns({ functionName: "hourly-report" })))
    expect(runs).toHaveLength(1)
  })

  it("propagates storage failures that are not a lost race", async () => {
    const failing = Layer.effect(
      Storage,
      Effect.map(Storage, (s) => ({
        ...s,
        saveEventWithRuns: () => Effect.fail(new StorageError({ cause: "db down" })),
      })),
    ).pipe(Layer.provide(InMemoryStorageLive))
    const rt = setup([hourly], failing)
    const exit = await rt.runPromiseExit(
      dispatchCronTicks(utc("2026-01-01T09:30:00"), utc("2026-01-01T10:30:00")),
    )
    expect(exit._tag).toBe("Failure")
  })
})
