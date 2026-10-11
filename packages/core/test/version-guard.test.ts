import { describe, expect, it } from "vitest"
import { Effect, Layer, Logger, LogLevel, Option } from "effect"
import {
  InMemoryStorageLive,
  RegistryLive,
  Storage,
  StepError,
  defineFunction,
  describeRunError,
  dispatchEvent,
  executeRun,
  type RunRecord,
  type StepperFunction,
} from "../src/index.js"

// One storage instance shared by "deploys": each deploy is a different registry over it
const makeStore = () => {
  const storage = Effect.runSync(Effect.provide(Storage, InMemoryStorageLive))
  const deploy = (fn: StepperFunction<any, any, never>) => {
    const layer = Layer.merge(Layer.succeed(Storage, storage), RegistryLive([fn]))
    return <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> =>
      Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>)
  }
  return { storage, deploy }
}

const steps = (name: string, keys: string[], extra: Partial<StepperFunction<any, any, never>> = {}) =>
  defineFunction({
    name,
    event: "go",
    handler: (_e, step) =>
      Effect.gen(function* () {
        for (const k of keys) yield* step.run(k, () => k)
      }),
    ...extra,
  } as StepperFunction<any, any, never>)

const getRun = (storage: Storage, id: string): Promise<RunRecord> =>
  Effect.runPromise(storage.getRun(id).pipe(Effect.map(Option.getOrThrow)))

/** Execute until the run leaves pending (or `max` executions). */
const drive = async (run: ReturnType<ReturnType<typeof makeStore>["deploy"]>, storage: Storage, id: string, max = 20) => {
  for (let i = 0; i < max; i++) {
    const r = await getRun(storage, id)
    if (r.status !== "pending" && r.status !== "retrying") return r
    await run(executeRun(id))
  }
  return getRun(storage, id)
}

const start = async (run: ReturnType<ReturnType<typeof makeStore>["deploy"]>) => {
  const [created] = await run(dispatchEvent({ id: crypto.randomUUID(), name: "go", data: {}, timestamp: new Date() }))
  return created!.runId
}

describe("step journal", () => {
  it("records the step sequence as the run progresses", async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b", "c"]))
    const id = await start(v1)
    const run = await drive(v1, storage, id)
    expect(run.status).toBe("completed")
    expect(run.stepJournal).toEqual(["a#0", "b#0", "c#0"])
  })

  it("fails a run whose handler gained a step before its recorded position", async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b"]))
    const id = await start(v1)
    await v1(executeRun(id)) // completes a, parks
    await v1(executeRun(id)) // completes b, parks
    expect((await getRun(storage, id)).stepJournal).toEqual(["a#0", "b#0"])

    const v2 = deploy(steps("f", ["a", "inserted", "b"]))
    const run = await drive(v2, storage, id)
    expect(run.status).toBe("failed")
    expect(Option.getOrNull(run.error)).toMatch(
      /HandlerVersionMismatchError: Handler "f" changed .*step 1 is "inserted#0", but this run recorded "b#0"/,
    )
    // The new step never ran
    const stepNames = (await Effect.runPromise(storage.listSteps(id))).map((s) => s.name)
    expect(stepNames).not.toContain("inserted#0")
  })

  it("fails a run whose handler now returns before steps it already recorded", async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b", "c"]))
    const id = await start(v1)
    await v1(executeRun(id))
    await v1(executeRun(id)) // a, b recorded

    const run = await drive(deploy(steps("f", ["a"])), storage, id)
    expect(run.status).toBe("failed")
    expect(Option.getOrNull(run.error)).toMatch(/returned after 1 step\(s\), but this run already recorded "b#0"/)
  })

  it("allows appending steps after the recorded sequence", async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b"]))
    const id = await start(v1)
    await v1(executeRun(id)) // a recorded

    const run = await drive(deploy(steps("f", ["a", "b", "c"])), storage, id)
    expect(run.status).toBe("completed")
    expect(run.stepJournal).toEqual(["a#0", "b#0", "c#0"])
  })

  it('with onVersionMismatch: "warn", logs and adopts the new sequence', async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b"], { onVersionMismatch: "warn" }))
    const id = await start(v1)
    await v1(executeRun(id))
    await v1(executeRun(id)) // a, b recorded

    const logs: string[] = []
    const capture = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message, logLevel }) => {
        if (logLevel === LogLevel.Warning) logs.push(String(message))
      }),
    )
    const v2Fn = steps("f", ["a", "renamed", "b"], { onVersionMismatch: "warn" })
    const v2 = <A, E>(eff: Effect.Effect<A, E, any>) => deploy(v2Fn)(eff.pipe(Effect.provide(capture)))
    const run = await drive(v2, storage, id)

    expect(run.status).toBe("completed")
    expect(run.stepJournal).toEqual(["a#0", "renamed#0", "b#0"])
    expect(logs.some((l) => l.includes('step 1 is "renamed#0", but this run recorded "b#0"'))).toBe(true)
  })

  it("adopts runs created before the journal existed", async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b"]))
    const id = await start(v1)
    await v1(executeRun(id)) // a completed and recorded
    // Simulate a pre-migration run: steps exist, journal empty
    await Effect.runPromise(storage.updateRun(id, { stepJournal: [] }))

    const run = await drive(v1, storage, id)
    expect(run.status).toBe("completed")
    expect(run.stepJournal).toEqual(["a#0", "b#0"])
  })
})

