# Memoized replay execution model

Every time a Run is picked up by the worker, the Function handler is re-executed from the top. Steps that already completed return their recorded output immediately (memoized); only the next incomplete step actually executes. This means a handler with three steps invokes the handler body three times total — twice to replay memoized results, once to do real work.

We chose this over an explicit state machine (where the worker resumes from a serialised cursor) because it requires zero extra framework infrastructure: the handler is ordinary Effect code, steps are identified by call-order index, and durability falls out of the storage layer. The trade-off is the determinism constraint: handler logic must produce the same step sequence on every attempt, or memoized outputs will be fed to the wrong steps silently. This constraint is documented but not enforced at runtime.

## Considered options

- **Explicit cursor / state machine**: the worker serialises execution position and resumes mid-handler. Removes the determinism constraint but requires the framework to manage a serialisable execution model — significant complexity.
- **No memoization**: each retry re-runs all steps from scratch. Simpler but makes retries non-idempotent and doubles side-effects on every failure.
