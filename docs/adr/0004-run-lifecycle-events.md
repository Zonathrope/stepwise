# Run lifecycle notifications are ordinary events

When a Run reaches a terminal state, the runtime dispatches an internal Event: `stepwise/run.completed` with `{ runId, functionName, eventId, output }`, `stepwise/run.failed` with `{ runId, functionName, eventId, error }`, or `stepwise/run.cancelled` with `{ runId, functionName, eventId }`. `executeRun` sends the first two. The cancel routes send the third, after their conditional `→ cancelled` transition, which now also sets `completedAt`. Notifications (Slack, webhooks, email) are then ordinary Functions triggered by those Events, so they get Steps, retries with backoff, concurrency limits, the dashboard and replay without any new machinery.

We chose this over a callback hook because a hook runs once, in-process, with no retries: a Slack outage loses the notification. `onFailure`, and the new `onSuccess`, stay as best-effort in-process hooks for cheap side effects such as logging and metrics, and their docs point to the lifecycle Events for anything that has to be delivered.

## Rules

- **Emitted once per terminal transition.** The completed branch now moves the Run `running → completed` with a conditional `transitionRun`, like the failed branch already did. Only the execution that wins the transition fires `onSuccess`/`onFailure` and the Event.
- **Deterministic id**: `lifecycle:<runId>:<status>:<completedAt ms>`, built the same way `notifyInvoker` builds `invoke-result:<childRunId>`. Dispatching the same transition twice is a no-op because of Event idempotency. A Run that fails, is retried and fails again gets a second Event, because its `completedAt` is different.
- **No loops.** A Run whose Event is a `stepwise/*` Event emits nothing. The same applies to a Run started by `step.invoke` anywhere in a chain rooted in one: `hasLifecycleOrigin` follows `invoke:<parentRunId>:…` event ids up to the root. Without the invoke walk, a notifier that invokes a child would be re-triggered by that child's completion forever.
- **Reserved prefix.** `POST /api/events` rejects names starting with `stepwise/`, so callers can't forge "run failed" notifications. Replay (`POST /api/events/:id/replay`) is still allowed, because it is how you re-send a notification, and the loop rule keys on the Event name, so a replayed Event is still covered.
- **Only when someone listens.** If no registered Function listens for the Event, nothing is stored. Otherwise every Run would double the events table for nothing.
- **Never fails the Run.** The Run is already terminal when the Event is dispatched. A dispatch error, such as a listener's `schema` rejecting the data or a storage error, is logged and swallowed.
- **Waking workers.** `executeRun` returns `{ status, dispatched }`. The worker sends `NOTIFY stepper_runs` when `dispatched` is non-empty, so a notifier registered only on another worker starts immediately instead of on the next 5s poll.

## Consequences

- The transition and the dispatch are two writes, not one transaction. If the worker crashes between them, the Event is lost, and crash recovery won't help because the Run is no longer `running`. `notifyInvoker` has the same gap. Closing it needs a transactional outbox, or a sweep that re-emits for terminal Runs that have no lifecycle Event.
- Listeners are resolved from the emitting worker's registry, the same limitation as `dispatchEvent` from the HTTP server. Workers with different registries only create notifier Runs for the notifiers they know about.

## Considered options

- **A `notify: [...]` option on `defineFunction` with built-in Slack/webhook transports**: more convenient, but it puts transport code and credentials in core, and it would still need durable retries, which is exactly what Functions already provide.
- **Save the Event without creating Runs, like `invoke/result`**: no listener would ever run.
- **Emit for every Run, including lifecycle-triggered ones, and let users filter**: one forgotten filter is an infinite loop.
