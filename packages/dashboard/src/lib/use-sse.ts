"use client"

import { useEffect, useRef } from "react"

const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:4000"

export function useSse(onMessage: (msg: Record<string, unknown>) => void) {
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    const es = new EventSource(`${SERVER_URL}/api/stream`)

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>
        onMessageRef.current(data)
      } catch {}
    }

    return () => { es.close() }
  }, [])
}
