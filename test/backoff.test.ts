import { describe, expect, it } from "vitest";
import { backoffDelay, DEFAULT_BACKOFF, parseRetryAfter } from "../src/transport/backoff.js";

describe("backoffDelay", () => {
  it("uses full jitter: the delay is somewhere in [0, ceiling)", () => {
    // random() === 0 and random() -> 1 bracket the whole range.
    expect(backoffDelay(0, () => 0)).toBe(0);
    expect(backoffDelay(0, () => 0.999)).toBe(999);
  });

  it("doubles the ceiling per consecutive failure", () => {
    const max = (attempt: number) => backoffDelay(attempt, () => 0.999999);
    expect(max(0)).toBeLessThan(1_000);
    expect(max(1)).toBeLessThan(2_000);
    expect(max(1)).toBeGreaterThanOrEqual(1_900);
    expect(max(2)).toBeGreaterThanOrEqual(3_900);
    expect(max(3)).toBeGreaterThanOrEqual(7_900);
  });

  it("never exceeds the 30s cap, however long the outage lasts", () => {
    for (const attempt of [5, 10, 20, 100, 5_000]) {
      expect(backoffDelay(attempt, () => 0.999999)).toBeLessThanOrEqual(DEFAULT_BACKOFF.capMs);
    }
  });

  it("clamps the exponent so a very large attempt count cannot produce NaN", () => {
    const delay = backoffDelay(Number.MAX_SAFE_INTEGER, () => 0.5);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(15_000);
  });

  it("treats negative and fractional attempts as the first retry", () => {
    expect(backoffDelay(-3, () => 0.999999)).toBeLessThan(1_000);
    expect(backoffDelay(0.7, () => 0.999999)).toBeLessThan(1_000);
  });

  it("honours custom base and cap", () => {
    expect(backoffDelay(4, () => 0.999999, { baseMs: 100, capMs: 500 })).toBeLessThanOrEqual(500);
    expect(backoffDelay(0, () => 0.5, { baseMs: 400 })).toBe(200);
  });

  it("spreads a herd of clients rather than syncing them", () => {
    const values = new Set([0.05, 0.25, 0.5, 0.75, 0.95].map((r) => backoffDelay(3, () => r)));
    expect(values.size).toBe(5);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30", 0)).toBe(30_000);
    expect(parseRetryAfter("0", 0)).toBe(0);
    expect(parseRetryAfter("  12 ", 0)).toBe(12_000);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("2026-08-17T20:00:00Z");
    expect(parseRetryAfter("Mon, 17 Aug 2026 20:00:45 GMT", now)).toBe(45_000);
  });

  it("never returns a negative wait for a date already past", () => {
    const now = Date.parse("2026-08-17T20:00:00Z");
    expect(parseRetryAfter("Mon, 17 Aug 2026 19:00:00 GMT", now)).toBe(0);
  });

  it("returns null for absent or unparseable headers so the caller backs off normally", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
    expect(parseRetryAfter("", 0)).toBeNull();
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });
});
