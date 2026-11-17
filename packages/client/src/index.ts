import type { StepperFunction } from "@integration-stepper/core"
import { readSseJson } from "./sse.js"

export type { StepperFunction }

export type InferEventMap<Fns extends readonly StepperFunction<any, any, any>[]> = {
  [K in Fns[number] as K["event"] & string]: K extends StepperFunction<infer D, any, any> ? D : never
}

export interface SendEventResult {
  id: string
  runs: Array<{ runId: string; functionName: string }>
}

export type RunStatus = "pending" | "running" | "retrying" | "waiting" | "completed" | "failed" | "cancelled"

/** Statuses a run does not leave on its own (a failed run only moves again if retried). */
export const TERMINAL_RUN_STATUSES: ReadonlyArray<RunStatus> = ["completed", "failed", "cancelled"]

export const isTerminalRunStatus = (status: RunStatus) => TERMINAL_RUN_STATUSES.includes(status)

export interface StepDetail {
  id: string
  runId: string
  name: string
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  attempt: number
  maxAttempts: number
  startedAt: string | null
  completedAt: string | null
  output: unknown
  error: string | null
}

/** A run as returned by `GET /api/runs/:id`. */
export interface RunDetail<TOutput = unknown> {
  id: string
  functionName: string
  eventId: string
  status: RunStatus
  startedAt: string
  completedAt: string | null
  retryAfter: string | null
  error: string | null
  handlerVersion: string | null
  output: TOutput | null
  waitingFor: { event: string; match: Record<string, unknown> | null; timeoutAt: string | null; onTimeout: "null" | "throw" } | null
  steps: StepDetail[]
}

/** How a run ended. */
export interface RunResult<TOutput = unknown> {
  status: "completed" | "failed" | "cancelled"
  output: TOutput | null
  error: string | null
}

export interface WaitForRunOptions {
  /** Give up after this long, rejecting with `WaitForRunTimeoutError`. Default 5 minutes. */
  timeoutMs?: number
  /**
   * Re-check the run this often even without a live update, in case the stream is down or
   * the server can't relay updates (no DATABASE_URL). Default 5s.
   */
  pollIntervalMs?: number
  signal?: AbortSignal
}

export class WaitForRunTimeoutError extends Error {
  override readonly name = "WaitForRunTimeoutError"
  constructor(
    readonly runId: string,
    readonly timeoutMs: number,
    /** The last status seen, or null if the run was never fetched successfully. */
    readonly lastStatus: RunStatus | null,
  ) {
    super(`Run ${runId} did not finish within ${timeoutMs}ms (last status: ${lastStatus ?? "unknown"})`)
  }
}

export class RunNotFoundError extends Error {
  override readonly name = "RunNotFoundError"
  constructor(readonly runId: string) {
    super(`Run ${runId} not found`)
  }
}

export interface StepperClient<EventMap extends Record<string, unknown>> {
  send<E extends keyof EventMap>(event: E, data: EventMap[E]): Promise<SendEventResult>
  /** Fetch a run with its steps. Rejects with `RunNotFoundError` for an unknown id. */
  getRun<TOutput = unknown>(runId: string, opts?: { signal?: AbortSignal }): Promise<RunDetail<TOutput>>
  /**
   * Resolve once the run reaches a terminal status (completed, failed or cancelled). Listens on
   * the server's live stream and re-fetches the run when it changes, with polling as a fallback.
   * A failed run resolves (with `status: "failed"`) rather than rejecting.
   */
  waitForRun<TOutput = unknown>(runId: string, opts?: WaitForRunOptions): Promise<RunResult<TOutput>>
}

function parseSendEventResult(value: unknown): SendEventResult {
  if (typeof value !== "object" || value === null) throw new Error("Invalid server response")
  if (!("id" in value)) throw new Error("Invalid server response")
  if (typeof value.id !== "string") throw new Error("Invalid server response")
  if (!("runs" in value)) throw new Error("Invalid server response")
  if (!Array.isArray(value.runs)) throw new Error("Invalid server response")
  return { id: value.id, runs: value.runs }
}

