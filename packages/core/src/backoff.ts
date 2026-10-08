import { Duration } from "effect"

export type BackoffOptions =
  | { type: "immediate" }
  | {
      type: "fixed" | "linear" | "exponential"
      initialDelay: Duration.DurationInput
      maxDelay?: Duration.DurationInput
      /** Full jitter: delay is randomised uniformly in [0, computed delay]. */
      jitter?: boolean
    }

/**
 * Compute the delay in ms before retrying after a failed attempt.
 * `attempt` is the 1-based number of the attempt that just failed.
 */
export const computeBackoffDelay = (
  backoff: BackoffOptions | undefined,
  attempt: number,
  random: () => number = Math.random,
): number => {
  if (!backoff || backoff.type === "immediate") return 0
  const initial = Math.max(0, Duration.toMillis(Duration.decode(backoff.initialDelay)))
  const n = Math.max(1, attempt)
  let delay: number
  switch (backoff.type) {
    case "fixed":
      delay = initial
      break
    case "linear":
      delay = initial * n
      break
    case "exponential":
      delay = initial * 2 ** (n - 1)
      break
  }
  if (backoff.maxDelay !== undefined) {
    delay = Math.min(delay, Duration.toMillis(Duration.decode(backoff.maxDelay)))
  }
  if (backoff.jitter) delay = Math.floor(random() * delay)
  return delay
}
