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

export interface SystemAdapter {
  /** Foundry system id this adapter claims, or "*" for the fallback. */
  readonly id: string;
  /** Garnish for a `roll.made` envelope, or undefined for none. */
  rollExt(message: FoundryChatMessage, roll: FoundryRoll, context: AdapterContext): Record<string, unknown> | undefined;
  /** Garnish for a `chat.posted` envelope, or undefined for none. */
  chatExt(message: FoundryChatMessage, context: AdapterContext): Record<string, unknown> | undefined;
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
