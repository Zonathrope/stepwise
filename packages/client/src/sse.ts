/**
 * Minimal Server-Sent Events reader over `fetch`, so the client works in Node (which has no
 * global EventSource) and can send an Authorization header (which EventSource can't).
 * Yields the parsed JSON of each `data:` message; comments (`:ping`) and non-JSON data are skipped.
 */
export async function* readSseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n")
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        if (data === "") continue
        try {
          yield JSON.parse(data)
        } catch {
          // Not JSON: not a message this client understands
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
