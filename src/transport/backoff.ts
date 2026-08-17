/**
 * Reconnect/retry timing. Pure, so the "does it actually stay under the cap"
 * question is answered by a test rather than by watching a console for an hour.
 *
 * Full jitter (AWS's formulation): `sleep = random(0, min(cap, base * 2^n))`.
 * Not "exponential plus a little noise" — full jitter, because every Foundry
 * client on the internet reconnecting after a MoT deploy is exactly the
 * thundering herd the plain form is bad at.
 */

export interface BackoffOptions {
  /** First-failure ceiling, ms. */
  baseMs?: number;
  /** Hard ceiling, ms. Offline is a normal state; we do not need sub-minute retries. */
  capMs?: number;
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 1_000,
  capMs: 30_000,
};

/**
 * @param attempt Count of consecutive failures *already* recorded (0 = first retry).
 * @param random  Injected for tests. Must return [0, 1).
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  options: BackoffOptions = {},
): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const cap = options.capMs ?? DEFAULT_BACKOFF.capMs;
  const n = Math.max(0, Math.floor(attempt));

  // 2**n overflows to Infinity long before it matters; Math.min handles that,
  // but clamping the exponent keeps the arithmetic boring.
  const ceiling = Math.min(cap, base * 2 ** Math.min(n, 30));
  return Math.floor(random() * ceiling);
}

/**
 * A `Retry-After` header is either delta-seconds or an HTTP-date. Returns ms, or
 * null when the header is absent or unparseable — the caller then falls back to
 * ordinary backoff rather than retrying instantly.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined) return null;
  const raw = String(header).trim();
  if (raw === "") return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}
