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
  status: "pending" | "running" | "retrying" | "completed" | "failed" | "cancelled"
  startedAt: string
  completedAt: string | null
  retryAfter: string | null
  error: string | null
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
  steps: StepSummary[]
}

export interface IntegrationSummary {
  name: string
  event: string
  concurrency: number
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

export async function getRun(id: string): Promise<RunDetail> {
  const res = await fetch(`${SERVER_URL}/api/runs/${id}`, {
    cache: "no-store",
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`)
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
