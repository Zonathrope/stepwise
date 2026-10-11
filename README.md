# integration-stepper

Durable, step-based workflow runner (Effect-ts core, Hono server, Postgres, Next.js dashboard). See `CLAUDE.md` for architecture.

## Handlers must be deterministic

Handlers use a memoised replay model: on every pickup the handler re-executes from the top, and completed steps return their stored output by position (`name#callIndex`). This only works if the handler issues **the same sequence of `step.run` / `step.sleep` calls on every execution**.

Do not:

- branch on `Date.now()`, `Math.random()`, or any state that can change between replays, outside of a `step.run`;
- build step names from non-stable values;
- add, remove, or reorder steps in a handler that has in-flight runs. Old memoised outputs would be applied to the wrong steps. Instead, give the new shape a new function `name`, or add steps only after letting in-flight runs drain. (Appending steps after the existing ones is safe.)

Validate this in unit tests: `createTestRunner` (from `@integration-stepper/core/testing`) compares the step sequence across every replay pass and rejects with `NonDeterministicHandlerError` (including a diff of the sequences) if a pass diverges from the previous one.

At run time, a version guard protects in-flight runs from handler changes:

- **Step journal.** Each run records the step keys in the order its handler first requested them. On every replay, each step request is checked against that record before any memoised output is used. If a deploy inserted, removed, renamed or reordered a step before the run's current position (or the handler now returns before steps the run already recorded), the run fails with `HandlerVersionMismatchError` instead of feeding old outputs to the wrong steps. Appending steps after the recorded sequence is allowed.
- **Declared version.** `defineFunction({ version: "2", ... })` is stored on each run. A run created under another version fails before its handler runs. Bump it for changes the journal cannot see, such as different logic between unchanged steps.

Set `onVersionMismatch: "warn"` on a function to log the mismatch and continue instead (the run adopts the new step sequence). Runs created before the guard existed are adopted without a check.
