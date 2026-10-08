import { Hono } from "hono"
import { Effect } from "effect"
import { Registry } from "@integration-stepper/core"
import type { ServerEnv } from "../types.js"

export const integrationsRouter = new Hono<ServerEnv>()

integrationsRouter.get("/", async (c) => {
  const program = Effect.gen(function* () {
    const registry = yield* Registry
    return registry.list()
  })

  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(c.get("registryLayer"))),
  )

  if (result._tag === "Failure") {
    return c.json({ error: "Failed to list integrations" }, 500)
  }

  return c.json(
    result.value.map((f: { name: string; event: string; concurrency?: number }) => ({
      name: f.name,
      event: f.event,
      concurrency: f.concurrency ?? 1,
    })),
  )
})
