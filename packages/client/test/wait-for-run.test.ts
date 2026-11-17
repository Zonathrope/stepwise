import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { createClient, RunNotFoundError, WaitForRunTimeoutError, type RunStatus } from "../src/index.js"

/** A fake stepwise server: one mutable run, an SSE stream, and a request log. */
const fakeServer = async (opts: { stream?: boolean; token?: string } = {}) => {
  const state = {
    status: "pending" as RunStatus,
    output: null as unknown,
    error: null as string | null,
    runFetches: 0,
    auth: [] as Array<string | undefined>,
  }
  const streams = new Set<ServerResponse>()
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    state.auth.push(req.headers.authorization)
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401).end()
      return
    }
    if (req.url === "/api/stream") {
      if (opts.stream === false) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`)
      streams.add(res)
      req.on("close", () => streams.delete(res))
      return
    }
    const m = req.url?.match(/^\/api\/runs\/([^/]+)$/)
    if (m) {
      state.runFetches++
      if (m[1] !== "run-1") {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Run not found" }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ id: "run-1", functionName: "f", eventId: "e", status: state.status, output: state.output, error: state.error, steps: [] }),
      )
      return
    }
    res.writeHead(404).end()
  }
  const server: Server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const push = (msg: unknown) => {
    for (const s of streams) s.write(`data: ${JSON.stringify(msg)}\n\n`)
  }
  const close = () =>
    new Promise<void>((r) => {
      for (const s of streams) s.destroy()
      server.closeAllConnections()
      server.close(() => r())
    })
  return { url, state, push, close, streams }
}

const servers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})
const start = async (opts?: Parameters<typeof fakeServer>[0]) => {
  const s = await fakeServer(opts)
  servers.push(s)
  return s
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe("client.waitForRun", () => {
  it("resolves when a run.updated message shows the run completed", async () => {
    const s = await start()
    const client = createClient([], { serverUrl: s.url })
    const result = client.waitForRun<{ ok: boolean }>("run-1", { pollIntervalMs: 60_000 })

    await until(() => s.streams.size === 1 && s.state.runFetches === 1)
    s.state.status = "completed"
    s.state.output = { ok: true }
    s.push({ type: "run.updated", runId: "run-1" })

    await expect(result).resolves.toEqual({ status: "completed", output: { ok: true }, error: null })
    // The stream is closed once the wait is over
    await until(() => s.streams.size === 0)
    expect(s.streams.size).toBe(0)
  })

  it("ignores updates for other runs", async () => {
    const s = await start()
    const client = createClient([], { serverUrl: s.url })
    const result = client.waitForRun("run-1", { pollIntervalMs: 60_000 })
    await until(() => s.state.runFetches === 1)

    s.push({ type: "run.updated", runId: "someone-else" })
    await new Promise((r) => setTimeout(r, 30))
    expect(s.state.runFetches).toBe(1)

    s.state.status = "failed"
    s.state.error = "boom"
    s.push({ type: "run.updated", runId: null }) // bulk update: may include us
    await expect(result).resolves.toEqual({ status: "failed", output: null, error: "boom" })
  })

  it("resolves immediately for a run that already finished", async () => {
    const s = await start()
    s.state.status = "cancelled"
    const client = createClient([], { serverUrl: s.url })
    await expect(client.waitForRun("run-1")).resolves.toMatchObject({ status: "cancelled" })
  })

  it("falls back to polling when the stream is unavailable", async () => {
    const s = await start({ stream: false })
    const client = createClient([], { serverUrl: s.url })
    const result = client.waitForRun("run-1", { pollIntervalMs: 20 })
    await until(() => s.state.runFetches >= 2)
    s.state.status = "completed"
    await expect(result).resolves.toMatchObject({ status: "completed" })
  })

  it("rejects with WaitForRunTimeoutError carrying the last status", async () => {
    const s = await start()
    s.state.status = "waiting"
    const client = createClient([], { serverUrl: s.url })
    const err = await client.waitForRun("run-1", { timeoutMs: 50, pollIntervalMs: 10 }).catch((e) => e)
    expect(err).toBeInstanceOf(WaitForRunTimeoutError)
    expect(err.lastStatus).toBe("waiting")
  })

  it("rejects with RunNotFoundError for an unknown run", async () => {
    const s = await start()
    const client = createClient([], { serverUrl: s.url })
    await expect(client.waitForRun("nope")).rejects.toBeInstanceOf(RunNotFoundError)
  })

  it("rejects when the signal aborts", async () => {
    const s = await start()
    const client = createClient([], { serverUrl: s.url })
    const ac = new AbortController()
    const result = client.waitForRun("run-1", { signal: ac.signal })
    ac.abort(new Error("stop"))
    await expect(result).rejects.toThrow("stop")
  })

  it("sends the bearer token on the stream and run requests", async () => {
    const s = await start({ token: "secret" })
    s.state.status = "completed"
    const client = createClient([], { serverUrl: s.url, token: "secret" })
    await expect(client.waitForRun("run-1")).resolves.toMatchObject({ status: "completed" })
    expect(s.state.auth.every((a) => a === "Bearer secret")).toBe(true)
  })
})

describe("client.getRun", () => {
  it("returns the run detail", async () => {
    const s = await start()
    const run = await createClient([], { serverUrl: s.url }).getRun("run-1")
    expect(run).toMatchObject({ id: "run-1", status: "pending", steps: [] })
  })
})
