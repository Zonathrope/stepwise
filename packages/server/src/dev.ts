import { serve } from "@hono/node-server"
import { InMemoryStorageLive } from "@integration-stepper/core"
import { createApp } from "./app.js"
import { Layer } from "effect"

const PORT = Number(process.env["PORT"] ?? 4000)

const { app, shutdown } = createApp({
  db: null as any,          // not needed with in-memory storage
  storageLayer: InMemoryStorageLive,
  functions: [],
  layer: Layer.empty,
  worker: false,            // worker uses DB; skip for in-memory dev
})

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[dev] integration-stepper running on http://localhost:${PORT}`)
  console.log(`[dev] using in-memory storage — data is not persisted`)
})

const handleShutdown = async () => {
  await shutdown()
  server.close(() => process.exit(0))
}

process.on("SIGTERM", () => { void handleShutdown() })
process.on("SIGINT", () => { void handleShutdown() })
