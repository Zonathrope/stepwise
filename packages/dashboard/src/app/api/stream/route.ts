// Same-origin proxy for the server's SSE stream. EventSource cannot send an Authorization
// header, so the dashboard server attaches STEPPER_DASHBOARD_TOKEN here instead.
export const dynamic = "force-dynamic"

const SERVER_URL = process.env["SERVER_URL"] ?? process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:4000"

export async function GET(req: Request) {
  const token = process.env["STEPPER_DASHBOARD_TOKEN"]
  const upstream = await fetch(`${SERVER_URL}/api/stream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: req.signal,
    cache: "no-store",
  }).catch(() => null)

  if (!upstream || !upstream.ok || !upstream.body) {
    return new Response("stream unavailable", { status: 502 })
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
