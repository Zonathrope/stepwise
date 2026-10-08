import { Context, Effect, Layer, Option } from "effect"
import type { EventPayload, RunRecord, StepRecord, RunStatus } from "./schema.js"
import { StorageError } from "./errors.js"

export interface Storage {
  readonly saveEvent: (event: EventPayload) => Effect.Effect<void, StorageError>
  readonly getEvent: (id: string) => Effect.Effect<Option.Option<EventPayload>, StorageError>

  readonly createRun: (run: RunRecord) => Effect.Effect<void, StorageError>
  readonly updateRun: (
    id: string,
    patch: Partial<Pick<RunRecord, "status" | "completedAt" | "error" | "retryAfter">>,
  ) => Effect.Effect<void, StorageError>
  readonly getRun: (id: string) => Effect.Effect<Option.Option<RunRecord>, StorageError>
  readonly listRuns: (opts?: {
    functionName?: string
    eventId?: string
    status?: RunStatus
    eligibleForPickup?: boolean
    limit?: number
    offset?: number
  }) => Effect.Effect<RunRecord[], StorageError>

  readonly createStep: (step: StepRecord) => Effect.Effect<void, StorageError>
  readonly updateStep: (
    id: string,
    patch: Partial<Pick<StepRecord, "status" | "attempt" | "startedAt" | "completedAt" | "output" | "error">>,
  ) => Effect.Effect<void, StorageError>
  readonly getStep: (runId: string, stepKey: string) => Effect.Effect<Option.Option<StepRecord>, StorageError>
  readonly listSteps: (runId: string) => Effect.Effect<StepRecord[], StorageError>
}

export const Storage = Context.GenericTag<Storage>("@integration-stepper/core/Storage")

export const InMemoryStorageLive = Layer.sync(Storage, () => {
  const events = new Map<string, EventPayload>()
  const runs = new Map<string, RunRecord>()
  const steps = new Map<string, StepRecord>()

  const wrap = <A>(f: () => A): Effect.Effect<A, StorageError> =>
    Effect.try({ try: f, catch: (cause) => new StorageError({ cause }) })

  return Storage.of({
    saveEvent: (event) => wrap(() => { events.set(event.id, event) }),
    getEvent: (id) => wrap(() => Option.fromNullable(events.get(id))),

    createRun: (run) => wrap(() => { runs.set(run.id, run) }),
    updateRun: (id, patch) =>
      wrap(() => {
        const existing = runs.get(id)
        if (!existing) return
        runs.set(id, {
          id: existing.id,
          functionName: existing.functionName,
          eventId: existing.eventId,
          startedAt: existing.startedAt,
          status: patch.status ?? existing.status,
          completedAt: patch.completedAt !== undefined ? patch.completedAt : existing.completedAt,
          error: patch.error !== undefined ? patch.error : existing.error,
          retryAfter: patch.retryAfter !== undefined ? patch.retryAfter : existing.retryAfter,
        })
      }),
    getRun: (id) => wrap(() => Option.fromNullable(runs.get(id))),
    listRuns: (opts) =>
      wrap(() => {
        let all = Array.from(runs.values())
        if (opts?.functionName) all = all.filter((r) => r.functionName === opts.functionName)
        if (opts?.eventId) all = all.filter((r) => r.eventId === opts.eventId)
        if (opts?.status) all = all.filter((r) => r.status === opts.status)
        if (opts?.eligibleForPickup) {
          const now = new Date()
          all = all.filter(
            (r) =>
              (r.status === "pending" || r.status === "retrying") &&
              Option.match(r.retryAfter, {
                onNone: () => true,
                onSome: (retryAfter) => retryAfter <= now,
              }),
          )
        }
        all.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        const offset = opts?.offset ?? 0
        const limit = opts?.limit ?? 50
        return all.slice(offset, offset + limit)
      }),

    createStep: (step) => wrap(() => { steps.set(`${step.runId}:${step.name}`, step) }),
    updateStep: (id, patch) =>
      wrap(() => {
        const existing = steps.get(id)
        if (!existing) return
        steps.set(id, {
          id: existing.id,
          runId: existing.runId,
          name: existing.name,
          maxAttempts: existing.maxAttempts,
          status: patch.status ?? existing.status,
          attempt: patch.attempt ?? existing.attempt,
          startedAt: patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
          completedAt: patch.completedAt !== undefined ? patch.completedAt : existing.completedAt,
          output: patch.output !== undefined ? patch.output : existing.output,
          error: patch.error !== undefined ? patch.error : existing.error,
        })
      }),
    getStep: (runId, stepKey) => wrap(() => Option.fromNullable(steps.get(`${runId}:${stepKey}`))),
    listSteps: (runId) =>
      wrap(() => Array.from(steps.values()).filter((s) => s.runId === runId)),
  })
})
