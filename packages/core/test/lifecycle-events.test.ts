import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  InMemoryStorageLive,
  RUN_COMPLETED_EVENT,
  RUN_FAILED_EVENT,
  RegistryLive,
  Storage,
  defineFunction,
  dispatchEvent,
  emitLifecycleEvent,
  executeRun,
  lifecycleEventId,
  type EventPayload,
  type RunCompletedEventData,
  type RunFailedEventData,
  type StepperFunction,
  type SuccessContext,
} from "../src/index.js"

const setup = (fns: StepperFunction<any, any, never>[]) => {
  const rt = ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive(fns)))
  const run = <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> => rt.runPromise(eff)
  const send = (name: string, data: unknown) =>
    run(dispatchEvent({ id: crypto.randomUUID(), name, data, timestamp: new Date() }))
  const get = (id: string) => run(Effect.flatMap(Storage, (s) => s.getRun(id)).pipe(Effect.map(Option.getOrThrow)))
  const runsOf = (functionName: string) => run(Effect.flatMap(Storage, (s) => s.listRuns({ functionName })))
  const eventsNamed = (name: string) => run(Effect.flatMap(Storage, (s) => s.listEvents({ name })))
  const getEvent = (id: string) => run(Effect.flatMap(Storage, (s) => s.getEvent(id)).pipe(Effect.map(Option.getOrThrow)))
  /** Act like a worker: execute every pickup-eligible run until nothing is left. */
  const drain = async (max = 100) => {
    for (let i = 0; i < max; i++) {
      const eligible = await run(Effect.flatMap(Storage, (s) => s.listRuns({ eligibleForPickup: true })))
      if (eligible.length === 0) return
      for (const r of eligible) await run(executeRun(r.id))
    }
    throw new Error("runs did not settle")
  }
  return { run, send, get, runsOf, eventsNamed, getEvent, drain }
}

const double = defineFunction<{ n: number }>({
  name: "double",
  event: "num",
  handler: (event, step) => step.run("double", () => ({ doubled: event.data.n * 2 })),
})

const broken = defineFunction({
  name: "broken",
  event: "boom",
  handler: (_e, step) =>
    step.run("explode", () => {
      throw new Error("nope")
    }, { maxAttempts: 1 }),
})

/** Records every lifecycle event it is triggered by. */
const listener = (name: string, event: string, seen: EventPayload[]) =>
  defineFunction({
    name,
    event,
    handler: (e, step) => step.run("notify", () => void seen.push(e)),
  })

