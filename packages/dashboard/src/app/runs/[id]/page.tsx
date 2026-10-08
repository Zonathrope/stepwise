import { getRun } from "@/lib/api"
import { notFound } from "next/navigation"
import { revalidatePath } from "next/cache"
import { relativeTime, duration, absoluteTime } from "@/lib/utils"
import { Check, X, Pause, Loader, Minus, Circle, Clock } from "lucide-react"

const SERVER_URL = process.env["SERVER_URL"] ?? process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:4000"

async function cancelRun(runId: string) {
  "use server"
  const token = process.env["STEPPER_DASHBOARD_TOKEN"]
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(`${SERVER_URL}/api/runs/${runId}/cancel`, { method: "POST", headers })
  if (!res.ok) {
    const body = await res.json()
    throw new Error(body.error ?? "Failed to cancel run")
  }
  revalidatePath(`/runs/${runId}`)
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = await getRun(id).catch(() => null)
  if (!run) notFound()

  const canCancel = run.status === "pending" || run.status === "retrying" || run.status === "waiting"
  const totalDuration = run.completedAt ? duration(run.startedAt, run.completedAt) : null

  return (
    <div className="max-w-3xl space-y-8">

      {/* Header */}
      <div>
        <a href="/runs" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-4">
          ← Runs
        </a>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{run.functionName}</h1>
            <div className="flex flex-wrap items-center gap-3 mt-2">
              <StatusBadge status={run.status} />
              <span className="text-zinc-500 text-sm" title={absoluteTime(run.startedAt)}>
                Started {relativeTime(run.startedAt)}
              </span>
              {totalDuration && (
                <span className="text-zinc-500 text-sm">· {totalDuration}</span>
              )}
            </div>
          </div>
          {canCancel && (
            <form action={cancelRun.bind(null, run.id)}>
              <button
                type="submit"
                className="flex-shrink-0 text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:border-red-800 hover:text-red-400 hover:bg-red-950/30 transition-colors"
              >
                Cancel
              </button>
            </form>
          )}
        </div>

        {run.status === "retrying" && run.retryAfter && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-400 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
            <Clock size={14} />
            <span>Sleeping until {absoluteTime(run.retryAfter)}</span>
          </div>
        )}
        {run.error && (
          <div className="mt-3 bg-red-950/30 border border-red-900/50 rounded-lg p-3 text-sm text-red-300 font-mono">
            {run.error}
          </div>
        )}
      </div>

      {/* Step timeline */}
      <section>
        <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-4">
          Steps · {run.steps.length}
        </h2>
        {run.steps.length === 0 ? (
          <p className="text-zinc-500 text-sm">No steps recorded yet.</p>
        ) : (
          <div className="relative">
            {/* Vertical connector line */}
            <div className="absolute left-[11px] top-4 bottom-4 w-px bg-zinc-800" />

            <div className="space-y-3">
              {run.steps.map((step, idx) => {
                const stepDuration = step.completedAt && step.startedAt
                  ? duration(step.startedAt, step.completedAt) : null
                const isSleep = step.name.includes("sleep") || step.name.includes("wait")

                return (
                  <div key={step.id} className="relative flex gap-4">
                    {/* Timeline dot */}
                    <div className={`relative z-10 flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center mt-2.5 ${stepDotStyle(step.status, isSleep)}`}>
                      <StepIcon status={step.status} isSleep={isSleep} />
                    </div>

                    {/* Step card */}
                    <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg p-4 min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="font-medium text-sm text-zinc-100 flex-1 truncate">
                          {cleanStepName(step.name)}
                        </span>
                        {step.attempt > 1 && (
                          <span className="text-xs text-amber-400 bg-amber-950/40 border border-amber-800/50 px-2 py-0.5 rounded-full">
                            attempt {step.attempt}/{step.maxAttempts}
                          </span>
                        )}
                        {stepDuration && (
                          <span className="text-xs text-zinc-500 tabular-nums">{stepDuration}</span>
                        )}
                        <span className={`text-xs font-medium ${stepTextColor(step.status)}`}>
                          {step.status}
                        </span>
                      </div>

                      {step.error && (
                        <div className="mt-2 text-xs text-red-300 font-mono bg-red-950/30 border border-red-900/40 rounded p-2">
                          {step.error}
                        </div>
                      )}

                      {step.output !== null && step.output !== undefined && (
                        <details className="mt-2">
                          <summary className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer select-none">
                            Output
                          </summary>
                          <pre className="mt-2 text-xs text-zinc-300 bg-zinc-800 rounded p-3 overflow-x-auto font-mono leading-relaxed">
                            {JSON.stringify(step.output, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      {/* Metadata */}
      <section className="border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
          <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Metadata</h2>
        </div>
        <dl className="divide-y divide-zinc-800/60">
          {([
            ["Run ID",   run.id],
            ["Event ID", run.eventId],
            ["Started",  absoluteTime(run.startedAt)],
            ...(run.completedAt ? [["Completed", absoluteTime(run.completedAt)]] : []),
          ] as [string, string][]).map(([label, value]) => (
            <div key={label} className="flex items-center gap-6 px-4 py-2.5">
              <dt className="text-xs text-zinc-500 w-24 flex-shrink-0">{label}</dt>
              <dd className="text-xs text-zinc-300 font-mono break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "text-emerald-400 bg-emerald-950/50 border-emerald-800/60",
    running:   "text-blue-400 bg-blue-950/50 border-blue-800/60",
    retrying:  "text-amber-400 bg-amber-950/50 border-amber-800/60",
    waiting:   "text-sky-400 bg-sky-950/50 border-sky-800/60",
    failed:    "text-red-400 bg-red-950/50 border-red-800/60",
    pending:   "text-zinc-300 bg-zinc-800/50 border-zinc-700",
    cancelled: "text-zinc-500 bg-zinc-800/30 border-zinc-700",
  }
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${styles[status] ?? styles.cancelled}`}>
      {status}
    </span>
  )
}

function stepDotStyle(status: string, isSleep: boolean) {
  if (isSleep && status === "completed") return "border-sky-600 bg-sky-950"
  switch (status) {
    case "completed": return "border-emerald-600 bg-emerald-950"
    case "running":   return "border-blue-600 bg-blue-950"
    case "failed":    return "border-red-600 bg-red-950"
    case "skipped":   return "border-zinc-700 bg-zinc-900"
    default:          return "border-zinc-700 bg-zinc-900"
  }
}

function StepIcon({ status, isSleep }: { status: string; isSleep: boolean }) {
  const size = 12
  if (isSleep && status === "completed") return <Pause size={size} className="text-sky-400" />
  switch (status) {
    case "completed": return <Check size={size} className="text-emerald-400" strokeWidth={2.5} />
    case "running":   return <Loader size={size} className="text-blue-400 animate-spin" />
    case "failed":    return <X size={size} className="text-red-400" strokeWidth={2.5} />
    case "skipped":   return <Minus size={size} className="text-zinc-500" />
    default:          return <Circle size={size} className="text-zinc-500" />
  }
}

function stepTextColor(status: string) {
  switch (status) {
    case "completed": return "text-emerald-400"
    case "running":   return "text-blue-400"
    case "failed":    return "text-red-400"
    case "skipped":   return "text-zinc-500"
    default:          return "text-zinc-400"
  }
}

function cleanStepName(name: string) {
  // Strip call index suffix "#0" from display
  return name.replace(/#\d+$/, "")
}
