import { Effect, Layer, Option } from "effect"
import { eq, and, inArray, isNull, isNotNull, lte, or, sql, desc } from "drizzle-orm"
import { Storage, StorageError, type EventPayload, type RunRecord, type StepRecord, type RunStatus, type WaitingFor } from "@integration-stepper/core"
import type { Db } from "./client.js"
import * as schema from "./schema.js"

const toStorageError = (cause: unknown) => new StorageError({ cause })

const toEventPayload = (row: typeof schema.events.$inferSelect): EventPayload => ({
  id: row.id,
  name: row.name,
  data: row.data,
  timestamp: row.timestamp,
})

type StoredWaitingFor = Omit<WaitingFor, "timeoutAt"> & { timeoutAt: string | null }

const serializeWaitingFor = (w: WaitingFor): StoredWaitingFor => ({
  ...w,
  timeoutAt: w.timeoutAt ? w.timeoutAt.toISOString() : null,
})

const deserializeWaitingFor = (raw: unknown): Option.Option<WaitingFor> => {
  if (raw === null || raw === undefined) return Option.none()
  const w = raw as StoredWaitingFor
  return Option.some({ ...w, timeoutAt: w.timeoutAt ? new Date(w.timeoutAt) : null })
}

const toRunRecord = (row: typeof schema.runs.$inferSelect): RunRecord => ({
  id: row.id,
  functionName: row.integrationName,
  eventId: row.eventId,
  status: row.status as RunRecord["status"],
  startedAt: row.startedAt,
  completedAt: Option.fromNullable(row.completedAt),
  retryAfter: Option.fromNullable(row.retryAfter),
  error: Option.fromNullable(row.error),
  waitingFor: deserializeWaitingFor(row.waitingFor),
})

const toStepRecord = (row: typeof schema.steps.$inferSelect): StepRecord => ({
  id: row.id,
  runId: row.runId,
  name: row.name,
  status: row.status as StepRecord["status"],
  attempt: row.attempt,
  maxAttempts: row.maxAttempts,
  startedAt: Option.fromNullable(row.startedAt),
  completedAt: Option.fromNullable(row.completedAt),
  output: Option.fromNullable(row.output),
  error: Option.fromNullable(row.error),
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
              waitingFor: Option.match(run.waitingFor, {
                onNone: () => null,
                onSome: serializeWaitingFor,
              }),
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
              ...(patch.waitingFor !== undefined && {
                waitingFor: Option.match(patch.waitingFor, {
                  onNone: () => null,
                  onSome: serializeWaitingFor,
                }),
              }),
            }).where(eq(schema.runs.id, id)),
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
                or(
                  and(
                    inArray(schema.runs.status, ["pending", "retrying"]),
                    or(isNull(schema.runs.retryAfter), lte(schema.runs.retryAfter, sql`NOW()`)),
                  ),
                  // waiting runs are only eligible once their wait timeout has elapsed
                  and(
                    eq(schema.runs.status, "waiting"),
                    isNotNull(schema.runs.retryAfter),
                    lte(schema.runs.retryAfter, sql`NOW()`),
                  ),
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

      listWaitingRuns: (eventName) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select()
              .from(schema.runs)
              .where(
                and(
                  eq(schema.runs.status, "waiting"),
                  sql`${schema.runs.waitingFor}->>'event' = ${eventName}`,
                ),
              )
            return rows.map(toRunRecord)
          },
          catch: toStorageError,
        }),

      resumeWaitingRun: (runId, stepName, output) =>
        Effect.tryPromise({
          try: () =>
            db.transaction(async (tx) => {
              // Claim first: only one resumer (event or timeout pickup) can win the transition
              const claimed = await tx
                .update(schema.runs)
                .set({ status: "pending", retryAfter: null, waitingFor: null })
                .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, "waiting")))
                .returning({ id: schema.runs.id })
              if (claimed.length === 0) return false
              await tx
                .update(schema.steps)
                .set({
                  status: "completed",
                  completedAt: new Date(),
                  output: output as Record<string, unknown> | null,
                })
                .where(and(eq(schema.steps.runId, runId), eq(schema.steps.name, stepName)))
              return true
            }),
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
              output: Option.getOrNull(step.output) as Record<string, unknown> | null,
              error: Option.getOrNull(step.error),
            }),
          catch: toStorageError,
        }),

      updateStep: (id, patch) =>
        Effect.tryPromise({
          try: () => {
            const [runId, ...nameParts] = id.split(":")
            const name = nameParts.join(":")
            return db.update(schema.steps).set({
              ...(patch.status !== undefined && { status: patch.status }),
              ...(patch.attempt !== undefined && { attempt: patch.attempt }),
              ...(patch.completedAt !== undefined && { completedAt: Option.getOrNull(patch.completedAt) }),
              ...(patch.output !== undefined && { output: Option.getOrNull(patch.output) as Record<string, unknown> | null }),
              ...(patch.error !== undefined && { error: Option.getOrNull(patch.error) }),
            }).where(and(eq(schema.steps.runId, runId!), eq(schema.steps.name, name)))
          },
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