const isRunUpdate = (msg: unknown, runId: string) =>
  typeof msg === "object" &&
  msg !== null &&
  (msg as { type?: unknown }).type === "run.updated" &&
  // null: a bulk change (bulk cancel/retry) that may include this run
  ((msg as { runId?: unknown }).runId === runId || (msg as { runId?: unknown }).runId === null)

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

export function createClient<
  const Fns extends readonly StepperFunction<any, any, any>[],
>(
  _functions: Fns,
  opts: { serverUrl: string; token?: string },
): StepperClient<InferEventMap<Fns>> {
  const baseUrl = opts.serverUrl.replace(/\/$/, "")
  const authHeaders: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {}

  const getRun = async <TOutput>(runId: string, o: { signal?: AbortSignal } = {}): Promise<RunDetail<TOutput>> => {
    const res = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`, {
      headers: authHeaders,
      ...(o.signal ? { signal: o.signal } : {}),
    })
    if (res.status === 404) throw new RunNotFoundError(runId)
    if (!res.ok) throw new Error(`Failed to get run ${runId}: ${res.status} ${await res.text()}`)
    return (await res.json()) as RunDetail<TOutput>
  }

  const waitForRun = <TOutput>(runId: string, o: WaitForRunOptions = {}): Promise<RunResult<TOutput>> => {
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const pollIntervalMs = o.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    // Aborted when we settle, so the stream, poll timer and in-flight fetches all stop
    const done = new AbortController()

    return new Promise<RunResult<TOutput>>((resolve, reject) => {
      let lastStatus: RunStatus | null = null
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let poller: ReturnType<typeof setInterval> | undefined

      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearInterval(poller)
        o.signal?.removeEventListener("abort", onAbort)
        done.abort()
        fn()
      }

      // One fetch at a time; an update that arrives mid-fetch triggers exactly one more
      let checking = false
      let recheck = false
      const check = async (): Promise<void> => {
        if (settled) return
        if (checking) {
          recheck = true
          return
        }
        checking = true
        try {
          do {
            recheck = false
            const run = await getRun<TOutput>(runId, { signal: done.signal })
            lastStatus = run.status
            if (isTerminalRunStatus(run.status)) {
              const status = run.status as RunResult["status"]
              return settle(() => resolve({ status, output: run.output, error: run.error }))
            }
          } while (recheck && !settled)
        } catch (err) {
          if (settled) return
          if (err instanceof RunNotFoundError) return settle(() => reject(err))
          // Transient (network, 5xx): the next update or poll tries again
        } finally {
          checking = false
        }
      }

      const onAbort = () => settle(() => reject(o.signal!.reason ?? new Error("waitForRun aborted")))
      if (o.signal?.aborted) return onAbort()
      o.signal?.addEventListener("abort", onAbort, { once: true })

      timeout = setTimeout(() => settle(() => reject(new WaitForRunTimeoutError(runId, timeoutMs, lastStatus))), timeoutMs)
      poller = setInterval(() => void check(), pollIntervalMs)

      const listen = async () => {
        try {
          const res = await fetch(`${baseUrl}/api/stream`, {
            headers: { ...authHeaders, Accept: "text/event-stream" },
            signal: done.signal,
          })
          if (!res.ok || !res.body) {
            // No live stream: polling alone decides
            void check()
            return
          }
          // Check once subscribed, so an update between "subscribe" and "check" can't be missed
          void check()
          for await (const msg of readSseJson(res.body)) {
            if (settled) return
            if (isRunUpdate(msg, runId)) void check()
          }
        } catch {
          // Stream failed or was aborted on settle; polling keeps going until then
          if (!settled) void check()
        }
      }
      void listen()
    })
  }

  return {
    async send(event, data) {
      const res = await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ name: event, data }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Failed to send event "${String(event)}": ${res.status} ${body}`)
      }

      return parseSendEventResult(await res.json())
    },
    getRun,
    waitForRun,
  }
}
