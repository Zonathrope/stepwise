import { Hono } from "hono"
import { Effect } from "effect"
import { normalizeConcurrency, Registry } from "@integration-stepper/core"
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
    result.value.map((f) => {
      const concurrency = normalizeConcurrency(f.concurrency)
      return {
        name: f.name,
        event: f.event ?? null,
        cron: f.cron ?? null,
        // null = unlimited (bounded only by worker slots)
        concurrency: concurrency?.limit ?? null,
        concurrencyKey: concurrency?.key ?? null,
      }
    }),
  )
})
