"use client"

import { useRef } from "react"
import { useRouter } from "next/navigation"
import { useSse } from "@/lib/use-sse"

type SseMessage = { type?: string; runId?: string | null; runIds?: string[] }

/**
 * Re-render the current server component page when relevant SSE messages arrive.
 * With `runId`, only that run's updates (and bulk updates) trigger a refresh; otherwise any
 * run update or dispatched event does. Refreshes are debounced to absorb bursts.
 */
export function LiveRefresh({ runId }: { runId?: string }) {
  const router = useRouter()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connected = useSse((raw) => {
    const msg = raw as SseMessage
    const relevant =
      msg.type === "run.updated"
        ? !runId || !msg.runId || msg.runId === runId
        : msg.type === "event.dispatched" && !runId
    if (!relevant) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => router.refresh(), 300)
  })

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-zinc-500"
      title={connected ? "Receiving live updates" : "Live updates disconnected; reload to refresh"}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"}`} />
      {connected ? "Live" : "Offline"}
    </span>
  )
}
