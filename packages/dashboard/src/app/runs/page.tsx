import { getRuns, getRunCount } from "@/lib/api"
import { revalidatePath } from "next/cache"
import { relativeTime, duration, absoluteTime } from "@/lib/utils"
import { statusTextColor, statusDotColor } from "@/lib/status-styles"

const PAGE_SIZE = 50
const STATUSES = ["pending", "running", "retrying", "waiting", "completed", "failed", "cancelled"] as const

const SERVER_URL = process.env["SERVER_URL"] ?? process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:4000"

async function bulkAction(action: "bulk-cancel" | "bulk-retry", status: string, functionName: string) {
  "use server"
  const token = process.env["STEPPER_DASHBOARD_TOKEN"]
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(`${SERVER_URL}/api/runs/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filter: { status, ...(functionName ? { functionName } : {}) } }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? "Bulk operation failed")
  }
  revalidatePath("/runs")
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; functionName?: string; page?: string }>
}) {
  const params = await searchParams
  const parsedPage = Number.parseInt(params.page ?? "1", 10)
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1
  const filter = {
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.functionName !== undefined ? { functionName: params.functionName } : {}),
  }
  const [runs, total] = await Promise.all([
    getRuns({ ...filter, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }).catch(() => []),
    getRunCount(filter).catch(() => null),
  ])
  const hasNext = total !== null ? page * PAGE_SIZE < total : runs.length === PAGE_SIZE
  const pageHref = (p: number) => {
    const q = new URLSearchParams()
    if (params.status) q.set("status", params.status)
    if (params.functionName) q.set("functionName", params.functionName)
    if (p > 1) q.set("page", String(p))
    const qs = q.toString()
    return qs ? `/runs?${qs}` : "/runs"
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Runs</h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            {params.status
              ? `Filtered by: ${params.status}`
              : params.functionName
                ? `Filtered by: ${params.functionName}`
                : "All runs"}
            {" "}· {total ?? runs.length} total
            {total !== null && total > 0 && ` · page ${page} of ${Math.ceil(total / PAGE_SIZE)}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {(params.status === "pending" || params.status === "retrying") && runs.length > 0 && (
            <form action={bulkAction.bind(null, "bulk-cancel", params.status, params.functionName ?? "")}>
              <button
                type="submit"
                className="text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:border-red-800 hover:text-red-400 hover:bg-red-950/30 transition-colors"
              >
                Cancel all {params.status}
              </button>
            </form>
          )}
          {params.status === "failed" && runs.length > 0 && (
            <form action={bulkAction.bind(null, "bulk-retry", "failed", params.functionName ?? "")}>
              <button
                type="submit"
                className="text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:border-indigo-700 hover:text-indigo-300 hover:bg-indigo-950/30 transition-colors"
              >
                Retry all failed
              </button>
            </form>
          )}
          <StatusFilter current={params.status} />
        </div>
      </div>

      <div className="border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50">
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">Function</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide hidden md:table-cell">Event</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">Started</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500 uppercase tracking-wide">Duration</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500 uppercase tracking-wide hidden lg:table-cell">Run ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {runs.map((run) => (
              <tr key={run.id} className="bg-zinc-900 hover:bg-zinc-800/60 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotColor(run.status)}`} />
                    <span className={`text-xs font-medium ${statusTextColor(run.status)}`}>{run.status}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <a href={`/runs/${run.id}`} className="font-medium text-zinc-100 hover:text-indigo-300 transition-colors">
                    {run.functionName}
                  </a>
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <code className="text-xs text-zinc-500 font-mono">{run.eventId.slice(0, 16)}…</code>
                </td>
                <td className="px-4 py-3">
                  <span title={absoluteTime(run.startedAt)} className="text-zinc-400 text-xs tabular-nums cursor-default">
                    {relativeTime(run.startedAt)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-xs text-zinc-500">
                  {run.completedAt ? duration(run.startedAt, run.completedAt) : "—"}
                </td>
                <td className="px-4 py-3 text-right hidden lg:table-cell">
                  <code className="text-xs text-zinc-600 font-mono">{run.id.slice(0, 8)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.length === 0 && (
          <div className="py-16 text-center text-zinc-500 text-sm">No runs found.</div>
        )}
      </div>

      {(page > 1 || hasNext) && (
        <div className="flex items-center justify-between text-xs">
          {page > 1 ? (
            <a href={pageHref(page - 1)} className="text-indigo-400 hover:text-indigo-300">← Previous</a>
          ) : <span />}
          {hasNext && (
            <a href={pageHref(page + 1)} className="text-indigo-400 hover:text-indigo-300">Next →</a>
          )}
        </div>
      )}
    </div>
  )
}

function StatusFilter({ current }: { current?: string | undefined }) {
  return (
    <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
      <a
        href="/runs"
        className={`px-3 py-1 rounded text-xs transition-colors ${
          !current ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        All
      </a>
      {STATUSES.map((s) => (
        <a
          key={s}
          href={`/runs?status=${s}`}
          className={`px-3 py-1 rounded text-xs capitalize transition-colors ${
            current === s ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {s}
        </a>
      ))}
    </div>
  )
}