describe("run lifecycle events", () => {
  it("dispatches stepwise/run.completed with the run's output when a run completes", async () => {
    const seen: EventPayload[] = []
    const t = setup([double, listener("on-completed", RUN_COMPLETED_EVENT, seen)])
    const [{ runId }] = (await t.send("num", { n: 21 })) as [{ runId: string }]
    await t.drain()

    const run = await t.get(runId)
    expect(run.status).toBe("completed")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.id).toBe(lifecycleEventId(runId, "completed", Option.getOrThrow(run.completedAt)))
    expect(seen[0]!.data).toEqual({
      runId,
      functionName: "double",
      eventId: run.eventId,
      output: { doubled: 42 },
    } satisfies RunCompletedEventData)
    const [listenerRun] = await t.runsOf("on-completed")
    expect(listenerRun!.status).toBe("completed")
  })

  it("dispatches stepwise/run.failed with the run's error when a run fails", async () => {
    const seen: EventPayload[] = []
    const completed: EventPayload[] = []
    const t = setup([
      broken,
      listener("on-failed", RUN_FAILED_EVENT, seen),
      listener("on-completed", RUN_COMPLETED_EVENT, completed),
    ])
    const [{ runId }] = (await t.send("boom", {})) as [{ runId: string }]
    await t.drain()

    const run = await t.get(runId)
    expect(run.status).toBe("failed")
    expect(seen).toHaveLength(1)
    const data = seen[0]!.data as RunFailedEventData
    expect(data).toEqual({ runId, functionName: "broken", eventId: run.eventId, error: Option.getOrThrow(run.error) })
    expect(data.error).toContain('step "explode#0" failed (attempt 1): nope')
    // The failure is the only lifecycle event: the listener's own completion doesn't emit one
    expect(completed).toHaveLength(0)
  })

  it("does not emit lifecycle events for runs triggered by a lifecycle event (no loop)", async () => {
    const seen: EventPayload[] = []
    // Listens to completions of every run, including (it would be) its own
    const t = setup([double, listener("on-completed", RUN_COMPLETED_EVENT, seen)])
    await t.send("num", { n: 1 })
    await t.drain()

    expect(seen).toHaveLength(1)
    expect((seen[0]!.data as RunCompletedEventData).functionName).toBe("double")
    expect(await t.eventsNamed(RUN_COMPLETED_EVENT)).toHaveLength(1)
    expect(await t.runsOf("on-completed")).toHaveLength(1)
  })

  it("does not loop through a child run that a lifecycle handler invokes", async () => {
    const seen: EventPayload[] = []
    const child = defineFunction({
      name: "child",
      event: "never.sent",
      handler: (_e, step) => step.run("work", () => "child-done"),
    })
    const notifier = defineFunction({
      name: "notifier",
      event: RUN_COMPLETED_EVENT,
      handler: (e, step) =>
        Effect.gen(function* () {
          seen.push(e)
          return yield* step.invoke("call-child", { function: child, data: {} })
        }),
    })
    const t = setup([double, child, notifier])
    await t.send("num", { n: 2 })
    await t.drain()

    const [childRun] = await t.runsOf("child")
    expect(childRun!.status).toBe("completed")
    // Only "double" completing emitted an event: not the notifier, nor the child it invoked
    expect(new Set(seen.map((e) => (e.data as RunCompletedEventData).functionName))).toEqual(new Set(["double"]))
    expect(await t.eventsNamed(RUN_COMPLETED_EVENT)).toHaveLength(1)
  })

  it("stores no lifecycle event when nothing listens for it", async () => {
    const t = setup([double, broken])
    await t.send("num", { n: 3 })
    await t.send("boom", {})
    await t.drain()
    expect(await t.eventsNamed(RUN_COMPLETED_EVENT)).toHaveLength(0)
    expect(await t.eventsNamed(RUN_FAILED_EVENT)).toHaveLength(0)
  })

  it("is idempotent: re-emitting the same transition creates no new runs", async () => {
    const seen: EventPayload[] = []
    const t = setup([double, listener("on-completed", RUN_COMPLETED_EVENT, seen)])
    const [{ runId }] = (await t.send("num", { n: 4 })) as [{ runId: string }]
    await t.drain()

    const run = await t.get(runId)
    const event = await t.getEvent(run.eventId)
    const again = await t.run(
      emitLifecycleEvent(run, event, { status: "completed", output: null }, Option.getOrThrow(run.completedAt)),
    )
    await t.drain()

    const [original] = await t.runsOf("on-completed")
    expect(again).toEqual([{ runId: original!.id, functionName: "on-completed" }])
    expect(await t.runsOf("on-completed")).toHaveLength(1)
    expect(seen).toHaveLength(1)
  })

  it("emits again when a retried run fails a second time", async () => {
    const seen: EventPayload[] = []
    const t = setup([broken, listener("on-failed", RUN_FAILED_EVENT, seen)])
    const [{ runId }] = (await t.send("boom", {})) as [{ runId: string }]
    await t.drain()

    // Simulate POST /api/runs/:id/retry: reset the failed step and re-queue the run
    await t.run(
      Effect.gen(function* () {
        const storage = yield* Storage
        for (const step of yield* storage.listSteps(runId)) {
          yield* storage.updateStep(step.id, { status: "pending", attempt: 0, error: Option.none() })
        }
        yield* storage.transitionRun(runId, ["failed"], { status: "pending", completedAt: Option.none(), error: Option.none() })
      }),
    )
    await new Promise((r) => setTimeout(r, 2)) // distinct completedAt
    await t.drain()

    expect(seen).toHaveLength(2)
    expect(new Set(seen.map((e) => e.id)).size).toBe(2)
  })

  it("does not emit when the run left running before it finished (lost transition)", async () => {
    const seen: EventPayload[] = []
    const racer = defineFunction({
      name: "racer",
      event: "race",
      handler: () =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const [run] = yield* storage.listRuns({ functionName: "racer" })
          // Another actor (e.g. crash recovery) moved the run while the handler ran
          yield* storage.updateRun(run!.id, { status: "pending" })
          return "done"
        }) as Effect.Effect<string, never, never>,
    })
    const t = setup([racer, listener("on-completed", RUN_COMPLETED_EVENT, seen)])
    const [{ runId }] = (await t.send("race", {})) as [{ runId: string }]
    const result = await t.run(executeRun(runId))

    expect(result.status).toBe("running")
    expect((await t.get(runId)).status).toBe("pending")
    expect(await t.eventsNamed(RUN_COMPLETED_EVENT)).toHaveLength(0)
  })

  it("reports the runs it created from executeRun, so the worker can wake others", async () => {
    const t = setup([double, listener("on-completed", RUN_COMPLETED_EVENT, [])])
    const [{ runId }] = (await t.send("num", { n: 5 })) as [{ runId: string }]
    let result = await t.run(executeRun(runId))
    while (result.status === "pending") result = await t.run(executeRun(runId))

    expect(result.status).toBe("completed")
    expect(result.dispatched).toHaveLength(1)
    expect(result.dispatched[0]!.functionName).toBe("on-completed")
  })

  it("logs and swallows a dispatch failure (a listener's schema rejects the data)", async () => {
    const strict = defineFunction({
      name: "strict",
      event: RUN_COMPLETED_EVENT,
      schema: { parse: () => { throw new Error("rejected") } },
      handler: () => Effect.void,
    })
    const t = setup([double, strict])
    const [{ runId }] = (await t.send("num", { n: 6 })) as [{ runId: string }]
    await t.drain()
    expect((await t.get(runId)).status).toBe("completed")
    expect(await t.runsOf("strict")).toHaveLength(0)
  })
})

