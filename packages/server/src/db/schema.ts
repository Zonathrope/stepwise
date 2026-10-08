import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core"

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  data: jsonb("data").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
})

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  integrationName: text("integration_name").notNull(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  status: text("status", {
    enum: ["pending", "running", "retrying", "completed", "failed", "cancelled"],
  }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  error: text("error"),
})

export const steps = pgTable("steps", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  name: text("name").notNull(),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed", "skipped"],
  }).notNull(),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  output: jsonb("output"),
  error: text("error"),
})
