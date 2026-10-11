import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  defineFunction,
  dispatchEvent,
  executeRun,
  notifyInvoker,
  type RunRecord,
  type StepperFunction,
} from "../src/index.js"

const setup = (fns: StepperFunction<any, any, never>[]) => {
  const rt = ManagedRuntime.make(Layer.merge(InMemoryStorageLive, RegistryLive(fns)))
  const run = <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> => rt.runPromise(eff)
  const send = (name: string, data: unknown) =>
    run(dispatchEvent({ id: crypto.randomUUID(), name, data, timestamp: new Date() }))
  const get = (id: string) => run(Effect.flatMap(Storage, (s) => s.getRun(id)).pipe(Effect.map(Option.getOrThrow)))
  const runsOf = (functionName: string) => run(Effect.flatMap(Storage, (s) => s.listRuns({ functionName })))
  /** Act like a worker: execute every pickup-eligible run until nothing is left (or max passes). */
  const drain = async (max = 100) => {
    let executions = 0
    for (let i = 0; i < max; i++) {
      const eligible = await run(Effect.flatMap(Storage, (s) => s.listRuns({ eligibleForPickup: true })))
      if (eligible.length === 0) return executions
      for (const r of eligible) {
        await run(executeRun(r.id))
        executions++
      }
    }
    return executions
  }
  return { run, send, get, runsOf, drain }
}

describe("step.invoke", () => {
  const child = defineFunction<{ n: number }>({
    name: "square",
    event: "never.sent",
    handler: (event, step) => step.run("square", () => event.data.n * event.data.n),
  })
  const flaky = defineFunction<{ n: number }>({
    name: "flaky",
    event: "never.sent",
    handler: (_e, step) =>
      step.run("explode", () => {
        throw new Error("child broke")
      }, { maxAttempts: 1 }),
  })
  const parent = (target: StepperFunction<any, any, never> | string, extra: object = {}) =>
    defineFunction<{ n: number }>({
      name: "parent",
      event: "go",
      handler: (event, step) =>
        Effect.gen(function* () {
          const squared = yield* step.invoke<number>("call-child", { function: target as any, data: { n: event.data.n }, ...extra })
          const plusOne = yield* step.run("plus-one", () => squared + 1)
          return { squared, plusOne }
        }),
    })

  it("runs the child and resumes the parent with its output", async () => {
    const t = setup([parent(child), child])
    const [{ runId }] = (await t.send("go", { n: 7 })) as [{ runId: string }]
    await t.drain()

    const p = await t.get(runId)
    expect(p.status).toBe("completed")
    expect(Option.getOrNull(p.output)).toEqual({ squared: 49, plusOne: 50 })
    const [c] = await t.runsOf("square")
    expect(c!.status).toBe("completed")
    expect(c!.eventId).toBe(`invoke:${runId}:call-child#0`)
  })

  it("accepts the function by name", async () => {
    const t = setup([parent("square"), child])
    const [{ runId }] = (await t.send("go", { n: 3 })) as [{ runId: string }]
    await t.drain()
    expect(Option.getOrNull((await t.get(runId)).output)).toEqual({ squared: 9, plusOne: 10 })
  })

  it("fails the parent's step when the child fails", async () => {
    const t = setup([parent(flaky), flaky])
    const [{ runId }] = (await t.send("go", { n: 1 })) as [{ runId: string }]
    await t.drain()
    const p = await t.get(runId)
    expect(p.status).toBe("failed")
    expect((await t.runsOf("flaky"))[0]!.status).toBe("failed")
  })

  it("fails without creating a child for an unregistered function or invalid data", async () => {
    const strict = defineFunction<{ n: number }>({
      name: "strict",
      event: "never.sent",
      schema: {
        parse: (d: unknown) => {
          if (typeof (d as { n?: unknown })?.n !== "string") throw new Error("n must be a string")
          return d as { n: number }
        },
      },
      handler: () => Effect.void,
    })
    for (const [fns, target] of [[[], "missing"], [[strict], strict]] as const) {
      const t = setup([parent(target as any), ...(fns as StepperFunction<any, any, never>[])])
      const [{ runId }] = (await t.send("go", { n: 1 })) as [{ runId: string }]
      await t.drain()
      expect((await t.get(runId)).status).toBe("failed")
      expect(await t.runsOf(typeof target === "string" ? target : target.name)).toHaveLength(0)
    }
  })

  it("creates the child once even if the invoking step is re-executed", async () => {
    const t = setup([parent(child), child])
    const [{ runId }] = (await t.send("go", { n: 2 })) as [{ runId: string }]
    await t.run(executeRun(runId)) // starts the child and parks the parent
    // Simulate a crash before the park was persisted: the parent runs the step again
    await t.run(Effect.flatMap(Storage, (s) => s.updateRun(runId, { status: "pending", waitingFor: Option.none() })))
    await t.run(executeRun(runId))
    expect(await t.runsOf("square")).toHaveLength(1)
    await t.drain()
    expect((await t.get(runId)).status).toBe("completed")
  })

  it("does not lose the wake-up when the child finishes before the parent parks", async () => {
    const t = setup([parent(child), child])
    const [{ runId }] = (await t.send("go", { n: 4 })) as [{ runId: string }]
    await t.run(executeRun(runId)) // parent starts child, parks waiting
    // Rewind the parent to "about to park" and let the child finish first: its result event
    // finds no waiting parent to resume
    await t.run(Effect.flatMap(Storage, (s) => s.updateRun(runId, { status: "pending", waitingFor: Option.none() })))
    const [c] = await t.runsOf("square")
    for (let i = 0; i < 5; i++) await t.run(executeRun(c!.id))
    expect((await t.get(c!.id)).status).toBe("completed")
    expect((await t.get(runId)).status).toBe("pending")

    // The parent now parks and immediately finds the result
    await t.run(executeRun(runId))
    expect((await t.get(runId)).status).toBe("pending")
    await t.drain()
    expect(Option.getOrNull((await t.get(runId)).output)).toEqual({ squared: 16, plusOne: 17 })
  })

  it("fails the step when the child is cancelled", async () => {
    const t = setup([parent(child), child])
    const [{ runId }] = (await t.send("go", { n: 5 })) as [{ runId: string }]
    await t.run(executeRun(runId))
    const [c] = await t.runsOf("square")
    // What the cancel endpoint does
    await t.run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.transitionRun(c!.id, ["pending"], { status: "cancelled" })
        yield* notifyInvoker(c!.id, c!.eventId, "square", { status: "cancelled", output: null, error: "cancelled" })
      }),
    )
    await t.drain()
    const p = await t.get(runId)
    expect(p.status).toBe("failed")
  })

  it("fails the step on timeout", async () => {
    const t = setup([parent(child, { timeout: Duration.millis(20) }), child])
    const [{ runId }] = (await t.send("go", { n: 5 })) as [{ runId: string }]
    await t.run(executeRun(runId)) // parks with a 20ms timeout; child never executed
    await new Promise((r) => setTimeout(r, 40))
    await t.run(executeRun(runId))
    const p = await t.get(runId)
    expect(p.status).toBe("failed")
  })
})

