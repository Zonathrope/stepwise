import { getEvents } from "@/lib/api"
import { relativeTime, absoluteTime } from "@/lib/utils"
import { LiveRefresh } from "@/components/live-refresh"

const PAGE_SIZE = 50

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string; page?: string }>
}) {
  const params = await searchParams
  const parsedPage = Number.parseInt(params.page ?? "1", 10)
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1
  const events = await getEvents({
    ...(params.name ? { name: params.name } : {}),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  }).catch(() => [])
  const hasNext = events.length === PAGE_SIZE
  const pageHref = (p: number) => {
    const q = new URLSearchParams()
    if (params.name) q.set("name", params.name)
    if (p > 1) q.set("page", String(p))
    const qs = q.toString()
    return qs ? `/events?${qs}` : "/events"
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Events</h1>
            <LiveRefresh />
          </div>
          <p className="text-zinc-500 text-sm mt-0.5">
            {params.name ? <>Filtered by name: <code className="font-mono">{params.name}</code></> : "All events, newest first"}
            {page > 1 && ` · page ${page}`}
          </p>
        </div>
        <form action="/events" className="flex items-center gap-2">
          <input
            name="name"
            defaultValue={params.name ?? ""}
            placeholder="Filter by event name"
            className="text-xs bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <button type="submit" className="text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-100">
            Filter
          </button>
          {params.name && (
            <a href="/events" className="text-xs text-zinc-500 hover:text-zinc-300">Clear</a>
          )}
        </form>
      </div>

      <div className="border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50">
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide hidden md:table-cell">Data</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">Received</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500 uppercase tracking-wide">Runs</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500 uppercase tracking-wide hidden lg:table-cell">Event ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {events.map((event) => (
              <tr key={event.id} className="bg-zinc-900 hover:bg-zinc-800/60 transition-colors">
                <td className="px-4 py-3">
                  <a href={`/events/${encodeURIComponent(event.id)}`} className="font-medium text-zinc-100 hover:text-indigo-300 transition-colors">
                    {event.name}
                  </a>
                </td>
                <td className="px-4 py-3 hidden md:table-cell max-w-xs">
                  <code className="block truncate text-xs text-zinc-500 font-mono">{JSON.stringify(event.data)}</code>
                </td>
                <td className="px-4 py-3">
                  <span title={absoluteTime(event.timestamp)} className="text-zinc-400 text-xs tabular-nums cursor-default">
                    {relativeTime(event.timestamp)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-xs text-zinc-400">{event.runCount}</td>
                <td className="px-4 py-3 text-right hidden lg:table-cell">
                  <code className="text-xs text-zinc-600 font-mono">{event.id.slice(0, 8)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 && (
          <div className="py-16 text-center text-zinc-500 text-sm">No events found.</div>
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
