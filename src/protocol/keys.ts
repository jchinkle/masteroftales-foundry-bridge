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

/**
 * `fvtt:combat:<combatUuid>:start` — a combat starts once. If `combatStart`
 * somehow fires twice for the same encounter, both mint the same key and the
 * second costs one `duplicate` receipt.
 */
export function combatStartKey(combatUuid: string): string {
  return `${KEY_PREFIX}:combat:${combatUuid}:start`;
}

/** `fvtt:combat:<combatUuid>:end` — and it ends once, for the same reason. */
export function combatEndKey(combatUuid: string): string {
  return `${KEY_PREFIX}:combat:${combatUuid}:end`;
}

/**
 * `fvtt:actor:<uuid>:<stamp>` — deduped by Foundry's own mtime.
 *
 * `uuid` is the **token** uuid for anything sourced from a token and the actor
 * uuid otherwise, because those are the two things that own a hit point pool: an
 * unlinked mook's HP lives on its token, and keying four goblins stamped from
 * one statblock off the shared actor would collapse them into a single line.
 *
 * `stamp` is the document's `_stats.modifiedTime`. Never a wall clock: `Date.now()`
 * changes on every call, so a replayed outbox would mint a *new* key for an event
 * the server already has and the log would double on every reconnect. See
 * `capture/documents.ts` for the Date-free fallback when `_stats` is absent.
 */
export function actorChangeKey(uuid: string, stamp: string | number): string {
  return `${KEY_PREFIX}:actor:${uuid}:${stamp}`;
}

/**
 * `fvtt:token:<tokenUuid>:appeared` — a token uuid exists exactly once in a
 * world, so an appearance needs no timestamp at all to be replay-safe. Deleting
 * and re-placing a token mints a new id, and that genuinely is a second
 * appearance.
 */
export function tokenAppearedKey(tokenUuid: string): string {
  return `${KEY_PREFIX}:token:${tokenUuid}:appeared`;
}

/**
 * `fvtt:effect:<effectUuid>:added|removed` — effect ids are minted per
 * application, so "poisoned, cured, poisoned again" is three documents and three
 * keys rather than one key used three times.
 */
export function effectKey(effectUuid: string, action: "added" | "removed"): string {
  return `${KEY_PREFIX}:effect:${effectUuid}:${action}`;
}

/** `fvtt:combatant:<combatantUuid>:<stamp>` — `defeated` can toggle, so the mtime stays. */
export function combatantKey(combatantUuid: string, stamp: string | number): string {
  return `${KEY_PREFIX}:combatant:${combatantUuid}:${stamp}`;
}

/** `fvtt:item:<itemUuid>:granted|removed`. */
export function itemKey(itemUuid: string, action: "granted" | "removed"): string {
  return `${KEY_PREFIX}:item:${itemUuid}:${action}`;
}

/** `fvtt:currency:<actorUuid>:<stamp>` — one purse change per actor per mtime. */
export function currencyKey(actorUuid: string, stamp: string | number): string {
  return `${KEY_PREFIX}:currency:${actorUuid}:${stamp}`;
}

/** `fvtt:scene:<sceneUuid>:<stamp>` — activating the same scene twice is two events. */
export function sceneActivatedKey(sceneUuid: string, stamp: string | number): string {
  return `${KEY_PREFIX}:scene:${sceneUuid}:${stamp}`;
}
