import type { AdapterContext, SystemAdapter } from "../adapters/index.js";
import type { Combatant, Envelope } from "../protocol/types.js";
import type { PriorValues } from "./priorValues.js";

/**
 * The shared reading layer under `combat.ts`, `actors.ts`, `items.ts` and
 * `scenes.ts`.
 *
 * Everything here answers the same question in four different shapes: *what
 * does this document actually say, on whichever Foundry major the customer is
 * running, without throwing when the answer is "nothing"?* Every reader returns
 * `null` rather than a guess — the doctrine for this whole slice is **absent
 * over wrong**, because a null field is a shorter sentence in the log and a
 * wrong field is a sentence that lies.
 */

export interface DocumentContext {
  adapter: SystemAdapter;
  adapterContext: AdapterContext;
  /** Previous hit points and coin, which Foundry's update hooks never hand back. */
  prior: PriorValues;
  /**
   * A monotonic, **Date-free** discriminator, used only when a document arrives
   * with no `_stats.modifiedTime`.
   *
   * It has to be Date-free. An idempotency key is minted once, at capture, and
   * then travels with the envelope through every retry — so `Date.now()` would
   * be stable within one send and *different* on the reconnect that replays the
   * outbox, which is precisely the case idempotency keys exist to survive. A
   * counter is stable for the life of the page, and a page reload takes the
   * unsent outbox with it anyway.
   */
  sequence(): number;
  /** Injected clock, used only for the envelope `ts` of a document with no mtime. */
  now(): Date;
}

/** The registration shape every capture family in this slice shares. */
export interface DocumentCaptureDeps {
  hooks: Pick<FoundryHooks, "on">;
  /** The activation gate, re-read per event — see src/activation.ts. */
  isActive(): boolean;
  context(): DocumentContext;
  emit(envelope: Envelope): void;
  log?: { debug?(message: string, ...rest: unknown[]): void };
}

// ------------------------------------------------------------ scalar readers

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A plain object, or null. Arrays are not records; neither is a Foundry Collection. */
export function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------- document readers

export function docUuid(doc: FoundryDocument | null | undefined): string | null {
  return nonEmptyString(doc?.uuid);
}

export function docName(doc: FoundryDocument | null | undefined): string | null {
  return nonEmptyString(doc?.name);
}

/** `_stats.modifiedTime`, when it is a real epoch. Foundry writes it on every update. */
export function modifiedTime(doc: FoundryDocument | null | undefined): number | null {
  const value = finiteNumber(doc?._stats?.modifiedTime);
  return value !== null && value > 0 ? value : null;
}

/**
 * The idempotency key's trailing discriminator.
 *
 * `_stats.modifiedTime` where Foundry wrote one — it is exactly what the design
 * doc's key table asks for, it changes on every update, and it is identical on
 * every client, which is what makes a duplicate detectable. `s<n>` from the
 * injected counter otherwise, which happens for documents old enough to predate
 * `_stats` and for a couple of synthetic paths.
 *
 * Never a wall clock. See `DocumentContext.sequence`.
 */
export function changeStamp(doc: FoundryDocument | null | undefined, context: DocumentContext): string {
  const mtime = modifiedTime(doc);
  return mtime === null ? `s${context.sequence()}` : String(mtime);
}

/**
 * The envelope `ts`: when the thing happened at the *table*, not when we sent
 * it. `modifiedTime` is that moment for every document hook in this slice.
 */
export function documentTimestamp(
  doc: FoundryDocument | null | undefined,
  context: DocumentContext,
): string {
  const mtime = modifiedTime(doc);
  return new Date(mtime ?? context.now().getTime()).toISOString();
}

/**
 * Whether a parent document is an Actor.
 *
 * The check matters more than it looks: ActiveEffects live on Items as often as
 * on Actors, and Items live inside other Items in several systems. Capturing
 * "the sword gained an effect" as a condition on a character would be a wrong
 * line in the log rather than a missing one.
 *
 * `documentName` is a static on every Foundry Document class and has not moved
 * between majors. When it is absent the answer is *no* — a plain source object
 * that never named itself is not evidence of an Actor.
 */
