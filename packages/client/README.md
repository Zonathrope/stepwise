# @integration-stepper/client

Typed HTTP SDK for sending events to an integration-stepper server.

```ts
import { createClient } from "@integration-stepper/client"

const client = createClient(functions, {
  serverUrl: "https://stepper.example.com",
  token: process.env.STEPPER_TOKEN, // optional
})

await client.send("user.created", { id: "u1" })
```

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
