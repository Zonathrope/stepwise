import { getRuns } from "@/lib/api"
import { relativeTime, duration, absoluteTime } from "@/lib/utils"
import { statusTextColor, statusDotColor } from "@/lib/status-styles"

const STATUSES = ["pending", "running", "retrying", "completed", "failed", "cancelled"] as const

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; functionName?: string }>
}) {
  const params = await searchParams
  const runs = await getRuns({
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.functionName !== undefined ? { functionName: params.functionName } : {}),
    limit: 100,
  }).catch(() => [])

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
            {" "}· {runs.length} result{runs.length !== 1 ? "s" : ""}
          </p>
        </div>
        <StatusFilter current={params.status} />
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
