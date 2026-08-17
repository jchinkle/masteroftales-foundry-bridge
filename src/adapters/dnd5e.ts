import type { AdapterContext, CurrencyDetection, SystemAdapter, SystemDataSource } from "./index.js";

/**
 * dnd5e enrichment.
 *
 * Everything here is read from **document flags, roll options and system data** —
 * never from dnd5e's own hooks. `dnd5e.rollAttack` and friends fire only on the
 * client that initiated the roll (so the active GM would miss every player's) and
 * they have changed shape at every major. The design doc's rule: system hooks are
 * fine as a source of garnish, never as the contract. This file does not even use
 * them as garnish.
 *
 * The other rule this file obeys is that **it may be wrong about nothing**. Every
 * reader below returns undefined rather than a guess, and every field is omitted
 * rather than defaulted, because `ext` exists to make a line read better and a
 * confidently wrong "advantage" on a straight roll is worse than a plain line.
 *
 * dnd5e has moved advantage between three homes across its 2.x–5.x lifetime, and
 * a customer's world may be running any of them. All three are read, cheapest
 * and most authoritative first.
 */

/** dnd5e's `D20Roll.ADV_MODE`: 1 advantage, 0 normal, -1 disadvantage. */
const ADV_MODE_ADVANTAGE = 1;
const ADV_MODE_DISADVANTAGE = -1;

type AdvantageState = "advantage" | "disadvantage" | null;

export const dnd5eAdapter: SystemAdapter = {
  id: "dnd5e",

  rollExt(message, roll, context) {
    const dnd5e: Record<string, unknown> = base(context);

    const state = advantageState(message, roll);
    // One key, set only when detected. Emitting `advantage: false` on every
    // straight roll would be a claim the reader below cannot actually support:
    // "we found no evidence of advantage" and "this roll was straight" are
    // different sentences, and only the first one is true.
    if (state === "advantage") dnd5e.advantage = true;
    if (state === "disadvantage") dnd5e.disadvantage = true;

    return { dnd5e };
  },

  chatExt(_message, context) {
    return { dnd5e: base(context) };
  },

  /**
   * Temporary hit points, which are the reason a 5e combat log otherwise reads
   * wrong: a barbarian at 40/40 who soaks 12 damage into 15 temp shows *no core
   * hp change at all*, so the core capture correctly says nothing happened to
   * their hit points and this says what actually absorbed it.
   */
  actorExt(source, context) {
    const dnd5e: Record<string, unknown> = base(context);

    // Only when this update was about hit points. `system.attributes.hp.temp`
    // holds a value all the time; reporting it on a rename would attach a
    // number to an event it had nothing to do with.
    if (record(source.delta, ["attributes", "hp"])) {
      const temp = numeric(read(source.system, ["attributes", "hp", "temp"]));
      // dnd5e stores 0 and null interchangeably for "none". Both are "no temp
      // hp", and neither is worth a line.
      if (temp !== undefined && temp > 0) dnd5e.tempHp = temp;
    }

    return { dnd5e };
  },

  /**
   * `system.currency` — `{pp, gp, ep, sp, cp}`.
   *
   * The changed set comes from the *diff*, so "the party spent 3 gp" reports gp
   * and not the four denominations that happened to sit beside it in the same
   * object.
   */
  currency(source: SystemDataSource): CurrencyDetection | undefined {
    const changedNode = record(source.delta, ["currency"]);
    if (!changedNode) return undefined;

    const changed = Object.keys(changedNode).filter((key) => numeric(changedNode[key]) !== undefined);
    if (changed.length === 0) return undefined;

    // The post-update purse where the document carried one, the diff otherwise:
    // an `updateActor` that replaced the whole currency object is the second
    // case, and it is the one where the diff *is* the truth.
    const currentNode = record(source.system, ["currency"]) ?? changedNode;
    const current: Record<string, number> = {};
    for (const [key, value] of Object.entries(currentNode)) {
      const amount = numeric(value);
      if (amount !== undefined) current[key] = amount;
    }

    return { current, changed };
  },
};

function base(context: AdapterContext): Record<string, unknown> {
  return { system: context.systemId, systemVersion: context.systemVersion };
}

/**
 * Advantage, from whichever of dnd5e's three homes this world's version uses.
 *
 * 1. **`roll.options`** — where `D20Roll` has kept it since 2.x, as an
 *    `advantageMode` enum in newer versions and as `advantage`/`disadvantage`
 *    booleans in older ones. Authoritative: it is what the system itself
 *    decided, before any dice were touched.
 * 2. **`message.flags.dnd5e.roll`** — the same fields, denormalised onto the
 *    chat message. Present on 3.x+ and the only source that survives a roll
 *    reconstructed from message source data.
 * 3. **The dice themselves** — a d20 rolled twice with a `kh`/`kl` modifier.
 *    A structural reading, so it works on a homebrew macro that built the roll
 *    by hand and never set an option; and `2d20kh1` in 5e means advantage
 *    whatever produced it.
 *
 * The formula is *not* consulted as a fourth fallback. `2d20kh1` inside a larger
 * expression, a `kh` on a damage pool, and an elven-accuracy `3d20kh1` all read
 * as advantage to a regex and are not reliably that.
 */
export function advantageState(
  message: FoundryChatMessage | null | undefined,
  roll: FoundryRoll | null | undefined,
): AdvantageState {
  return (
    fromOptions(roll?.options) ??
    fromOptions(flagRoll(message)) ??
    fromTerms(roll) ??
    null
  );
}

function fromOptions(options: unknown): AdvantageState {
  const source = record(options, []);
  if (!source) return null;

  if (source.advantage === true) return "advantage";
  if (source.disadvantage === true) return "disadvantage";

  const mode = numeric(source.advantageMode);
  if (mode === ADV_MODE_ADVANTAGE) return "advantage";
  if (mode === ADV_MODE_DISADVANTAGE) return "disadvantage";

  return null;
}

function flagRoll(message: FoundryChatMessage | null | undefined): unknown {
  return read(message?.flags ?? null, ["dnd5e", "roll"]);
}

/**
 * A d20 term rolled more than once, keeping the highest or the lowest.
 *
 * `roll.dice` rather than `roll.terms`: Foundry has already filtered it to the
 * DiceTerms, so this does not have to know how operators and parenthetical terms
 * are represented in whichever major is running — the one part of the roll API
 * that genuinely churns.
 */
function fromTerms(roll: FoundryRoll | null | undefined): AdvantageState {
  for (const die of roll?.dice ?? []) {
    if (die?.faces !== 20) continue;
    if ((die.number ?? die.results?.length ?? 0) < 2) continue;

    for (const modifier of die.modifiers ?? []) {
      const normalized = String(modifier).toLowerCase();
      if (normalized.startsWith("kh")) return "advantage";
      if (normalized.startsWith("kl")) return "disadvantage";
    }
  }
  return null;
}

// --------------------------------------------------------------- tiny readers
//
// Deliberately local rather than imported from capture/documents.ts: an adapter
// reads shapes nothing else in the module reads, and the day a core reader gains
// a behaviour that suits capture is not a day this file should change with it.

function record(source: unknown, path: readonly string[]): Record<string, unknown> | null {
  let node: unknown = source;
  for (const step of path) {
    if (!isRecord(node)) return null;
    node = node[step];
  }
  return isRecord(node) ? node : null;
}

function read(source: unknown, path: readonly string[]): unknown {
  let node: unknown = source;
  for (const step of path) {
    if (!isRecord(node)) return undefined;
    node = node[step];
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
