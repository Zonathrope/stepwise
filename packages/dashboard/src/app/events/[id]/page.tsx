import { notFound, redirect } from "next/navigation"
import { getEvent, replayEvent } from "@/lib/api"
import { relativeTime, absoluteTime, duration } from "@/lib/utils"
import { statusTextColor, statusDotColor } from "@/lib/status-styles"
import { LiveRefresh } from "@/components/live-refresh"

async function replay(eventId: string) {
  "use server"
  const result = await replayEvent(eventId)
  redirect(`/events/${encodeURIComponent(result.id)}`)
}

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const event = await getEvent(decodeURIComponent(id)).catch(() => null)
  if (!event) notFound()

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <a href="/events" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-4">
          ← Events
        </a>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{event.name}</h1>
            <div className="flex flex-wrap items-center gap-3 mt-2">
              <span className="text-zinc-500 text-sm" title={absoluteTime(event.timestamp)}>
                Received {relativeTime(event.timestamp)}
              </span>
              <LiveRefresh />
            </div>
          </div>
          <form action={replay.bind(null, event.id)}>
            <button
              type="submit"
              title="Send this event's name and data again under a new id"
              className="flex-shrink-0 text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:border-indigo-700 hover:text-indigo-300 hover:bg-indigo-950/30 transition-colors"
            >
              Replay event
            </button>
          </form>
        </div>
      </div>

      <section className="border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
          <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Data</h2>
        </div>
        <pre className="p-4 text-xs text-zinc-300 overflow-x-auto font-mono leading-relaxed">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </section>

      <section className="border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
          <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Runs · {event.runs.length}</h2>
        </div>
        {event.runs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No functions ran for this event. It may only have resumed waiting runs.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {event.runs.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotColor(run.status)}`} />
                  <a href={`/runs/${run.id}`} className="font-medium text-sm text-zinc-100 hover:text-indigo-300 truncate">
                    {run.functionName}
                  </a>
                  <span className={`text-xs ${statusTextColor(run.status)}`}>{run.status}</span>
                </div>
                <span className="text-xs text-zinc-500 tabular-nums">
                  {run.completedAt ? duration(run.startedAt, run.completedAt) : relativeTime(run.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border border-zinc-800 rounded-lg overflow-hidden">
        <dl className="divide-y divide-zinc-800/60">
          <div className="flex items-center gap-6 px-4 py-2.5">
            <dt className="text-xs text-zinc-500 w-24 flex-shrink-0">Event ID</dt>
            <dd className="text-xs text-zinc-300 font-mono break-all">{event.id}</dd>
          </div>
          <div className="flex items-center gap-6 px-4 py-2.5">
            <dt className="text-xs text-zinc-500 w-24 flex-shrink-0">Received</dt>
            <dd className="text-xs text-zinc-300 font-mono">{absoluteTime(event.timestamp)}</dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
