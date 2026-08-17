import { describe, expect, it } from "vitest";
import { actorChangeKey, chatMessageKey, combatTurnKey, rollKey } from "../src/protocol/keys.js";

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
