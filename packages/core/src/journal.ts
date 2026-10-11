import { Effect } from "effect"
import { HandlerVersionMismatchError } from "./errors.js"

export type VersionMismatchPolicy = "fail" | "warn"

/**
 * Records the order in which a run's handler requests steps, and checks every replay against
 * it. Memoised outputs are matched to steps by key (`name#callIndex`), so a handler whose step
 * sequence changed while a run was in flight (a deploy that added, removed or reordered steps)
 * would silently feed old outputs to the wrong steps. The journal catches that.
 *
 * Runs created before the journal existed start with an empty journal and are adopted: their
 * sequence is recorded from the current handler without a check.
 */
export class StepJournal {
  private readonly keys: string[]
  private readonly recordedLength: number
  private position = 0
  private grew = false

  constructor(
    recorded: ReadonlyArray<string>,
    private readonly functionName: string,
    private readonly runId: string,
    private readonly policy: VersionMismatchPolicy,
  ) {
    this.keys = [...recorded]
    this.recordedLength = recorded.length
  }

  /** Called for every step request, in order. Fails (or warns) if it deviates from the record. */
  track(key: string): Effect.Effect<void, HandlerVersionMismatchError> {
    return Effect.suspend(() => {
      const p = this.position++
      if (p >= this.keys.length) {
        this.keys.push(key)
        this.grew = true
        return Effect.void
      }
      if (this.keys[p] === key) return Effect.void
      return this.mismatch(p, this.keys[p]!, key)
    })
  }

  /**
   * Called when the handler returns. Steps the run already recorded beyond this point were
   * removed from the handler, which is a divergence too.
   */
  checkComplete(): Effect.Effect<void, HandlerVersionMismatchError> {
    return Effect.suspend(() =>
      this.position < this.recordedLength
        ? this.mismatch(this.position, this.keys[this.position]!, null)
        : Effect.void,
    )
  }

  /** The journal to persist, or undefined if unchanged. */
  get updated(): ReadonlyArray<string> | undefined {
    return this.grew ? this.keys : undefined
  }

  private mismatch(
    position: number,
    expected: string,
    actual: string | null,
  ): Effect.Effect<void, HandlerVersionMismatchError> {
    const error = new HandlerVersionMismatchError({
      functionName: this.functionName,
      runId: this.runId,
      reason: "step-sequence",
      detail:
        actual === null
          ? `handler returned after ${position} step(s), but this run already recorded "${expected}" at position ${position}`
          : `step ${position} is "${actual}", but this run recorded "${expected}" there`,
    })
    if (this.policy === "fail") return Effect.fail(error)
    // Warn and adopt the new shape from here on, so later replays are consistent with it
    this.keys.length = position
    if (actual !== null) this.keys.push(actual)
    this.grew = true
    return Effect.logWarning(error.message)
  }
}
