import type { EventPayload, RunConcurrency } from "./schema.js"

/**
 * Function-level concurrency. A number caps how many runs of the function execute at once
 * (across all workers). The object form can also partition that cap by a key read from the
 * triggering event: `{ limit: 1, key: "data.userId" }` allows one executing run per user.
 */
export type ConcurrencyOption = number | { readonly limit: number; readonly key?: string }

export const normalizeConcurrency = (
  option: ConcurrencyOption | undefined,
): { limit: number; key?: string } | undefined => {
  if (option === undefined) return undefined
  return typeof option === "number" ? { limit: option } : option
}

/** Throws if the option is malformed; used by `defineFunction` to fail fast. */
export const validateConcurrency = (functionName: string, option: ConcurrencyOption | undefined): void => {
  const c = normalizeConcurrency(option)
  if (!c) return
  if (!Number.isInteger(c.limit) || c.limit < 1) {
    throw new Error(`Function "${functionName}": concurrency limit must be a positive integer, got ${c.limit}`)
  }
  if (c.key !== undefined && (typeof c.key !== "string" || c.key.trim() === "")) {
    throw new Error(`Function "${functionName}": concurrency key must be a non-empty dotted path like "data.userId"`)
  }
}

const getPath = (value: unknown, path: string): unknown => {
  let current: unknown = value
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * The concurrency bucket a new run of `functionName` belongs to. `key` is a dotted path into
 * the event (`"data.userId"`; a leading `"event."` is accepted). A missing value shares one
 * bucket (`null`). Returns none when the function has no concurrency limit.
 */
export const runConcurrencyFor = (
  functionName: string,
  option: ConcurrencyOption | undefined,
  event: EventPayload,
): RunConcurrency | null => {
  const c = normalizeConcurrency(option)
  if (!c) return null
  if (c.key === undefined) return { key: functionName, limit: c.limit }
  const path = c.key.startsWith("event.") ? c.key.slice("event.".length) : c.key
  const value = getPath(event, path)
  return { key: `${functionName}:${JSON.stringify(value ?? null)}`, limit: c.limit }
}

export interface ClaimCandidate {
  readonly id: string
  readonly concurrency: RunConcurrency | null
}

/**
 * Choose which candidate runs (oldest first) to claim given `slots` free worker slots and the
 * number of runs currently executing per concurrency key. Runs whose key is saturated are
 * skipped, not blocking later candidates. Returns the chosen ids and whether any candidate was
 * held back by its key (so the caller can look further down the queue).
 */
export const selectClaimable = (
  candidates: ReadonlyArray<ClaimCandidate>,
  runningByKey: ReadonlyMap<string, number>,
  slots: number,
): { claim: string[]; heldBack: number } => {
  const inUse = new Map(runningByKey)
  const claim: string[] = []
  let heldBack = 0
  for (const c of candidates) {
    if (claim.length >= slots) break
    if (c.concurrency) {
      const used = inUse.get(c.concurrency.key) ?? 0
      if (used >= c.concurrency.limit) {
        heldBack++
        continue
      }
      inUse.set(c.concurrency.key, used + 1)
    }
    claim.push(c.id)
  }
  return { claim, heldBack }
}
