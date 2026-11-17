# @integration-stepper/client

Typed HTTP SDK for sending events to an integration-stepper server.

```ts
import { createClient } from "@integration-stepper/client"

const client = createClient(functions, {
  serverUrl: "https://stepper.example.com",
  token: process.env.STEPPER_TOKEN, // optional
})

const { runs } = await client.send("user.created", { id: "u1" })

// Block until a run finishes (completed, failed or cancelled)
const result = await client.waitForRun(runs[0].runId, { timeoutMs: 60_000 })
if (result.status === "completed") console.log(result.output)
else console.error(result.status, result.error)

// Or fetch it once, with its steps
const run = await client.getRun(runs[0].runId)
```

`waitForRun` listens on the server's `GET /api/stream` and re-fetches the run when a
`run.updated` message names it, polling every `pollIntervalMs` (default 5s) as a fallback.
A failed run resolves with `status: "failed"`. It rejects only with `WaitForRunTimeoutError`
(default timeout 5 minutes; the error carries `lastStatus`), `RunNotFoundError`, or the
`signal`'s abort reason.

## Notifications for finished runs

To act on every finished run (Slack, webhooks, email), don't poll from the client. Define a
function triggered by a run lifecycle event. It is a normal function, so its steps are retried:

```ts
import { defineFunction, RUN_FAILED_EVENT, type RunFailedEventData } from "@integration-stepper/core"

export const alertOnFailure = defineFunction<RunFailedEventData>({
  name: "alert-on-failure",
  event: RUN_FAILED_EVENT, // or RUN_COMPLETED_EVENT / RUN_CANCELLED_EVENT
  handler: (event, step) =>
    step.run("post-to-slack", () =>
      fetch(process.env.SLACK_WEBHOOK_URL!, {
        method: "POST",
        body: JSON.stringify({ text: `${event.data.functionName} failed: ${event.data.error}` }),
      }).then((r) => { if (!r.ok) throw new Error(`slack ${r.status}`) }),
    { maxAttempts: 5, backoff: { type: "exponential", initialDelay: "1 second" } }),
})
```

Runs of lifecycle listeners don't emit lifecycle events themselves, so a listener can't
trigger itself. `stepwise/*` event names are reserved and can't be sent with `client.send`.

## Authentication (end-to-end)

1. Pick a secret and set it on the server as `STEPPER_DASHBOARD_TOKEN`.
   When set, every `/api/*` route requires `Authorization: Bearer <token>`
   and returns `401` otherwise. `/health` stays open.
2. Pass the same secret to the client via the optional `token` option
   (for example from `STEPPER_TOKEN` in the sending app's environment).
   The client then adds `Authorization: Bearer <token>` to every request.
3. If `token` is omitted, no header is sent, which works against servers
   without `STEPPER_DASHBOARD_TOKEN`.

Quick check:

```bash
curl -H "Authorization: Bearer $STEPPER_TOKEN" $SERVER_URL/api/runs
```
