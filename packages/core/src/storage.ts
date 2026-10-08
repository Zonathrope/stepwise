import { Context, Effect, Layer, Option } from "effect"
import type { EventPayload, RunRecord, StepRecord, RunStatus } from "./schema.js"
import { StorageError } from "./errors.js"

export interface Storage {
  readonly saveEvent: (event: EventPayload) => Effect.Effect<void, StorageError>
  readonly getEvent: (id: string) => Effect.Effect<Option.Option<EventPayload>, StorageError>

  /**
   * Atomically persist an event together with all runs created for it.
   * Either everything is stored or nothing is; a failure leaves no orphan event or partial runs.
   */
  readonly saveEventWithRuns: (
    event: EventPayload,
    runs: ReadonlyArray<RunRecord>,
  ) => Effect.Effect<void, StorageError>

  readonly createRun: (run: RunRecord) => Effect.Effect<void, StorageError>
  readonly updateRun: (
    id: string,
    patch: Partial<Pick<RunRecord, "status" | "completedAt" | "error" | "retryAfter" | "waitingFor">>,
  ) => Effect.Effect<void, StorageError>
  /**
   * Atomically apply `patch` only if the run's current status is in `from`.
   * Returns true if a row was updated, false otherwise (not found or status mismatch).
   */
  readonly transitionRun: (
    id: string,
    from: ReadonlyArray<RunStatus>,
    patch: Partial<Pick<RunRecord, "status" | "completedAt" | "error" | "retryAfter">>,
  ) => Effect.Effect<boolean, StorageError>
  readonly getRun: (id: string) => Effect.Effect<Option.Option<RunRecord>, StorageError>
  readonly listRuns: (opts?: {
    functionName?: string
    eventId?: string
    status?: RunStatus
    eligibleForPickup?: boolean
    limit?: number
    offset?: number
  }) => Effect.Effect<RunRecord[], StorageError>
  readonly countRuns: (opts?: {
    functionName?: string
    status?: RunStatus
  }) => Effect.Effect<number, StorageError>

  /** All runs currently parked in `waiting` on the given event name. */
  readonly listWaitingRuns: (eventName: string) => Effect.Effect<RunRecord[], StorageError>
  /**
   * Atomically resume a `waiting` run: completes its wait step with `output` and moves the
   * run to `pending`. Returns false (and changes nothing) if the run is no longer `waiting`.
   */
  readonly resumeWaitingRun: (
    runId: string,
    stepName: string,
    output: unknown,
  ) => Effect.Effect<boolean, StorageError>

  readonly createStep: (step: StepRecord) => Effect.Effect<void, StorageError>
  /**
   * Update a step record, identified by its own step record ID (`StepRecord.id`).
   * This is NOT the run ID and NOT the `runId:name` lookup key used by `getStep`.
   */
  readonly updateStep: (
    stepId: string,
    patch: Partial<Pick<StepRecord, "status" | "attempt" | "startedAt" | "completedAt" | "output" | "error" | "retryAfter">>,
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

    saveEventWithRuns: (event, newRuns) =>
      wrap(() => {
        // Validate first so a failure cannot leave partial state behind.
        for (const r of newRuns) {
          if (runs.has(r.id)) throw new Error(`Run already exists: ${r.id}`)
        }
        events.set(event.id, event)
        for (const r of newRuns) runs.set(r.id, r)
      }),

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
          waitingFor: patch.waitingFor !== undefined ? patch.waitingFor : existing.waitingFor,
        })
      }),
    transitionRun: (id, from, patch) =>
      wrap(() => {
        const existing = runs.get(id)
        if (!existing || !from.includes(existing.status)) return false
        runs.set(id, { ...existing, ...patch } as RunRecord)
        return true
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
              r.status === "waiting"
                ? // waiting runs are only picked up once their wait timeout has elapsed
                  Option.match(r.retryAfter, {
                    onNone: () => false,
                    onSome: (retryAfter) => retryAfter <= now,
                  })
                : (r.status === "pending" || r.status === "retrying") &&
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

    listWaitingRuns: (eventName) =>
      wrap(() =>
        Array.from(runs.values()).filter(
          (r) =>
            r.status === "waiting" &&
            Option.isSome(r.waitingFor) &&
            r.waitingFor.value.event === eventName,
        ),
      ),
    resumeWaitingRun: (runId, stepName, output) =>
      wrap(() => {
        const run = runs.get(runId)
        if (!run || run.status !== "waiting") return false
        const step = Array.from(steps.values()).find((s) => s.runId === runId && s.name === stepName)
        if (step) {
          steps.set(step.id, {
            ...step,
            status: "completed",
            completedAt: Option.some(new Date()),
            output: Option.some(output),
          })
        }
        runs.set(runId, {
          ...run,
          status: "pending",
          retryAfter: Option.none(),
          waitingFor: Option.none(),
        })
        return true
      }),

    countRuns: (opts) =>
      wrap(() =>
        Array.from(runs.values()).filter(
          (r) =>
            (!opts?.functionName || r.functionName === opts.functionName) &&
            (!opts?.status || r.status === opts.status),
        ).length,
      ),

    createStep: (step) => wrap(() => { steps.set(step.id, step) }),
    updateStep: (stepId, patch) =>
      wrap(() => {
        const existing = steps.get(stepId)
        if (!existing) return
        steps.set(stepId, {
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
          retryAfter: patch.retryAfter !== undefined ? patch.retryAfter : existing.retryAfter,
        })
      }),
    getStep: (runId, stepKey) => wrap(() =>
        Option.fromNullable(
          Array.from(steps.values()).find((s) => s.runId === runId && s.name === stepKey),
        ),
      ),
    listSteps: (runId) =>
      wrap(() => Array.from(steps.values()).filter((s) => s.runId === runId)),
  })
})
