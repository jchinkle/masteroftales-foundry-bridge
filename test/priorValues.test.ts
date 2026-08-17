import { describe, expect, it } from "vitest";
import { currencySlot, hpSlot, PriorValues } from "../src/capture/priorValues.js";

/**
 * The module's only piece of memory. It exists because Foundry's update hooks
 * carry the new value and the diff but never the old one, and every assertion
 * here is really about one of two properties: that it answers honestly when it
 * does not know, and that it cannot grow without bound in a tab left open all
 * night.
 */
describe("PriorValues", () => {
  it("returns null for a key it has never seen — the honest answer, not a zero", () => {
    expect(new PriorValues().recall("hp:Actor.a")).toBeNull();
  });

  it("recalls what it was told", () => {
    const prior = new PriorValues();
    prior.remember("hp:Actor.a", 27);
    expect(prior.recall("hp:Actor.a")).toBe(27);
  });

  it("overwrites rather than accumulating — only the last sighting matters", () => {
    const prior = new PriorValues();
    prior.remember("hp:Actor.a", 27);
    prior.remember("hp:Actor.a", 15);
    prior.remember("hp:Actor.a", 3);

    expect(prior.recall("hp:Actor.a")).toBe(3);
    expect(prior.size).toBe(1);
  });

  it("keeps distinct keys apart, which is what stops four goblins sharing one hp pool", () => {
    const prior = new PriorValues();
    prior.remember(hpSlot("Scene.s.Token.a"), 7);
    prior.remember(hpSlot("Scene.s.Token.b"), 7);
    prior.remember(hpSlot("Scene.s.Token.a"), 2);

    expect(prior.recall(hpSlot("Scene.s.Token.a"))).toBe(2);
    expect(prior.recall(hpSlot("Scene.s.Token.b"))).toBe(7);
  });

  it("stores a whole record, not just numbers — currency is a map", () => {
    const prior = new PriorValues();
    prior.remember(currencySlot("Actor.a"), { gp: 12, sp: 4 });
    expect(prior.recall(currencySlot("Actor.a"))).toEqual({ gp: 12, sp: 4 });
  });

  it("distinguishes a remembered null from a key it never saw", () => {
    const prior = new PriorValues();
    prior.remember("hp:Actor.a", null);

    // `recall` returning null for both is fine for the callers, which treat a
    // non-number as "unknown" — but `size` proves the key was genuinely stored
    // rather than silently discarded.
    expect(prior.size).toBe(1);
  });

  it("forgets on request", () => {
    const prior = new PriorValues();
    prior.remember("hp:Actor.a", 27);
    prior.forget("hp:Actor.a");

    expect(prior.recall("hp:Actor.a")).toBeNull();
    expect(prior.size).toBe(0);
  });

  it("forgetting a key it does not hold is a no-op rather than an error", () => {
    const prior = new PriorValues();
    expect(() => prior.forget("nope")).not.toThrow();
    expect(prior.size).toBe(0);
  });
});

describe("PriorValues — the bound", () => {
  it("never exceeds its maximum", () => {
    const prior = new PriorValues(3);
    for (let i = 0; i < 50; i += 1) prior.remember(`hp:${i}`, i);
    expect(prior.size).toBe(3);
  });

  it("evicts the oldest, keeping the most recently written", () => {
    const prior = new PriorValues(3);
    prior.remember("a", 1);
    prior.remember("b", 2);
    prior.remember("c", 3);
    prior.remember("d", 4);

    expect(prior.recall("a")).toBeNull();
    expect(prior.recall("b")).toBe(2);
    expect(prior.recall("c")).toBe(3);
    expect(prior.recall("d")).toBe(4);
  });

  it("counts a re-remember as recency — the boss hit twenty times is not the one evicted", () => {
    const prior = new PriorValues(3);
    prior.remember("boss", 100);
    prior.remember("mook1", 7);
    prior.remember("mook2", 7);

    // The boss keeps taking damage. Without the delete-then-set in `remember`,
    // it would still sit at insertion position 0 and be first out.
    prior.remember("boss", 80);
    prior.remember("mook3", 7);

    expect(prior.recall("boss")).toBe(80);
    expect(prior.recall("mook1")).toBeNull();
  });

  it("defaults to a bound rather than growing forever", () => {
    const prior = new PriorValues();
    for (let i = 0; i < 2_000; i += 1) prior.remember(`hp:${i}`, i);
    expect(prior.size).toBe(500);
  });
});

describe("slots", () => {
  it("namespaces hit points and coin so one actor's two pools cannot collide", () => {
    expect(hpSlot("Actor.a")).toBe("hp:Actor.a");
    expect(currencySlot("Actor.a")).toBe("currency:Actor.a");
    expect(hpSlot("Actor.a")).not.toBe(currencySlot("Actor.a"));
  });
});
