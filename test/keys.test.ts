import { describe, expect, it } from "vitest";
import {
  actorChangeKey,
  chatMessageKey,
  combatantKey,
  combatEndKey,
  combatStartKey,
  combatTurnKey,
  currencyKey,
  effectKey,
  itemKey,
  rollKey,
  sceneActivatedKey,
  tokenAppearedKey,
} from "../src/protocol/keys.js";

/**
 * These strings are a contract with the server's partial unique index on
 * `session_entries (play_session_id, external_id)`. A change here is a change to
 * deduplication behaviour, so the exact expected values are spelled out rather
 * than computed.
 */
describe("idempotency keys", () => {
  it("builds a chat message key", () => {
    expect(chatMessageKey("abc123")).toBe("fvtt:msg:abc123");
  });

  it("uses the unsuffixed message key when a message carried exactly one roll", () => {
    expect(rollKey("abc123", 0, 1)).toBe("fvtt:msg:abc123");
  });

  it("suffixes with the roll index when a message carried several rolls", () => {
    expect(rollKey("abc123", 0, 3)).toBe("fvtt:msg:abc123:0");
    expect(rollKey("abc123", 1, 3)).toBe("fvtt:msg:abc123:1");
    expect(rollKey("abc123", 2, 3)).toBe("fvtt:msg:abc123:2");
  });

  it("gives every roll in a multi-roll message a distinct key", () => {
    const keys = [0, 1, 2, 3].map((index) => rollKey("m", index, 4));
    expect(new Set(keys).size).toBe(4);
  });

  it("is stable across calls — the whole point of sender-computed keys", () => {
    expect(rollKey("abc", 1, 2)).toBe(rollKey("abc", 1, 2));
  });

  it("builds combat turn keys that are naturally replay-safe", () => {
    expect(combatTurnKey("Scene.x.Combat.y", 3, 2)).toBe("fvtt:combat:Scene.x.Combat.y:3:2");
  });

  it("builds actor keys deduped by Foundry's own mtime", () => {
    expect(actorChangeKey("Actor.abc", 1_755_468_000_000)).toBe("fvtt:actor:Actor.abc:1755468000000");
  });
});

/**
 * Slice 3's additions. The shapes extend the design doc's table rather than
 * contradicting it — the server never parses a key, it only requires that one
 * event mints the same string every time and that two events never collide.
 */
describe("slice 3 idempotency keys", () => {
  it("builds combat start and end keys that need no timestamp", () => {
    expect(combatStartKey("Scene.s.Combat.k")).toBe("fvtt:combat:Scene.s.Combat.k:start");
    expect(combatEndKey("Scene.s.Combat.k")).toBe("fvtt:combat:Scene.s.Combat.k:end");
  });

  it("keeps a combat's start, end and turns apart", () => {
    const keys = [
      combatStartKey("C.1"),
      combatEndKey("C.1"),
      combatTurnKey("C.1", 1, 0),
      combatTurnKey("C.1", 1, 1),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("builds a token appearance key from the uuid alone — a token exists once", () => {
    expect(tokenAppearedKey("Scene.s.Token.t1")).toBe("fvtt:token:Scene.s.Token.t1:appeared");
  });

  it("accepts the Date-free sequence fallback as an actor stamp", () => {
    // `s1` rather than a wall clock: a replayed outbox has to mint the *same*
    // key it minted the first time, which `Date.now()` never would.
    expect(actorChangeKey("Actor.abc", "s1")).toBe("fvtt:actor:Actor.abc:s1");
  });

  it("builds effect keys that distinguish arriving from lifting", () => {
    expect(effectKey("Actor.a.ActiveEffect.e1", "added")).toBe("fvtt:effect:Actor.a.ActiveEffect.e1:added");
    expect(effectKey("Actor.a.ActiveEffect.e1", "removed")).toBe("fvtt:effect:Actor.a.ActiveEffect.e1:removed");
  });

  it("builds combatant keys stamped by mtime, because `defeated` can toggle", () => {
    expect(combatantKey("Combatant.c1", 1_755_468_000_000)).toBe("fvtt:combatant:Combatant.c1:1755468000000");
  });

  it("builds item keys that distinguish a grant from a loss", () => {
    expect(itemKey("Actor.a.Item.i1", "granted")).toBe("fvtt:item:Actor.a.Item.i1:granted");
    expect(itemKey("Actor.a.Item.i1", "removed")).toBe("fvtt:item:Actor.a.Item.i1:removed");
  });

  it("builds currency and scene keys stamped by mtime", () => {
    expect(currencyKey("Actor.abc", 1_755_468_000_000)).toBe("fvtt:currency:Actor.abc:1755468000000");
    expect(sceneActivatedKey("Scene.vallaki", 1_755_468_000_000)).toBe("fvtt:scene:Scene.vallaki:1755468000000");
  });

  it("gives every family its own namespace, so one document cannot collide with itself", () => {
    // An actor that takes damage, gains an item, gains an effect and spends coin
    // in the same millisecond is four entries, not one.
    const keys = [
      actorChangeKey("Actor.a", 1),
      currencyKey("Actor.a", 1),
      itemKey("Actor.a", "granted"),
      effectKey("Actor.a", "added"),
      tokenAppearedKey("Actor.a"),
      combatantKey("Actor.a", 1),
      sceneActivatedKey("Actor.a", 1),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is stable across calls — the whole point of sender-computed keys", () => {
    expect(combatStartKey("C.1")).toBe(combatStartKey("C.1"));
    expect(effectKey("E.1", "added")).toBe(effectKey("E.1", "added"));
    expect(actorChangeKey("A.1", 99)).toBe(actorChangeKey("A.1", 99));
  });
});
