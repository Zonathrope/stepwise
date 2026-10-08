import { getRuns, getIntegrations } from "@/lib/api"
import { relativeTime, duration } from "@/lib/utils"

const STATUSES = ["running", "pending", "retrying", "completed", "failed"] as const

export default async function OverviewPage() {
  const [allRuns, integrations] = await Promise.all([
    getRuns({ limit: 200 }).catch(() => []),
    getIntegrations().catch(() => []),
  ])

  const byStatus = allRuns.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})

  const recent = allRuns.slice(0, 8)

  return (
    <div className="space-y-8">

      {/* Status summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {STATUSES.map((status) => (
          <a key={status} href={`/runs?status=${status}`} className="group bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-lg p-4 transition-colors">
            <div className={`text-2xl font-bold tabular-nums ${statusTextColor(status)}`}>
              {byStatus[status] ?? 0}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotColor(status)}`} />
              <span className="text-zinc-400 text-xs capitalize">{status}</span>
            </div>
          </a>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-8">

        {/* Recent runs */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-zinc-400">Recent runs</h2>
            <a href="/runs" className="text-xs text-indigo-400 hover:text-indigo-300">View all →</a>
          </div>
          <div className="divide-y divide-zinc-800 border border-zinc-800 rounded-lg overflow-hidden">
            {recent.length === 0 && (
              <div className="p-8 text-center text-zinc-500 text-sm">No runs yet.</div>
            )}
            {recent.map((run) => (
              <a key={run.id} href={`/runs/${run.id}`} className="flex items-center gap-4 px-4 py-3 bg-zinc-900 hover:bg-zinc-800/60 transition-colors">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotColor(run.status)}`} />
                <span className="text-sm font-medium text-zinc-100 flex-1 truncate">{run.functionName}</span>
                <span className={`text-xs font-mono px-2 py-0.5 rounded-full border ${statusChip(run.status)}`}>
                  {run.status}
                </span>
                {run.completedAt && (
                  <span className="text-xs text-zinc-500 tabular-nums w-12 text-right">
                    {duration(run.startedAt, run.completedAt)}
                  </span>
                )}
                <span className="text-xs text-zinc-500 w-16 text-right flex-shrink-0">
                  {relativeTime(run.startedAt)}
                </span>
              </a>
            ))}
          </div>
        </section>

        {/* Integrations */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-4">
            Integrations <span className="text-zinc-600 ml-1">{integrations.length}</span>
          </h2>
          <div className="space-y-2">
            {integrations.length === 0 && (
              <div className="p-6 text-center text-zinc-500 text-sm border border-zinc-800 rounded-lg">
                No integrations registered.
              </div>
            )}
            {integrations.map((i) => (
              <a key={i.name} href={`/runs?functionName=${encodeURIComponent(i.name)}`}
                className="block bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-lg p-4 transition-colors">
                <div className="text-sm font-medium text-zinc-100">{i.name}</div>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-xs text-zinc-500">on</span>
                  <code className="text-xs text-indigo-300 bg-indigo-950/50 px-1.5 py-0.5 rounded">{i.event}</code>
                </div>
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function statusTextColor(status: string) {
  switch (status) {
    case "completed": return "text-emerald-400"
    case "running": return "text-blue-400"
    case "retrying": return "text-amber-400"
    case "failed": return "text-red-400"
    case "pending": return "text-zinc-300"
    default: return "text-zinc-400"
  }
}

function statusDotColor(status: string) {
  switch (status) {
    case "completed": return "bg-emerald-500"
    case "running": return "bg-blue-500"
    case "retrying": return "bg-amber-500"
    case "failed": return "bg-red-500"
    case "pending": return "bg-zinc-500"
    case "cancelled": return "bg-zinc-600"
    default: return "bg-zinc-600"
  }
}

function statusChip(status: string) {
  switch (status) {
    case "completed": return "text-emerald-400 border-emerald-800 bg-emerald-950/40"
    case "running": return "text-blue-400 border-blue-800 bg-blue-950/40"
    case "retrying": return "text-amber-400 border-amber-800 bg-amber-950/40"
    case "failed": return "text-red-400 border-red-800 bg-red-950/40"
    case "pending": return "text-zinc-400 border-zinc-700 bg-zinc-800/40"
    case "cancelled": return "text-zinc-500 border-zinc-700 bg-zinc-800/40"
    default: return "text-zinc-400 border-zinc-700"
  }
}