describe("step.parallel", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it("runs the group concurrently in one pickup and resumes with keyed outputs", async () => {
    let active = 0
    let maxActive = 0
    const calls: string[] = []
    const body = (name: string, value: number) => async () => {
      calls.push(name)
      active++
      maxActive = Math.max(maxActive, active)
      await delay(30)
      active--
      return value
    }
    const fn = defineFunction({
      name: "fan-out",
      event: "go",
      handler: (_e, step) =>
        Effect.gen(function* () {
          const r = yield* step.parallel({ a: body("a", 1), b: body("b", 2), c: body("c", 3) })
          return r.a + r.b + r.c
        }),
    })
    const t = setup([fn])
    const [{ runId }] = (await t.send("go", {})) as [{ runId: string }]

    await t.run(executeRun(runId))
    expect(maxActive).toBe(3)
    expect((await t.get(runId)).status).toBe("pending") // parked once for the whole group

    await t.run(executeRun(runId))
    const run = await t.get(runId)
    expect(run.status).toBe("completed")
    expect(Option.getOrNull(run.output)).toBe(6)
    expect(calls.sort()).toEqual(["a", "b", "c"]) // memoised on replay
  })

  it("retries only the failed step, keeping completed siblings memoised", async () => {
    let attemptsB = 0
    const calls: string[] = []
    const fn = defineFunction({
      name: "partial",
      event: "go",
      handler: (_e, step) =>
        step.parallel(
          {
            a: () => {
              calls.push("a")
              return "A"
            },
            b: () => {
              calls.push("b")
              if (++attemptsB < 3) throw new Error("not yet")
              return "B"
            },
          },
          { maxAttempts: 3 },
        ),
    })
    const t = setup([fn])
    const [{ runId }] = (await t.send("go", {})) as [{ runId: string }]
    await t.drain()
    const run = await t.get(runId)
    expect(run.status).toBe("completed")
    expect(Option.getOrNull(run.output)).toEqual({ a: "A", b: "B" })
    expect(calls.filter((c) => c === "a")).toHaveLength(1)
    expect(attemptsB).toBe(3)
  })

  it("fails the run when a step exhausts its attempts", async () => {
    const fn = defineFunction({
      name: "doomed",
      event: "go",
      handler: (_e, step) =>
        step.parallel(
          {
            ok: () => 1,
            bad: () => {
              throw new Error("always")
            },
          },
          { maxAttempts: 2 },
        ),
    })
    const t = setup([fn])
    const [{ runId }] = (await t.send("go", {})) as [{ runId: string }]
    await t.drain()
    const run: RunRecord = await t.get(runId)
    expect(run.status).toBe("failed")
  })

  it("assigns call indexes per name across groups deterministically", async () => {
    const fn = defineFunction({
      name: "twice",
      event: "go",
      handler: (_e, step) =>
        Effect.gen(function* () {
          yield* step.parallel({ fetch: () => 1, other: () => 2 })
          yield* step.parallel({ fetch: () => 3 })
        }),
    })
    const t = setup([fn])
    const [{ runId }] = (await t.send("go", {})) as [{ runId: string }]
    await t.drain()
    const steps = await t.run(Effect.flatMap(Storage, (s) => s.listSteps(runId)))
    expect(steps.map((s) => s.name).sort()).toEqual(["fetch#0", "fetch#1", "other#0"])
  })
})
