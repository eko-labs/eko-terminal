/** Capped exponential backoff with equal jitter: half of each delay is fixed, half is random. */
export function backoffDelay(attempt: number, random: () => number = Math.random, baseMs = 500, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(Math.max(0, attempt), 30)) * (.5 + .5 * random());
}
