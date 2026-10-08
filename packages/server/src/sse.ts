export interface SseMessage {
  type: string
  [key: string]: unknown
}

export class SseBroadcaster {
  private readonly clients = new Set<(msg: SseMessage) => void>()

  subscribe(send: (msg: SseMessage) => void): () => void {
    this.clients.add(send)
    return () => { this.clients.delete(send) }
  }

  broadcast(msg: SseMessage): void {
    for (const send of this.clients) {
      send(msg)
    }
  }

  get count(): number {
    return this.clients.size
  }
}