export function isActorDocument(doc: FoundryDocument | null | undefined): boolean {
  return nonEmptyString(doc?.documentName) === "Actor";
}

/**
 * Foundry's `EmbeddedCollection` is a Map subclass, so spreading it yields
 * `[id, doc]` pairs rather than documents. `.contents` is the documented array
 * accessor and is present on v11–v14; a plain array (our stubs, and a couple of
 * source-object paths) is passed through; anything else iterable is a last
 * resort.
 */
export function collectionValues<T>(collection: unknown): T[] {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection as T[];

  const contents = (collection as { contents?: unknown }).contents;
  if (Array.isArray(contents)) return contents as T[];

  const values = (collection as { values?: () => Iterable<unknown> }).values;
  if (typeof values === "function") {
    try {
      return [...values.call(collection)] as T[];
    } catch {
      return [];
    }
  }

  if (typeof (collection as Iterable<unknown>)[Symbol.iterator] === "function") {
    try {
      return [...(collection as Iterable<unknown>)] as T[];
    } catch {
      return [];
    }
  }

  return [];
}

/** Walks a dotted path through nested plain objects. Missing at any depth is null. */
export function readPath(source: unknown, path: readonly string[]): unknown {
  let node: unknown = source;
  for (const step of path) {
    const record = plainRecord(node);
    if (!record) return null;
    node = record[step];
  }
  return node ?? null;
}

/** `readPath`, narrowed to a record. */
export function recordAt(source: unknown, path: readonly string[]): Record<string, unknown> | null {
  return plainRecord(readPath(source, path));
}

// --------------------------------------------------------------- token bits

/**
 * v10 moved a token's image from `img` to `texture.src`. Both are read because
 * `compatibility.minimum` is 13 but a world migrated forward from v9 can still
 * hold source data with the old key.
 */
export function tokenImage(token: FoundryTokenDocument | null | undefined): string | null {
  return nonEmptyString(token?.texture?.src) ?? nonEmptyString(token?.img) ?? nonEmptyString(token?.actor?.img);
}

/**
 * **The privacy rule, in one function.**
 *
 * v1 captures everything publicly except what came from a hidden token, which is
 * marked `private` and lands in MoT as GM-only. A GM who hides a token has made
 * exactly one statement about it — *the players cannot see this* — and it is the
 * only signal in Foundry that maps cleanly onto "do not put this in the shared
 * log". Ownership and permission levels do not: they are about who may edit a
 * sheet, not about what the table has witnessed.
 */
export function isHidden(token: FoundryTokenDocument | null | undefined): boolean {
  return token?.hidden === true;
}

/**
 * An unlinked token's overrides. v11 renamed `actorData` to `delta`; both
 * spellings are read because the rename is exactly the kind of thing that turns
 * "nothing ever takes damage" into a silent, system-wide capture failure — and
 * because `updateToken`'s diff is the *only* place a mook's hit points appear.
 */
export function tokenDelta(source: unknown): Record<string, unknown> | null {
  const record = plainRecord(source);
  if (!record) return null;
  return plainRecord(record.delta) ?? plainRecord(record.actorData);
}

// ----------------------------------------------------------- combatant bits

/**
 * `{name, actorUuid, tokenUuid, disposition}` from a combatant, falling back
 * through the token and the actor for each field independently — a combatant
 * with a custom name, no actor and a deleted token still produces three nulls
 * and a name rather than nothing at all.
 */
export function combatantRef(combatant: FoundryCombatant | null | undefined): Combatant | null {
  if (!combatant) return null;

  const token = combatant.token ?? null;
  const actor = combatant.actor ?? null;

  return {
    name: docName(combatant) ?? docName(token) ?? docName(actor),
    actorUuid: docUuid(actor) ?? nonEmptyString(combatant.actorId),
    tokenUuid: docUuid(token) ?? nonEmptyString(combatant.tokenId),
    disposition: finiteNumber(token?.disposition),
  };
}
