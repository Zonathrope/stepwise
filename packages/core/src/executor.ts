import { randomUUID } from "node:crypto"
import { Effect, Option } from "effect"
import type { EventPayload, WaitingFor } from "./schema.js"
import { Storage } from "./storage.js"
import { Registry } from "./registry.js"
import { makeStepContext } from "./step-context.js"
import {
  HandlerVersionMismatchError,
  RunNotFoundError,
  StepError,
  StepperPark,
  ValidationError,
  type ValidationIssue,
} from "./errors.js"
import { StepJournal } from "./journal.js"

const isStepperPark = (e: unknown): e is StepperPark =>
  e instanceof StepperPark ||
  (typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: unknown })._tag === "StepperPark")

/** Human-readable error for the run record (a bare `String(error)` loses tagged errors' details). */
export const describeRunError = (error: unknown): string => {
  if (error instanceof StepError) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    return `StepError: step "${error.stepName}" failed (attempt ${error.attempt}): ${cause}`
  }
  if (error instanceof Error) {
    const tag = (error as { _tag?: unknown })._tag
    const name = typeof tag === "string" ? tag : error.name
    return error.message ? `${name}: ${error.message}` : name
  }
  return String(error)
}

export const executeRun = (runId: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry

    const maybeRun = yield* storage.getRun(runId)
    const run = yield* Effect.fromNullable(Option.getOrNull(maybeRun)).pipe(
      Effect.mapError(() => new RunNotFoundError({ runId })),
    )

    const fn = yield* registry.get(run.functionName)
    const maybeEvent = yield* storage.getEvent(run.eventId)
    const event = yield* Effect.fromNullable(Option.getOrNull(maybeEvent)).pipe(
      Effect.mapError(() => new RunNotFoundError({ runId: run.eventId })),
    )

    yield* storage.updateRun(runId, { status: "running" })

    const policy = fn.onVersionMismatch ?? "fail"
    const runVersion = Option.getOrNull(run.handlerVersion)
    const fnVersion = fn.version ?? null
    if (runVersion !== fnVersion) {
      const mismatch = new HandlerVersionMismatchError({
        functionName: fn.name,
        runId,
        reason: "version",
        detail: `run was created by version ${JSON.stringify(runVersion)}, current handler is ${JSON.stringify(fnVersion)}`,
      })
      if (policy === "fail") {
        yield* storage.updateRun(runId, {
          status: "failed",
          completedAt: Option.some(new Date()),
          error: Option.some(describeRunError(mismatch)),
          waitingFor: Option.none(),
        })
        return
      }
      yield* Effect.logWarning(mismatch.message)
    }

    const journal = new StepJournal(run.stepJournal, fn.name, runId, policy)
    const stepContext = makeStepContext(runId, storage, journal)

    type Outcome =
      | { _tag: "completed" }
      | { _tag: "parked"; park: StepperPark }
      | { _tag: "failed"; error: unknown }

    // Run the handler, distinguishing StepperPark (park signal) from real errors
    const outcome: Outcome = yield* fn.handler(event, stepContext).pipe(
      // Returning early, before steps the run already recorded, is a divergence too
      Effect.zipLeft(journal.checkComplete()),
      Effect.map((): Outcome => ({ _tag: "completed" })),
      Effect.catchAll((error): Effect.Effect<Outcome> => {
        if (isStepperPark(error)) {
          return Effect.succeed({ _tag: "parked", park: error })
        }
        return Effect.succeed({ _tag: "failed", error })
      }),
    )

    // Persist newly recorded step keys along with whatever the outcome writes
    const journalPatch = journal.updated ? { stepJournal: journal.updated } : {}

    if (outcome._tag === "parked") {
      const park = outcome.park
      if (park.reason === "sleep" || park.reason === "step-retry") {
        yield* storage.updateRun(runId, {
          status: "retrying",
          retryAfter: Option.some(park.retryAfter!),
          waitingFor: Option.none(),
          ...journalPatch,
        })
      } else if (park.reason === "wait") {
        const waitingFor = park.waitingFor!
        yield* storage.updateRun(runId, {
          status: "waiting",
          retryAfter: Option.fromNullable(waitingFor.timeoutAt),
          waitingFor: Option.some(waitingFor),
          ...journalPatch,
        })
      } else {
        // step-completed: park back to pending for next pickup
        yield* storage.updateRun(runId, {
          status: "pending",
          retryAfter: Option.none(),
          waitingFor: Option.none(),
          ...journalPatch,
        })
      }
    } else if (outcome._tag === "completed") {
      yield* storage.updateRun(runId, {
        status: "completed",
        completedAt: Option.some(new Date()),
        waitingFor: Option.none(),
        ...journalPatch,
      })
    } else {
      yield* storage.updateRun(runId, {
        status: "failed",
        completedAt: Option.some(new Date()),
        error: Option.some(describeRunError(outcome.error)),
        waitingFor: Option.none(),
        ...journalPatch,
      })
    }
  })

