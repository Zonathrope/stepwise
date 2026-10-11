const SERVER_URL = process.env["SERVER_URL"] ?? process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:4000"

function authHeaders(): Record<string, string> {
  const token = process.env["STEPPER_DASHBOARD_TOKEN"]
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return headers
}

export interface RunSummary {
  id: string
  functionName: string
  eventId: string
  status: "pending" | "running" | "retrying" | "waiting" | "completed" | "failed" | "cancelled"
  startedAt: string
  completedAt: string | null
  retryAfter: string | null
  error: string | null
  /** The function's declared `version` when this run was created. */
  handlerVersion: string | null
  /** Set while `status` is "waiting": the event the run is parked on (step.waitForEvent). */
  waitingFor: {
    event: string
    match: Record<string, unknown> | null
    timeoutAt: string | null
    onTimeout: "null" | "throw"
  } | null
}

export interface StepSummary {
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

export interface RunDetail extends RunSummary {
  /** The handler's return value; null until the run completes (or if it returned nothing). */
  output: unknown
  steps: StepSummary[]
}

export interface IntegrationSummary {
  name: string
  /** Exactly one of `event` / `cron` is set. */
  event: string | null
  cron: string | null
  /** Max executing runs (per key value when `concurrencyKey` is set); null = unlimited. */
  concurrency: number | null
  concurrencyKey: string | null
}

export async function getRuns(opts?: {
  functionName?: string
  status?: string
  limit?: number
  offset?: number
}): Promise<RunSummary[]> {
  const params = new URLSearchParams()
  if (opts?.functionName) params.set("functionName", opts.functionName)
  if (opts?.status) params.set("status", opts.status)
  if (opts?.limit) params.set("limit", String(opts.limit))
  if (opts?.offset) params.set("offset", String(opts.offset))

  const res = await fetch(`${SERVER_URL}/api/runs?${params}`, {
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`)
  return res.json()
}

export async function getRunCount(opts?: {
  functionName?: string
  status?: string
}): Promise<number> {
  const params = new URLSearchParams()
  if (opts?.functionName) params.set("functionName", opts.functionName)
  if (opts?.status) params.set("status", opts.status)

  const res = await fetch(`${SERVER_URL}/api/runs/count?${params}`, {
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to count runs: ${res.status}`)
  const body = (await res.json()) as { count: number }
  return body.count
}

export async function getRun(id: string): Promise<RunDetail> {
  const res = await fetch(`${SERVER_URL}/api/runs/${id}`, {
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`)
  return res.json()
}

export interface EventSummary {
  id: string
  name: string
  data: unknown
  timestamp: string
  runCount: number
}

export interface EventDetail extends Omit<EventSummary, "runCount"> {
  runs: RunSummary[]
}

export async function getEvents(opts?: { name?: string; limit?: number; offset?: number }): Promise<EventSummary[]> {
  const params = new URLSearchParams()
  if (opts?.name) params.set("name", opts.name)
  if (opts?.limit) params.set("limit", String(opts.limit))
  if (opts?.offset) params.set("offset", String(opts.offset))

  const res = await fetch(`${SERVER_URL}/api/events?${params}`, {
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`)
  return res.json()
}

export async function getEvent(id: string): Promise<EventDetail> {
  const res = await fetch(`${SERVER_URL}/api/events/${encodeURIComponent(id)}`, {
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch event: ${res.status}`)
  return res.json()
}

/** Re-send an event's name and data under a new id, creating fresh runs. */
export async function replayEvent(id: string): Promise<{ id: string; replayOf: string; runs: { runId: string; functionName: string }[] }> {
  const res = await fetch(`${SERVER_URL}/api/events/${encodeURIComponent(id)}/replay`, {
    method: "POST",
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to replay event: ${res.status}`)
  }
  return res.json()
}

export async function getIntegrations(): Promise<IntegrationSummary[]> {
  const res = await fetch(`${SERVER_URL}/api/integrations`, {
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch integrations: ${res.status}`)
  return res.json()
}
