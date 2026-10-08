import { getIntegrations, getRuns } from "@/lib/api"

export default async function IntegrationsPage() {
  const [integrations, allRuns] = await Promise.all([
    getIntegrations().catch(() => []),
    getRuns({ limit: 200 }).catch(() => []),
  ])

  const runsByFunction = allRuns.reduce<Record<string, { total: number; completed: number; failed: number; running: number }>>((acc, r) => {
    if (!acc[r.functionName]) acc[r.functionName] = { total: 0, completed: 0, failed: 0, running: 0 }
    acc[r.functionName]!.total++
    if (r.status === "completed") acc[r.functionName]!.completed++
    if (r.status === "failed") acc[r.functionName]!.failed++
    if (r.status === "running") acc[r.functionName]!.running++
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Integrations</h1>
        <p className="text-zinc-500 text-sm mt-0.5">{integrations.length} registered</p>
      </div>

      {integrations.length === 0 ? (
        <div className="border border-zinc-800 rounded-lg p-12 text-center">
          <div className="text-zinc-600 text-3xl mb-3">⬡</div>
          <p className="text-zinc-400 text-sm font-medium">No integrations registered</p>
          <p className="text-zinc-600 text-xs mt-1">Define functions with <code className="font-mono">defineFunction()</code> and pass them to <code className="font-mono">createApp()</code></p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {integrations.map((i) => {
            const stats = runsByFunction[i.name]
            return (
              <div key={i.name} className="bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg overflow-hidden transition-colors">
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-medium text-zinc-100">{i.name}</h2>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-xs text-zinc-500">triggers on</span>
                        <code className="text-xs text-indigo-300 bg-indigo-950/50 border border-indigo-900/40 px-2 py-0.5 rounded">{i.event}</code>
                      </div>
                    </div>
                    <div className="text-xs text-zinc-500 flex-shrink-0 text-right">
                      <div className="text-zinc-400 font-medium">{i.concurrency}</div>
                      <div>concurrency</div>
                    </div>
                  </div>

                  {stats && (
                    <div className="flex items-center gap-4 mt-4 pt-4 border-t border-zinc-800">
                      <Stat label="total" value={stats.total} />
                      <Stat label="done" value={stats.completed} color="text-emerald-400" />
                      {stats.running > 0 && <Stat label="running" value={stats.running} color="text-blue-400" />}
                      {stats.failed > 0 && <Stat label="failed" value={stats.failed} color="text-red-400" />}
                    </div>
                  )}
                </div>

                <div className="px-5 py-3 bg-zinc-950/40 border-t border-zinc-800">
                  <a
                    href={`/runs?functionName=${encodeURIComponent(i.name)}`}
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    View runs →
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color = "text-zinc-300" }: { label: string; value: number; color?: string }) {
  return (
    <div className="text-center">
      <div className={`text-base font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-xs text-zinc-600">{label}</div>
    </div>
  )
}