describe("declared handler version", () => {
  it("fails a run resumed under a different version without running the handler", async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b"], { version: "1" }))
    const id = await start(v1)
    await v1(executeRun(id))
    expect(Option.getOrNull((await getRun(storage, id)).handlerVersion)).toBe("1")

    let ran = false
    const v2 = deploy(
      defineFunction({
        name: "f",
        event: "go",
        version: "2",
        handler: () => Effect.sync(() => { ran = true }),
      }),
    )
    const run = await drive(v2, storage, id)
    expect(run.status).toBe("failed")
    expect(Option.getOrNull(run.error)).toMatch(/^HandlerVersionMismatchError: .*\(version\): run was created by version "1", current handler is "2"/)
    expect(ran).toBe(false)
  })

  it('continues under "warn"', async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b"], { version: "1", onVersionMismatch: "warn" }))
    const id = await start(v1)
    await v1(executeRun(id))
    const run = await drive(deploy(steps("f", ["a", "b"], { version: "2", onVersionMismatch: "warn" })), storage, id)
    expect(run.status).toBe("completed")
  })

  it("does not affect runs when the version is unchanged", async () => {
    const { storage, deploy } = makeStore()
    const fn = steps("f", ["a", "b"], { version: "7" })
    const id = await start(deploy(fn))
    expect((await drive(deploy(fn), storage, id)).status).toBe("completed")
  })
})

describe("describeRunError", () => {
  it("includes the step name, attempt and cause message", () => {
    const err = new StepError({ stepName: "charge#0", attempt: 3, cause: new Error("card declined") })
    expect(describeRunError(err)).toBe('StepError: step "charge#0" failed (attempt 3): card declined')
  })

  it("keeps plain values readable", () => {
    expect(describeRunError("boom")).toBe("boom")
    expect(describeRunError(new Error("x"))).toBe("Error: x")
  })
})

describe("version guard on step.parallel and step.invoke", () => {
  it("journals a parallel group in declaration order and detects a changed group", async () => {
    const { storage, deploy } = makeStore()
    const group = (names: string[]) =>
      defineFunction({
        name: "fan",
        event: "go",
        handler: (_e, step) =>
          Effect.gen(function* () {
            yield* step.run("first", () => 1)
            yield* step.parallel(Object.fromEntries(names.map((n) => [n, () => n])))
            yield* step.run("last", () => 2)
          }),
      })
    const v1 = deploy(group(["b", "a", "c"]))
    const id = await start(v1)
    await v1(executeRun(id)) // first
    await v1(executeRun(id)) // the group
    expect((await getRun(storage, id)).stepJournal).toEqual(["first#0", "b#0", "a#0", "c#0"])

    const run = await drive(deploy(group(["b", "x", "c"])), storage, id)
    expect(run.status).toBe("failed")
    expect(Option.getOrNull(run.error)).toMatch(/step 2 is "x#0", but this run recorded "a#0"/)
  })

  it("fails before starting a child when an invoke step replaced a recorded step", async () => {
    const { storage, deploy } = makeStore()
    const child = defineFunction({ name: "child", event: "never", handler: () => Effect.succeed(1) })
    const v1 = deploy(steps("f", ["a", "b"]))
    const id = await start(v1)
    await v1(executeRun(id))
    await v1(executeRun(id)) // a, b recorded

    const v2Fn = defineFunction({
      name: "f",
      event: "go",
      handler: (_e, step) =>
        Effect.gen(function* () {
          yield* step.run("a", () => "a")
          yield* step.invoke("call", { function: "child", data: {} })
        }),
    })
    const storageLayer = Layer.succeed(Storage, storage)
    const v2 = <A, E>(eff: Effect.Effect<A, E, any>) =>
      Effect.runPromise(eff.pipe(Effect.provide(Layer.merge(storageLayer, RegistryLive([v2Fn, child])))) as Effect.Effect<A, E, never>)
    const run = await drive(v2, storage, id)
    expect(run.status).toBe("failed")
    expect(Option.getOrNull(run.error)).toMatch(/step 1 is "call#0", but this run recorded "b#0"/)
    const children = await Effect.runPromise(storage.listRuns({ functionName: "child" }))
    expect(children).toHaveLength(0)
  })

  it("journals invoke steps and resumes them normally", async () => {
    const { storage, deploy } = makeStore()
    const child = defineFunction({ name: "child", event: "never", handler: () => Effect.succeed(41) })
    const parent = defineFunction({
      name: "p",
      event: "go",
      handler: (_e, step) =>
        Effect.gen(function* () {
          const n = yield* step.invoke<number>("call", { function: child, data: {} })
          return n + 1
        }),
    })
    const storageLayer = Layer.succeed(Storage, storage)
    const both = <A, E>(eff: Effect.Effect<A, E, any>) =>
      Effect.runPromise(eff.pipe(Effect.provide(Layer.merge(storageLayer, RegistryLive([parent, child])))) as Effect.Effect<A, E, never>)
    const id = await start(both)
    for (let i = 0; i < 10; i++) {
      const eligible = await Effect.runPromise(storage.listRuns({ eligibleForPickup: true }))
      if (eligible.length === 0) break
      for (const r of eligible) await both(executeRun(r.id))
    }
    const run = await getRun(storage, id)
    expect(run.status).toBe("completed")
    expect(Option.getOrNull(run.output)).toBe(42)
    expect(run.stepJournal).toEqual(["call#0"])
  })

  it("routes a declared-version failure through onFailure", async () => {
    const { storage, deploy } = makeStore()
    const v1 = deploy(steps("f", ["a", "b"], { version: "1" }))
    const id = await start(v1)
    await v1(executeRun(id))
    const failures: unknown[] = []
    const run = await drive(
      deploy(steps("f", ["a", "b"], { version: "2", onFailure: (ctx: { error: unknown }) => Effect.sync(() => void failures.push(ctx.error)) })),
      storage,
      id,
    )
    expect(run.status).toBe("failed")
    expect(failures).toHaveLength(1)
  })
})
