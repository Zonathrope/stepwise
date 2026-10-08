import { Effect, Layer, Option } from "effect"
import { eq, and, inArray, isNull, lte, or, sql, desc, count } from "drizzle-orm"
import { Storage, StorageError, type EventPayload, type RunRecord, type StepRecord, type RunStatus } from "@integration-stepper/core"
import type { Db } from "./client.js"
import * as schema from "./schema.js"

const toStorageError = (cause: unknown) => new StorageError({ cause })

const toEventPayload = (row: typeof schema.events.$inferSelect): EventPayload => ({
  id: row.id,
  name: row.name,
  data: row.data,
  timestamp: row.timestamp,
})

const toRunRecord = (row: typeof schema.runs.$inferSelect): RunRecord => ({
  id: row.id,
  functionName: row.integrationName,
  eventId: row.eventId,
  status: row.status,
  startedAt: row.startedAt,
  completedAt: Option.fromNullable(row.completedAt),
  retryAfter: Option.fromNullable(row.retryAfter),
  error: Option.fromNullable(row.error),
})

const toStepRecord = (row: typeof schema.steps.$inferSelect): StepRecord => ({
  id: row.id,
  runId: row.runId,
  name: row.name,
  status: row.status,
  attempt: row.attempt,
  maxAttempts: row.maxAttempts,
  startedAt: Option.fromNullable(row.startedAt),
  completedAt: Option.fromNullable(row.completedAt),
  output: Option.fromNullable(row.output),
  error: Option.fromNullable(row.error),
  retryAfter: Option.fromNullable(row.retryAfter),
})

