// Central status -> Tailwind class mappings shared by dashboard pages.

export function statusTextColor(status: string): string {
  switch (status) {
    case "completed": return "text-emerald-400"
    case "running": return "text-blue-400"
    case "retrying": return "text-amber-400"
    case "failed": return "text-red-400"
    case "pending": return "text-zinc-300"
    default: return "text-zinc-400"
  }
}

export function statusDotColor(status: string): string {
  switch (status) {
    case "completed": return "bg-emerald-500"
    case "running": return "bg-blue-500"
    case "retrying": return "bg-amber-500"
    case "failed": return "bg-red-500"
    case "pending": return "bg-zinc-500"
    default: return "bg-zinc-600"
  }
}

export function statusChip(status: string): string {
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

export function statusBadge(status: string): string {
  switch (status) {
    case "completed": return "text-emerald-400 bg-emerald-950/50 border-emerald-800/60"
    case "running": return "text-blue-400 bg-blue-950/50 border-blue-800/60"
    case "retrying": return "text-amber-400 bg-amber-950/50 border-amber-800/60"
    case "failed": return "text-red-400 bg-red-950/50 border-red-800/60"
    case "pending": return "text-zinc-300 bg-zinc-800/50 border-zinc-700"
    default: return "text-zinc-500 bg-zinc-800/30 border-zinc-700"
  }
}

export function stepTextColor(status: string): string {
  switch (status) {
    case "completed": return "text-emerald-400"
    case "running": return "text-blue-400"
    case "failed": return "text-red-400"
    case "skipped": return "text-zinc-500"
    default: return "text-zinc-400"
  }
}
