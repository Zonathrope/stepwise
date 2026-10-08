import { serve } from "@hono/node-server"
import { Effect, Layer, Duration } from "effect"
import { defineFunction } from "@integration-stepper/core"
import { createApp } from "./app.js"
import { makeDb } from "./db/client.js"
import { PostgresStorageLive } from "./db/postgres-storage.js"

// --- Demo functions ---

const onUserCreated = defineFunction({
  name: "on-user-created",
  event: "user.created",
  handler: (event, step) =>
    Effect.gen(function* () {
      const data = event.data as { userId: string; email: string; plan?: string }

      const welcome = yield* step.run("send-welcome-email", async () => {
        await new Promise((r) => setTimeout(r, 200))
        console.log(`[on-user-created] Welcome email → ${data.email}`)
        return { messageId: `msg-${data.userId}-welcome` }
      })

      yield* step.sleep("wait-before-followup", Duration.seconds(15))

      yield* step.run("send-followup-email", async () => {
        console.log(`[on-user-created] Follow-up email → ${data.email} (welcome: ${welcome.messageId})`)
        return { messageId: `msg-${data.userId}-followup` }
      })
    }),
})

const onOrderPlaced = defineFunction({
  name: "on-order-placed",
  event: "order.placed",
  handler: (event, step) =>
    Effect.gen(function* () {
      const data = event.data as { orderId: string; userId: string; amount: number; items: number }

      const charge = yield* step.run("charge-payment", async () => {
        await new Promise((r) => setTimeout(r, 300))
        console.log(`[on-order-placed] Charged $${data.amount} for order ${data.orderId}`)
        return { chargeId: `ch_${data.orderId}`, status: "succeeded" }
      })

      yield* step.run("send-receipt", async () => {
        console.log(`[on-order-placed] Receipt sent for charge ${charge.chargeId} (${data.items} items)`)
        return { sent: true }
      })

      yield* step.run("update-inventory", async () => {
        console.log(`[on-order-placed] Inventory updated for order ${data.orderId}`)
        return { updated: true }
      })
    }),
})

const onPaymentFailed = defineFunction({
  name: "on-payment-failed",
  event: "payment.failed",
  handler: (event, step) =>
    Effect.gen(function* () {
      const data = event.data as { orderId: string; userId: string; reason: string }

      yield* step.run("notify-user", async () => {
        console.log(`[on-payment-failed] Notified user ${data.userId}: ${data.reason}`)
        return { notified: true }
      })

      yield* step.run("flag-for-review", async () => {
        console.log(`[on-payment-failed] Order ${data.orderId} flagged for manual review`)
        return { flagged: true }
      })
    }),
})

// --- Server setup ---

const DATABASE_URL = process.env["DATABASE_URL"]
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const PORT = Number(process.env["PORT"] ?? 4000)

const db = makeDb(DATABASE_URL)
const storageLayer = PostgresStorageLive(db)

const { app, shutdown } = createApp({
  db,
  storageLayer,
  functions: [onUserCreated, onOrderPlaced, onPaymentFailed],
  layer: Layer.empty,
  worker: true,
})

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`integration-stepper server running on http://localhost:${PORT}`)
})

const handleShutdown = async () => {
  console.log("Shutting down...")
  await shutdown()
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
}

process.on("SIGTERM", () => { void handleShutdown() })
process.on("SIGINT", () => { void handleShutdown() })
