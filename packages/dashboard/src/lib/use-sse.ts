"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Subscribe to server events via the dashboard's same-origin `/api/stream` proxy.
 * Returns whether the stream is currently connected. EventSource reconnects on its own.
 */
export function useSse(onMessage: (msg: unknown) => void): boolean {
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource("/api/stream")

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (event) => {
      try {
        const data: unknown = JSON.parse(event.data)
        onMessageRef.current(data)
      } catch {}
    }

    return () => { es.close() }
  }, [])

  return connected
}