describe("onSuccess", () => {
  it("is called once with the output when a run completes, and not on failure", async () => {
    const calls: SuccessContext<{ n: number }>[] = []
    let failedCalls = 0
    const fn = defineFunction<{ n: number }>({
      name: "ok",
      event: "num",
      handler: (event, step) => step.run("double", () => event.data.n * 2),
      onSuccess: (ctx) => Effect.sync(() => void calls.push(ctx)),
    })
    const bad = defineFunction({ ...broken, onSuccess: () => Effect.sync(() => void failedCalls++) })
    const t = setup([fn, bad])
    const [{ runId }] = (await t.send("num", { n: 7 })) as [{ runId: string }]
    await t.send("boom", {})
    await t.drain()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ runId, functionName: "ok", output: 14 })
    expect(calls[0]!.event.data).toEqual({ n: 7 })
    expect(failedCalls).toBe(0)
  })

  it("does not change the run's state when onSuccess itself fails", async () => {
    const fn = defineFunction({
      name: "ok",
      event: "ok",
      handler: () => Effect.succeed("fine"),
      onSuccess: () => Effect.die(new Error("onSuccess blew up")),
    })
    const t = setup([fn])
    const [{ runId }] = (await t.send("ok", {})) as [{ runId: string }]
    await t.drain()
    const run = await t.get(runId)
    expect(run.status).toBe("completed")
    expect(Option.getOrNull(run.output)).toBe("fine")
  })
})
