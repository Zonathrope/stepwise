import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { streamSSE } from "hono/streaming"
import type { Layer } from "effect"
import type { Storage, Registry, StepperFunction } from "@integration-stepper/core"
import { RegistryLive } from "@integration-stepper/core"
import { SseBroadcaster } from "./sse.js"
import { eventsRouter } from "./routes/events.js"
import { runsRouter } from "./routes/runs.js"
import { integrationsRouter } from "./routes/integrations.js"
import type { ServerEnv } from "./types.js"
import { Worker, DEFAULT_CONCURRENCY } from "./worker.js"
import type { Db } from "./db/client.js"

export interface SharedConfig<R> {
  functions: StepperFunction<any, any, R>[]
  layer: Layer.Layer<R>
  storageLayer: Layer.Layer<Storage>
}

export interface AppOptions<R> extends SharedConfig<R> {
  db: Db
  worker?: boolean       // default true
  concurrency?: number   // default DEFAULT_CONCURRENCY (5)
  corsOrigins?: string[]
  port?: number
}

export const createApp = <R>(opts: AppOptions<R>): { app: Hono<ServerEnv>; shutdown: () => Promise<void> } => {
  const sse = new SseBroadcaster()
  const registryLayer = RegistryLive(opts.functions)

  const app = new Hono<ServerEnv>()

  app.use("*", logger())
  app.use(
    "*",
    cors({
      origin: opts.corsOrigins ?? ["http://localhost:3000"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  )

  // Auth middleware: protect /api/* if STEPPER_DASHBOARD_TOKEN is set
  app.use("/api/*", async (c, next) => {
    const token = process.env["STEPPER_DASHBOARD_TOKEN"]
    if (token) {
      const authHeader = c.req.header("Authorization")
      if (!authHeader || authHeader !== `Bearer ${token}`) {
        return c.json({ error: "Unauthorized" }, 401)
      }
    }
    await next()
  })

  app.use("*", async (c, next) => {
    c.set("storageLayer", opts.storageLayer)
    c.set("registryLayer", registryLayer)
    c.set("sse", sse)
    c.set("db", opts.db)
    await next()
  })

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const unsub = sse.subscribe((msg) => {
        stream.writeSSE({ data: JSON.stringify(msg) }).catch(() => {})
      })

      stream.writeSSE({ data: JSON.stringify({ type: "connected" }) })

      await stream.sleep(30 * 60 * 1000)
      unsub()
    }),
  )

  app.route("/api/events", eventsRouter)
  app.route("/api/runs", runsRouter)
  app.route("/api/integrations", integrationsRouter)

  app.get("/health", (c) => c.json({ ok: true }))

  // Start worker if requested (default: true)
  const runWorker = opts.worker !== false
  let worker: Worker | null = null

  if (runWorker) {
    worker = new Worker({
      db: opts.db,
      storageLayer: opts.storageLayer,
      registryLayer,
      concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    })
    // Start worker asynchronously — don't block app startup
    worker.start().catch((err) => {
      console.error("[app] Worker failed to start:", err)
    })
  }

  const shutdown = async (): Promise<void> => {
    if (worker) {
      await worker.shutdown()
    }
  }

  return { app, shutdown }
}
