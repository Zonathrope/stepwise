# integration-stepper

Durable, step-based workflow runner (Effect-ts core, Hono server, Postgres, Next.js dashboard). See `CLAUDE.md` for architecture.

## Handlers must be deterministic

Handlers use a memoised replay model: on every pickup the handler re-executes from the top, and completed steps return their stored output by position (`name#callIndex`). This only works if the handler issues **the same sequence of `step.run` / `step.sleep` calls on every execution**.

Do not:

- branch on `Date.now()`, `Math.random()`, or any state that can change between replays, outside of a `step.run`;
- build step names from non-stable values;
- add, remove, or reorder steps in a handler that has in-flight runs. Old memoised outputs would be applied to the wrong steps. Instead, give the new shape a new function `name`, or add steps only after letting in-flight runs drain.

Validate this in unit tests: `createTestRunner` (from `@integration-stepper/core/testing`) compares the step sequence across every replay pass and rejects with `NonDeterministicHandlerError` (including a diff of the sequences) if a pass diverges from the previous one.

The run-time hash-based version guard (storing a handler version hash on each run) is not implemented; the test-runner check is the supported safeguard.