const getPath = (value: unknown, path: string): unknown => {
  let current: unknown = value
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** True if `event` satisfies a run's `waitingFor` filter. */
export const eventMatchesWait = (event: EventPayload, waitingFor: WaitingFor): boolean =>
  event.name === waitingFor.event &&
  Object.entries(waitingFor.match ?? {}).every(([path, expected]) =>
    deepEqual(getPath(event.data, path), expected),
  )

/**
 * Resume every `waiting` run whose filter matches `event`. The event becomes the output of the
 * run's waitForEvent step. Returns the ids of the runs that were resumed.
 */
export const resumeWaitingRuns = (event: EventPayload) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const waiting = yield* storage.listWaitingRuns(event.name)
    const resumed: string[] = []
    for (const run of waiting) {
      if (Option.isNone(run.waitingFor) || !eventMatchesWait(event, run.waitingFor.value)) continue
      const ok = yield* storage.resumeWaitingRun(run.id, run.waitingFor.value.stepName, event)
      if (ok) resumed.push(run.id)
    }
    return resumed
  })

const toIssues = (err: unknown): ValidationIssue[] => {
  const raw = (err as any)?.issues ?? (err as any)?.errors
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((i: any) => ({
      ...(Array.isArray(i?.path)
        ? { path: i.path.map((p: any) => (typeof p === "object" && p !== null && "key" in p ? p.key : p)) }
        : {}),
      message: String(i?.message ?? i),
    }))
  }
  return [{ message: err instanceof Error ? err.message : String(err) }]
}

export const dispatchEvent = (event: EventPayload) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry

    const fns = registry.getByEvent(event.name)

    // Validate before persisting anything: no event or runs on invalid data
    for (const fn of fns) {
      if (!fn.schema) continue
      try {
        fn.schema.parse(event.data)
      } catch (err) {
        const issues = toIssues(err)
        return yield* Effect.fail(
          new ValidationError({
            eventName: event.name,
            functionName: fn.name,
            message: `Event "${event.name}" failed validation for function "${fn.name}": ${issues.map((i) => i.message).join("; ")}`,
            issues,
          }),
        )
      }
    }

    const runs = fns.map((fn) => ({
      id: randomUUID(),
      functionName: fn.name,
      eventId: event.id,
      status: "pending" as const,
      startedAt: new Date(),
      completedAt: Option.none<Date>(),
      error: Option.none<string>(),
      retryAfter: Option.none<Date>(),
      waitingFor: Option.none<WaitingFor>(),
      handlerVersion: Option.fromNullable(fn.version),
      stepJournal: [],
    }))

    // Event and all runs are persisted atomically
    yield* storage.saveEventWithRuns(event, runs)

    // Wake any runs parked in step.waitForEvent that this event satisfies
    yield* resumeWaitingRuns(event)

    return runs.map((r) => ({ runId: r.id, functionName: r.functionName }))
  })
