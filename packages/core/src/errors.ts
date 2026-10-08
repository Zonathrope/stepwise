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
  reason: "step-completed" | "sleep" | "wait"
  retryAfter?: Date
  waitingFor?: WaitingFor
}> {}