export const PostgresStorageLive = (db: Db) =>
  Layer.sync(Storage, () =>
    Storage.of({
      saveEvent: (event) =>
        Effect.tryPromise({
          try: () =>
            db.insert(schema.events).values({
              id: event.id,
              name: event.name,
              data: event.data,
              timestamp: event.timestamp,
            }).onConflictDoNothing(),
          catch: toStorageError,
        }),

      getEvent: (id) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db.select().from(schema.events).where(eq(schema.events.id, id))
            return Option.fromNullable(rows[0]).pipe(Option.map(toEventPayload))
          },
          catch: toStorageError,
        }),

      saveEventWithRuns: (event, newRuns) =>
        Effect.tryPromise({
          try: () =>
            db.transaction(async (tx) => {
              await tx.insert(schema.events).values({
                id: event.id,
                name: event.name,
                data: event.data,
                timestamp: event.timestamp,
              }).onConflictDoNothing()
              if (newRuns.length === 0) return
              await tx.insert(schema.runs).values(
                newRuns.map((run) => ({
                  id: run.id,
                  integrationName: run.functionName,
                  eventId: run.eventId,
                  status: run.status,
                  startedAt: run.startedAt,
                  completedAt: Option.getOrNull(run.completedAt),
                  retryAfter: Option.getOrNull(run.retryAfter),
                  error: Option.getOrNull(run.error),
                })),
              )
            }),
          catch: toStorageError,
        }),

      createRun: (run) =>
        Effect.tryPromise({
          try: () =>
            db.insert(schema.runs).values({
              id: run.id,
              integrationName: run.functionName,
              eventId: run.eventId,
              status: run.status,
              startedAt: run.startedAt,
              completedAt: Option.getOrNull(run.completedAt),
              retryAfter: Option.getOrNull(run.retryAfter),
              error: Option.getOrNull(run.error),
            }),
          catch: toStorageError,
        }),

      updateRun: (id, patch) =>
        Effect.tryPromise({
          try: () =>
            db.update(schema.runs).set({
              ...(patch.status !== undefined && { status: patch.status }),
              ...(patch.completedAt !== undefined && { completedAt: Option.getOrNull(patch.completedAt) }),
              ...(patch.retryAfter !== undefined && { retryAfter: Option.getOrNull(patch.retryAfter) }),
              ...(patch.error !== undefined && { error: Option.getOrNull(patch.error) }),
            }).where(eq(schema.runs.id, id)),
          catch: toStorageError,
        }),

      transitionRun: (id, from, patch) =>
        Effect.tryPromise({
          try: async () => {
            const set = {
              ...(patch.status !== undefined && { status: patch.status }),
              ...(patch.completedAt !== undefined && { completedAt: Option.getOrNull(patch.completedAt) }),
              ...(patch.retryAfter !== undefined && { retryAfter: Option.getOrNull(patch.retryAfter) }),
              ...(patch.error !== undefined && { error: Option.getOrNull(patch.error) }),
            }
            const rows = await db
              .update(schema.runs)
              .set(set)
              .where(and(eq(schema.runs.id, id), inArray(schema.runs.status, [...from])))
              .returning({ id: schema.runs.id })
            return rows.length > 0
          },
          catch: toStorageError,
        }),

      getRun: (id) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, id))
            return Option.fromNullable(rows[0]).pipe(Option.map(toRunRecord))
          },
          catch: toStorageError,
        }),

      listRuns: (opts) =>
        Effect.tryPromise({
          try: async () => {
            const conditions = []

            if (opts?.functionName) {
              conditions.push(eq(schema.runs.integrationName, opts.functionName))
            }

            if (opts?.eventId) {
              conditions.push(eq(schema.runs.eventId, opts.eventId))
            }

            if (opts?.status) {
              conditions.push(eq(schema.runs.status, opts.status))
            }

            if (opts?.eligibleForPickup) {
              conditions.push(
                inArray(schema.runs.status, ["pending", "retrying"]),
                or(
                  isNull(schema.runs.retryAfter),
                  lte(schema.runs.retryAfter, sql`NOW()`),
                )!,
              )
            }

            const baseQuery = db.select().from(schema.runs)
            const whereQuery = conditions.length > 0
              ? baseQuery.where(and(...conditions))
              : baseQuery
            const rows = await whereQuery
              .orderBy(desc(schema.runs.startedAt))
              .limit(opts?.limit ?? 100)
              .offset(opts?.offset ?? 0)

            return rows.map(toRunRecord)
          },
          catch: toStorageError,
        }),

      countRuns: (opts) =>
        Effect.tryPromise({
          try: async () => {
            const conditions = []
            if (opts?.functionName) {
              conditions.push(eq(schema.runs.integrationName, opts.functionName))
            }
            if (opts?.status) {
              conditions.push(eq(schema.runs.status, opts.status))
            }
            const baseQuery = db.select({ value: count() }).from(schema.runs)
            const rows = await (conditions.length > 0
              ? baseQuery.where(and(...conditions))
              : baseQuery)
            return rows[0]?.value ?? 0
          },
          catch: toStorageError,
        }),

      createStep: (step) =>
        Effect.tryPromise({
          try: () =>
            db.insert(schema.steps).values({
              id: step.id,
              runId: step.runId,
              name: step.name,
              status: step.status,
              attempt: step.attempt,
              maxAttempts: step.maxAttempts,
              startedAt: Option.getOrNull(step.startedAt),
              completedAt: Option.getOrNull(step.completedAt),
              output: Option.getOrNull(step.output),
              error: Option.getOrNull(step.error),
              retryAfter: Option.getOrNull(step.retryAfter),
            }),
          catch: toStorageError,
        }),

      updateStep: (stepId, patch) =>
        Effect.tryPromise({
          try: () =>
            db.update(schema.steps).set({
              ...(patch.status !== undefined && { status: patch.status }),
              ...(patch.attempt !== undefined && { attempt: patch.attempt }),
              ...(patch.startedAt !== undefined && { startedAt: Option.getOrNull(patch.startedAt) }),
              ...(patch.retryAfter !== undefined && { retryAfter: Option.getOrNull(patch.retryAfter) }),
              ...(patch.completedAt !== undefined && { completedAt: Option.getOrNull(patch.completedAt) }),
              ...(patch.output !== undefined && { output: Option.getOrNull(patch.output) }),
              ...(patch.error !== undefined && { error: Option.getOrNull(patch.error) }),
            }).where(eq(schema.steps.id, stepId)),
          catch: toStorageError,
        }),

      getStep: (runId, stepName) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select()
              .from(schema.steps)
              .where(and(eq(schema.steps.runId, runId), eq(schema.steps.name, stepName)))
            return Option.fromNullable(rows[0]).pipe(Option.map(toStepRecord))
          },
          catch: toStorageError,
        }),

      listSteps: (runId) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db.select().from(schema.steps).where(eq(schema.steps.runId, runId))
            return rows.map(toStepRecord)
          },
          catch: toStorageError,
        }),
    }),
  )
