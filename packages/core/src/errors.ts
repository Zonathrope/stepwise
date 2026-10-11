import { Data } from "effect"
import type { WaitingFor } from "./schema.js"

export class StepError extends Data.TaggedError("StepError")<{
  stepName: string
  cause: unknown
  attempt: number
}> {}

export class FunctionNotFoundError extends Data.TaggedError("FunctionNotFoundError")<{
  name: string
}> {}

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{
  runId: string
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
  cause: unknown
}> {}

export class MaxAttemptsExceededError extends Data.TaggedError("MaxAttemptsExceededError")<{
  stepName: string
  attempts: number
}> {}

export class StepperPark extends Data.TaggedError("StepperPark")<{
  reason: "step-completed" | "sleep" | "step-retry" | "wait"
  retryAfter?: Date
  waitingFor?: WaitingFor
}> {}

/**
 * Thrown by the test runner when a handler's step sequence differs between
 * replay passes. Handlers must be deterministic: the same steps in the same order.
 */
export class NonDeterministicHandlerError extends Data.TaggedError("NonDeterministicHandlerError")<{
  functionName: string
  /** Step sequence observed on the previous pass (the expected prefix). */
  expected: ReadonlyArray<string>
  /** Step sequence observed on the offending pass. */
  actual: ReadonlyArray<string>
  /** 1-based replay pass on which the divergence was detected. */
  pass: number
  /** Human-readable diff of the two sequences. */
  diff: string
}> {
  override get message() {
    return `Handler "${this.functionName}" is non-deterministic (pass ${this.pass}):\n${this.diff}`
  }
}

/**
 * A run's handler no longer matches the code that started it: either its declared `version`
 * changed, or its step sequence diverged from the one recorded for the run.
 */
export class HandlerVersionMismatchError extends Data.TaggedError("HandlerVersionMismatchError")<{
  functionName: string
  runId: string
  reason: "version" | "step-sequence"
  detail: string
}> {
  override get message() {
    return `Handler "${this.functionName}" changed while run ${this.runId} was in flight (${this.reason}): ${this.detail}`
  }
}

export interface ValidationIssue {
  path?: ReadonlyArray<string | number>
  message: string
}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  eventName: string
  functionName: string
  message: string
  issues: ReadonlyArray<ValidationIssue>
}> {}
