export function relativeTime(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date
  const diff = Date.now() - d.getTime()
  // Future dates (e.g. a wait timeout) read as "in 5m"
  const fmt = (n: string) => (diff < 0 ? `in ${n}` : `${n} ago`)
  const s = Math.floor(Math.abs(diff) / 1000)
  if (s < 5) return diff < 0 ? "in a moment" : "just now"
  if (s < 60) return fmt(`${s}s`)
  const m = Math.floor(s / 60)
  if (m < 60) return fmt(`${m}m`)
  const h = Math.floor(m / 60)
  if (h < 24) return fmt(`${h}h`)
  const day = Math.floor(h / 24)
  return fmt(`${day}d`)
}

export function duration(start: string | Date, end: string | Date): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

export function absoluteTime(date: string | Date): string {
  return new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}
