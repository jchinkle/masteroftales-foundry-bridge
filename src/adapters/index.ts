import { genericAdapter } from "./generic.js";
import { dnd5eAdapter } from "./dnd5e.js";

/**
 * System adapters produce `ext` — and *only* `ext`.
 *
 * The contract this module is built on is Foundry's core document hooks, which
 * every system goes through. An adapter may make a 5e line read better; it may
 * never be the reason a line exists. If an adapter ever produces a field the
 * server branches on, the feature has quietly become a 5e feature and every
 * Pathfinder table is a bug report. That rule is enforced on the server ("mappers,
 * validators and policies may not read `ext`") and respected here by keeping the
 * adapter's whole output confined to the envelope's `ext` key.
 */

export interface AdapterContext {
  systemId: string;
  systemVersion: string;
}

/**
 * What an adapter is shown of an actor update: the post-update `system` data and
 * the `system` node of the diff that produced it.
 *
 * Both, not one. The diff says *what this update was about* — the difference
 * between somebody taking damage and somebody renaming a token — while the
 * document says what the values now are. An adapter reading only the diff would
 * garnish every save-the-sheet with stale numbers; reading only the document, it
 * could not tell whether anything relevant had moved.
 */
export interface SystemDataSource {
  system: Record<string, unknown> | null;
  delta: Record<string, unknown> | null;
}

/**
 * Coin, as a system that has coin reports it.
 *
 * `current` is every denomination the actor now holds; `changed` is the subset
 * this update touched. The capture layer pairs `changed` with what it last saw
 * to build the `from`/`to` maps — the adapter remembers nothing and decides
 * nothing about the log.
 */
export interface CurrencyDetection {
  current: Record<string, number>;
  changed: string[];
}

export interface SystemAdapter {
  /** Foundry system id this adapter claims, or "*" for the fallback. */
  readonly id: string;
  /** Garnish for a `roll.made` envelope, or undefined for none. */
  rollExt(message: FoundryChatMessage, roll: FoundryRoll, context: AdapterContext): Record<string, unknown> | undefined;
  /** Garnish for a `chat.posted` envelope, or undefined for none. */
  chatExt(message: FoundryChatMessage, context: AdapterContext): Record<string, unknown> | undefined;
  /** Garnish for an `actor.changed` envelope — temp HP and the like. */
  actorExt(source: SystemDataSource, context: AdapterContext): Record<string, unknown> | undefined;
  /**
   * **The one place an adapter contributes payload rather than `ext`, and it is
   * deliberate.**
   *
   * Core Foundry has no concept of currency. No document field, no hook, no
   * shape to read — coin is a thing *systems* invent, in their own places, with
   * their own denominations. So unlike hit points (which every system spells
   * differently but every system has), there is no honest generic reading to
   * fall back to: a `currency.changed` event either comes from system knowledge
   * or it does not exist at all.
   *
   * The boundary still holds where it matters. The adapter answers exactly one
   * question — "did this update move coin, and what does the purse hold now?" —
   * while the event type, the payload shape, the idempotency key and the
   * decision to emit stay in `capture/items.ts`, identical for every system that
   * answers. The server receives an ordinary `currency.changed` and cannot tell
   * which adapter spoke. A Pathfinder table gets no coin lines until somebody
   * writes `adapters/pf2e.ts`, and every other line in its log is unaffected —
   * which is the design working, not the design leaking.
   */
  currency(source: SystemDataSource, context: AdapterContext): CurrencyDetection | undefined;
}

const ADAPTERS: SystemAdapter[] = [dnd5eAdapter];

/** Never returns undefined — an unknown system gets the generic adapter, which garnishes nothing. */
export function selectAdapter(systemId: string | null | undefined): SystemAdapter {
  const id = (systemId ?? "").trim();
  return ADAPTERS.find((adapter) => adapter.id === id) ?? genericAdapter;
}

/**
 * Merges an adapter's output into an envelope-ready `ext`, dropping empties so
 * a generic system never ships `"ext": {}` on every event.
 */
export function toExt(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return Object.keys(value).length > 0 ? value : undefined;
}
