import { Context, Effect, Layer, Option } from "effect"
import type { EventPayload, RunRecord, StepRecord, RunStatus } from "./schema.js"
import { StorageError } from "./errors.js"

export interface Storage {
  readonly saveEvent: (event: EventPayload) => Effect.Effect<void, StorageError>
  readonly getEvent: (id: string) => Effect.Effect<Option.Option<EventPayload>, StorageError>

  readonly createRun: (run: RunRecord) => Effect.Effect<void, StorageError>
  readonly updateRun: (
    id: string,
    patch: Partial<Pick<RunRecord, "status" | "completedAt" | "error" | "retryAfter" | "waitingFor">>,
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
        if (existing) runs.set(id, { ...existing, ...patch } as RunRecord)
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
        const key = `${runId}:${stepName}`
        const step = steps.get(key)
        if (step) {
          steps.set(key, {
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

    createStep: (step) => wrap(() => { steps.set(`${step.runId}:${step.name}`, step) }),
    updateStep: (id, patch) =>
      wrap(() => {
        const existing = steps.get(id)
        if (existing) steps.set(id, { ...existing, ...patch } as StepRecord)
      }),
    getStep: (runId, stepKey) => wrap(() => Option.fromNullable(steps.get(`${runId}:${stepKey}`))),
    listSteps: (runId) =>
      wrap(() => Array.from(steps.values()).filter((s) => s.runId === runId)),
  })
})
