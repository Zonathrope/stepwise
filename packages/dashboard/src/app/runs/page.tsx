import { getRuns } from "@/lib/api"
import { relativeTime, duration, absoluteTime } from "@/lib/utils"

const STATUSES = ["pending", "running", "retrying", "waiting", "completed", "failed", "cancelled"] as const

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
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor(run.status)}`} />
                    <span className={`text-xs font-medium ${textColor(run.status)}`}>{run.status}</span>
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

function dotColor(status: string) {
  switch (status) {
    case "completed": return "bg-emerald-500"
    case "running": return "bg-blue-500"
    case "retrying": return "bg-amber-500"
    case "waiting": return "bg-sky-500"
    case "failed": return "bg-red-500"
    case "pending": return "bg-zinc-500"
    default: return "bg-zinc-600"
  }
}

function textColor(status: string) {
  switch (status) {
    case "completed": return "text-emerald-400"
    case "running": return "text-blue-400"
    case "retrying": return "text-amber-400"
    case "waiting": return "text-sky-400"
    case "failed": return "text-red-400"
    case "pending": return "text-zinc-300"
    default: return "text-zinc-400"
  }
}
