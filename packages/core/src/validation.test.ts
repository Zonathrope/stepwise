import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import { defineFunction } from "./function.js"
import { dispatchEvent } from "./executor.js"
import { makeRegistry, Registry } from "./registry.js"
import { InMemoryStorageLive, Storage } from "./storage.js"
import { ValidationError } from "./errors.js"

const schema = {
  parse(data: unknown) {
    const d = data as any
    if (typeof d?.email !== "string") {
      throw Object.assign(new Error("invalid"), {
        issues: [{ path: ["email"], message: "Expected string" }],
      })
    }
    return d as { email: string }
  },
}

const fn = defineFunction<{ email: string }>({
  name: "on-user",
  event: "user.created",
  schema,
  handler: () => Effect.void,
})

const run = (data: unknown) => {
  const layer = Layer.merge(InMemoryStorageLive, Layer.succeed(Registry, makeRegistry([fn])))
  return Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage
      const exit = yield* Effect.exit(
        dispatchEvent({ id: "e1", name: "user.created", data, timestamp: new Date() }),
      )
      const runs = yield* storage.listRuns({})
      const ev = yield* storage.getEvent("e1")
      return { exit, runs, ev }
    }).pipe(Effect.provide(layer)),
  )
}

test("valid payload creates runs", async () => {
  const { exit, runs } = await run({ email: "a@b.c" })
  assert.ok(Exit.isSuccess(exit))
  assert.equal(runs.length, 1)
})

test("invalid payload fails with ValidationError and creates nothing", async () => {
  const { exit, runs, ev } = await run({ email: 1 })
  assert.ok(Exit.isFailure(exit))
  if (Exit.isFailure(exit)) {
    const err: unknown = Option.getOrThrow(Cause.failureOption(exit.cause))
    assert.ok(err instanceof ValidationError)
    assert.deepEqual(err.issues, [{ path: ["email"], message: "Expected string" }])
  }
  assert.equal(runs.length, 0)
  assert.ok(Option.isNone(ev))
})
