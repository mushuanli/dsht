/**
 * The connection retry policy: bounded exponential backoff, and when the counter starts over.
 *
 * It lives in one small module because the rule is not obvious and was once wrong: the counter used to
 * reset as soon as a generation became `ready`, so a host that accepted every stream and then failed on
 * the first session frame produced a permanent ~2 Hz reconnect loop — each attempt re-listed every
 * session and re-read the model catalog, which reads like a broken host rather than a client bug.
 */

/** How long a generation must serve the operator before its reconnect counts as a fresh start. */
export const RECONNECT_STABLE_MS = 15_000;

/** Base of the exponential backoff, in milliseconds. */
const BASE_MS = 500;

/** Ceiling of the backoff, so a long outage retries at a steady pace rather than never. */
const MAX_MS = 10_000;

/** Delay before the next attempt, jittered so many clients do not return in lockstep.
 * @param attempt - Consecutive unstable generations already attempted.
 * @param random - Source of jitter, injectable for tests.
 * @returns Milliseconds to wait, between 80% and 120% of the bounded exponential value.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.min(BASE_MS * 2 ** Math.max(0, attempt), MAX_MS) * (0.8 + random() * 0.4);
}

/** The attempt count to remember after one generation ended.
 *
 * A generation that stayed up for {@link RECONNECT_STABLE_MS} earns a fresh counter; one that failed
 * soon after becoming ready keeps counting, so a repeating post-ready failure backs off.
 * @param attempt - Count that generation ran under.
 * @param readyForMs - How long that generation was serving before it failed; 0 when it never became ready.
 * @returns The count the next generation starts from.
 */
export function nextReconnectAttempt(attempt: number, readyForMs: number): number {
  return readyForMs >= RECONNECT_STABLE_MS ? 0 : attempt + 1;
}
