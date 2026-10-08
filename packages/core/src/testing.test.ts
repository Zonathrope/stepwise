import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Duration, Effect, Layer } from "effect"
import { defineFunction } from "./function.js"
import { NonDeterministicHandlerError } from "./errors.js"
import { createTestRunner, diffStepSequences } from "./testing.js"

const layer = Layer.empty as Layer.Layer<never>

test("deterministic handler completes", async () => {
  const fn = defineFunction<{ n: number }>({
    name: "det",
    event: "e",
    handler: (_e, step) =>
      Effect.gen(function* () {
        yield* step.run("a", () => 1)
        yield* step.sleep("nap", Duration.millis(0))
        yield* step.run("b", () => 2)
      }) as never,
  })
  const res = await createTestRunner(fn, layer).send({ name: "e", data: { n: 1 } })
  assert.equal(res.run.status, "completed")
  assert.equal(res.steps.length, 3)
})

test("non-deterministic handler throws NonDeterministicHandlerError with diff", async () => {
  let calls = 0
  const fn = defineFunction<{}>({
    name: "nondet",
    event: "e",
    handler: (_e, step) =>
      Effect.gen(function* () {
        const name = `step-${calls++}`
        yield* step.run(name, () => 1)
        yield* step.run("tail", () => 2)
      }) as never,
  })
  await assert.rejects(
    () => createTestRunner(fn, layer).send({ name: "e", data: {} }),
    (err: unknown) => {
      if (!(err instanceof NonDeterministicHandlerError)) throw new Error("wrong error type")
      assert.equal(err.functionName, "nondet")
      assert.deepEqual(err.expected, ["step-0#0"])
      assert.equal(err.actual[0], "step-1#0")
      assert.match(err.diff, /- 0: step-0#0/)
      assert.match(err.diff, /\+ 0: step-1#0/)
      return true
    },
  )
})

test("reordered steps are detected", async () => {
  let flip = false
  const fn = defineFunction<{}>({
    name: "reorder",
    event: "e",
    handler: (_e, step) =>
      Effect.gen(function* () {
        const order = flip ? ["b", "a"] : ["a", "b"]
        flip = true
        for (const n of order) yield* step.run(n, () => n)
      }) as never,
  })
  await assert.rejects(
    () => createTestRunner(fn, layer).send({ name: "e", data: {} }),
    NonDeterministicHandlerError,
  )
})

test("diffStepSequences accepts a strict extension and rejects divergence", () => {
  assert.equal(diffStepSequences(["a#0"], ["a#0", "b#0"]), null)
  assert.equal(diffStepSequences([], ["a#0"]), null)
  assert.ok(diffStepSequences(["a#0", "b#0"], ["a#0"]) !== null)
})
