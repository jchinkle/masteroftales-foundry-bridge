import { KEY_PREFIX } from "./version.js";

/**
 * Idempotency keys, computed by the sender from things Foundry already
 * guarantees are stable. The server enforces uniqueness per session, so a
 * reconnect that replays its outbox costs a handful of `duplicate` receipts and
 * changes nothing.
 *
 * Pure functions, on purpose: this is the one piece of the module where a typo
 * turns a retry into a duplicated line in somebody's session log, and it is
 * therefore the piece that most deserves unit tests without a Foundry anywhere
 * near it.
 */

/** `fvtt:msg:<messageId>` — a chat message with no rolls in it. */
export function chatMessageKey(messageId: string): string {
  return `${KEY_PREFIX}:msg:${messageId}`;
}

/**
 * `fvtt:msg:<messageId>` for the single-roll case, `…:<index>` when one message
 * carried several rolls.
 *
 * The suffix is omitted for `total === 1` rather than always appended, because
 * the unsuffixed form is what the design doc's key table documents and what the
 * server's fixtures will most likely use. Appending `:0` unconditionally would
 * work too — but only if both repos agreed, and this way they need not.
 */
export function rollKey(messageId: string, index: number, total: number): string {
  const base = chatMessageKey(messageId);
  return total > 1 ? `${base}:${index}` : base;
}

/** `fvtt:combat:<combatUuid>:<round>:<turn>` — naturally unique, naturally replay-safe. */
export function combatTurnKey(combatUuid: string, round: number, turn: number): string {
  return `${KEY_PREFIX}:combat:${combatUuid}:${round}:${turn}`;
}

/** `fvtt:actor:<actorUuid>:<modifiedTime>` — deduped by Foundry's own mtime. */
export function actorChangeKey(actorUuid: string, modifiedTime: number): string {
  return `${KEY_PREFIX}:actor:${actorUuid}:${modifiedTime}`;
}
