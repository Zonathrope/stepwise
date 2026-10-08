import type { StepperFunction } from "@integration-stepper/core"

export type { StepperFunction }

export type InferEventMap<Fns extends readonly StepperFunction<any, any, any>[]> = {
  [K in Fns[number] as K["event"]]: K extends StepperFunction<infer D, any, any> ? D : never
}

export interface SendEventResult {
  id: string
  runs: Array<{ runId: string; functionName: string }>
}

export interface StepperClient<EventMap extends Record<string, unknown>> {
  send<E extends keyof EventMap>(event: E, data: EventMap[E]): Promise<SendEventResult>
}

export function createClient<
  const Fns extends readonly StepperFunction<any, any, any>[],
>(
  _functions: Fns,
  opts: { serverUrl: string },
): StepperClient<InferEventMap<Fns>> {
  const baseUrl = opts.serverUrl.replace(/\/$/, "")

  return {
    async send(event, data) {
      const res = await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: event, data }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Failed to send event "${String(event)}": ${res.status} ${body}`)
      }

      return res.json() as Promise<SendEventResult>
    },
  }
}
