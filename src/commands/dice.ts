import { escapeHtml, stripHtml, truncate } from "../capture/html.js";
import { bridgeOriginFlags } from "../capture/loopGuard.js";
import type { CommandLog } from "./index.js";
import { speakerAlias } from "./index.js";

/**
 * `dice.show` — MoT rolled dice in its own tray, and the table should see them
 * land.
 *
 * The trick this file exists for: rather than *describing* a roll to Foundry, it
 * rebuilds one as a **real, already-evaluated `Roll`** whose die faces are the
 * faces MoT rolled, and `toMessage`s it. Everything downstream then works for
 * free — the chat card renders like any other roll, and **Dice So Nice animates
 * the predetermined faces on every player's screen** without this module
 * knowing that module exists. A hand-built `<div>` of dice images would have
 * bought a worse version of both.
 *
 * Everything with a decision in it is a pure function of the payload:
 * `planDiceShow` validates and normalises, `buildRoll` turns a plan into terms,
 * `diceMessageData` builds the `toMessage` argument. The Foundry classes arrive
 * through `DiceApi`, resolved from the global scope by `resolveDiceApi`, so the
 * tests drive the whole path against three-line fakes.
 *
 * Two rules hold throughout, and they are the same two the capture layer holds:
 * **absent over wrong** (a malformed group drops the command rather than
 * inventing a die), and **never throw** (a command that cannot be rendered is a
 * missing animation, never a broken socket).
 */

// ------------------------------------------------------------------ the wire

/** One dice group as MoT sends it. */
export interface DiceShowDie {
  sides?: unknown;
  values?: unknown;
  /** Parallel to `values`; false where MoT discarded that die (kh/kl). */
  kept?: unknown;
}

export interface DiceShowPayload {
  formula?: unknown;
  total?: unknown;
  dice?: unknown;
  modifier?: unknown;
  flavor?: unknown;
  speaker?: { alias?: unknown } | null;
}

// ------------------------------------------------------------------ the plan

/** A `DiceTerm.results` entry, in the shape both v13 and v14 store. */
export interface DieResultSpec {
  result: number;
  active: boolean;
  discarded: boolean;
}

export interface DieSpec {
  faces: number;
  number: number;
  results: DieResultSpec[];
}

/**
 * A validated `dice.show`, with every judgement already made. The renderer below
 * it does no checking at all, which is what makes it three lines long.
 */
export interface RollPlan {
  dice: DieSpec[];
  /** Null when absent or zero — a `+ 0` term is noise on the chat card. */
  modifier: number | null;
  /** MoT's total. It is the authority; see `buildRoll`. */
  total: number | null;
  /** MoT's formula string, or null. Display only. */
  formula: string | null;
  /** Already HTML-escaped, because Foundry renders flavor as markup. */
  flavor: string | null;
  /** Trimmed; rendered by Foundry's own (escaping) template, so not escaped here. */
  alias: string | null;
}

/** Flavor is a sentence, not an essay. Well inside anything Foundry minds. */
export const MAX_FLAVOR_LENGTH = 500;

/** A formula is `2d20kh1 + 5`, not a paragraph. Display only, so a cap is enough. */
export const MAX_FORMULA_LENGTH = 200;

/**
 * The most dice one command may carry. Not a security boundary — the token that
 * can send this can already post entries — but a wrong number should cost one
 * silly chat card, not a browser that stops responding while Dice So Nice
 * animates fifty thousand d6.
 */
export const MAX_DICE_PER_ROLL = 100;

/**
 * Validates and normalises a `dice.show` payload.
 *
 * Returns null — "drop this calmly" — when there is nothing renderable: no dice
 * at all, a group with non-numeric faces or values, or a payload that is not an
 * object. **Pure**, so every shape in the contract (kept arrays, d100s, a zero
 * or negative modifier, a missing flavor or speaker) is a unit test rather than
 * something a human has to reproduce at a table.
 */
export function planDiceShow(payload: unknown): RollPlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as DiceShowPayload;
  if (!Array.isArray(source.dice) || source.dice.length === 0) return null;

  const dice: DieSpec[] = [];
  let counted = 0;

  for (const entry of source.dice) {
    const spec = planDie(entry);
    // One malformed group drops the whole command rather than rendering a roll
    // that is missing a die: a d20 shown without its damage dice is a wrong
    // answer, and a wrong answer is worse than a missing animation.
    if (!spec) return null;
    counted += spec.number;
    if (counted > MAX_DICE_PER_ROLL) return null;
    dice.push(spec);
  }

  return {
    dice,
    modifier: modifierOf(source.modifier),
    total: finite(source.total),
    formula: text(source.formula, MAX_FORMULA_LENGTH),
    flavor: flavorOf(source.flavor),
    alias: speakerAlias(source.speaker?.alias),
  };
}

function planDie(entry: unknown): DieSpec | null {
  if (!entry || typeof entry !== "object") return null;

  const die = entry as DiceShowDie;

  const faces = finite(die.sides);
  if (faces === null || !Number.isInteger(faces) || faces < 1) return null;

  if (!Array.isArray(die.values) || die.values.length === 0) return null;
  const kept = Array.isArray(die.kept) ? die.kept : null;

  const results: DieResultSpec[] = [];
  for (const [index, value] of die.values.entries()) {
    const result = finite(value);
    if (result === null) return null;
    // A `kept` array shorter than `values` means "kept" for the entries it does
    // not reach — absent over wrong, and the direction that shows more dice.
    const active = kept ? kept[index] !== false : true;
    results.push({ result, active, discarded: !active });
  }

  return { faces, number: results.length, results };
}

/**
 * Stripped, truncated, *then* escaped. Stripping decodes entities, so escaping
 * has to come second or the result would not be inert; and truncation happens on
 * the plain text, or a cut could land inside an escape and produce `&am`.
 */
function flavorOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return nullIfEmpty(escapeHtml(truncate(stripHtml(value), MAX_FLAVOR_LENGTH)));
}

function modifierOf(value: unknown): number | null {
  const modifier = finite(value);
  return modifier === null || modifier === 0 ? null : modifier;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return nullIfEmpty(truncate(value.trim(), max));
}

function nullIfEmpty(value: string): string | null {
  return value === "" ? null : value;
}

// -------------------------------------------------------------- foundry glue

/** The `Roll` instance surface this module touches. Deliberately tiny. */
export interface RollLike {
  toMessage(data: Record<string, unknown>, options?: Record<string, unknown>): unknown;
}

/**
 * The four Foundry classes `dice.show` needs.
 *
 * They live at `foundry.dice.terms.*` from v12 onwards; the bare globals still
 * exist on v13 (deprecated) and are gone on v14, which is why the namespace is
 * preferred and the global is only a fallback.
 */
export interface DiceApi {
  Die: new (data: Record<string, unknown>) => object;
  OperatorTerm: new (data: Record<string, unknown>) => object;
  NumericTerm: new (data: Record<string, unknown>) => object;
  Roll: { fromTerms(terms: object[], options?: Record<string, unknown>): RollLike };
}

/**
 * Picks the dice classes out of a global scope, namespaced spelling first.
 *
 * Takes the scope as an argument rather than reading `globalThis` directly so it
 * is a pure function with a test per version shape — this is the single place
 * where "v13 or v14?" is answered, and it is the one thing here that cannot be
 * checked by running the suite on a laptop.
 *
 * Returns null when the scope is not a Foundry (which is every unit test, and
 * also a client where the module somehow loaded before core did).
 */
export function resolveDiceApi(scope: unknown): DiceApi | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const foundry = global.foundry as { dice?: { terms?: Record<string, unknown>; Roll?: unknown } } | undefined;
  const terms = foundry?.dice?.terms;

  const Die = constructorOf(terms?.Die ?? global.Die);
  const OperatorTerm = constructorOf(terms?.OperatorTerm ?? global.OperatorTerm);
  const NumericTerm = constructorOf(terms?.NumericTerm ?? global.NumericTerm);
  const RollClass = (foundry?.dice?.Roll ?? global.Roll) as DiceApi["Roll"] | undefined;

  if (!Die || !OperatorTerm || !NumericTerm) return null;
  if (!RollClass || typeof RollClass.fromTerms !== "function") return null;

  return { Die, OperatorTerm, NumericTerm, Roll: RollClass };
}

function constructorOf(value: unknown): (new (data: Record<string, unknown>) => object) | null {
  return typeof value === "function" ? (value as new (data: Record<string, unknown>) => object) : null;
}

/**
 * Plan in, evaluated `Roll` out.
 *
 * The three version-sensitive moves, all of them here:
 *
 *  1. **Every term is marked evaluated, including the operators.**
 *     `Roll.fromTerms` refuses a mix ("all evaluated, or none"), and a freshly
 *     constructed `OperatorTerm` is not evaluated while a `Die` carrying results
 *     may or may not be, depending on the major. Marking all of them is the only
 *     spelling that is true on both.
 *  2. **The roll itself is marked evaluated and its total overwritten.**
 *     v13 computes `_total` inside `fromTerms`; v14's path differs. MoT's total
 *     is the authority either way — it is the number the GM already read off
 *     their own screen, and a Foundry card disagreeing with it is the bug this
 *     command exists to avoid.
 *  3. **`_formula` is set to MoT's formula when it sent one**, so the card reads
 *     `2d20kh1 + 5` rather than the `2d20 + 5` that regenerating from terms
 *     would produce. Best-effort: if a future major makes it getter-only the
 *     assignment is swallowed and the derived formula stands.
 *
 * Returns null if Foundry rejects the terms — a system that has replaced `Die`
 * with something stricter is a shrug, not an exception.
 */
export function buildRoll(plan: RollPlan, api: DiceApi): RollLike | null {
  try {
    const terms: object[] = [];

    for (const spec of plan.dice) {
      if (terms.length > 0) terms.push(new api.OperatorTerm({ operator: "+" }));
      terms.push(
        new api.Die({
          number: spec.number,
          faces: spec.faces,
          // Fresh objects: Foundry mutates result entries (Dice So Nice marks
          // them shown), and the plan is meant to stay a value.
          results: spec.results.map((result) => ({ ...result })),
        }),
      );
    }

    if (plan.modifier !== null) {
      // Sign lives on the operator, so the card reads `- 2` rather than `+ -2`.
      terms.push(new api.OperatorTerm({ operator: plan.modifier < 0 ? "-" : "+" }));
      terms.push(new api.NumericTerm({ number: Math.abs(plan.modifier) }));
    }

    for (const term of terms) assign(term, "_evaluated", true);

    const roll = api.Roll.fromTerms(terms);
    if (!roll || typeof roll.toMessage !== "function") return null;

    assign(roll, "_evaluated", true);
    if (plan.total !== null) assign(roll, "_total", plan.total);
    if (plan.formula !== null) assign(roll, "_formula", plan.formula);

    return roll;
  } catch {
    return null;
  }
}

/** Best-effort write of a Foundry private field. Getter-only? Then never mind. */
function assign(target: object, key: string, value: unknown): void {
  try {
    (target as Record<string, unknown>)[key] = value;
  } catch {
    // A future major made it read-only. The derived value stands.
  }
}

/**
 * Foundry's roll modes are a *client* setting — whatever is selected in the chat
 * bar's dropdown right now. A mirrored roll must not inherit it: the GM setting
 * "Private GM Roll" to hide their own next attack has said nothing at all about
 * dice they deliberately asked MoT to show the table.
 */
export const PUBLIC_ROLL = "publicroll";

/**
 * The `toMessage` argument. Pure, and separate from the call, because the flag
 * on it is the thing that stops the echo and a test should be able to read it
 * without a Foundry.
 *
 * `speaker` and `flavor` are **omitted** rather than sent as null: Foundry fills
 * an absent speaker with the current user, and an explicit null flavor renders
 * as an empty line in some systems' cards.
 */
export function diceMessageData(plan: RollPlan): Record<string, unknown> {
  const data: Record<string, unknown> = { flags: bridgeOriginFlags() };
  if (plan.alias !== null) data.speaker = { alias: plan.alias };
  if (plan.flavor !== null) data.flavor = plan.flavor;
  return data;
}

// ----------------------------------------------------------------- the handler

export interface DiceShowDeps {
  /**
   * The activation gate, read per command. **Only the active GM renders.**
   * Without this every connected client creates its own chat message and the
   * table sees the roll once per browser — the outbound mirror of the
   * two-GMs-capture-everything-twice bug in src/activation.ts.
   */
  isActive(): boolean;
  /** Resolves the Foundry dice classes. Called per command, not cached. */
  api(): DiceApi | null;
  log?: CommandLog;
}

/**
 * The `dice.show` renderer, as the dispatcher wires it.
 *
 * Every exit is silent-at-debug: not the active GM, nothing renderable in the
 * payload, no Foundry to render it with, or `toMessage` rejecting. Outbound
 * commands are perishable and unacked (see `Bridge::Commands` on the server), so
 * there is nothing to report and nobody to report it to.
 */
export function createDiceShowHandler(deps: DiceShowDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planDiceShow(payload);
    if (!plan) {
      deps.log?.debug?.("[masteroftales-bridge] dropping a dice.show with nothing renderable in it", payload);
      return;
    }

    const api = deps.api();
    if (!api) {
      deps.log?.debug?.("[masteroftales-bridge] no Foundry dice classes available; dropping dice.show");
      return;
    }

    const roll = buildRoll(plan, api);
    if (!roll) {
      deps.log?.debug?.("[masteroftales-bridge] could not build a Roll for dice.show", plan);
      return;
    }

    try {
      // `toMessage` is a promise on both majors. Nothing waits on it — the
      // command is fire-and-forget by design — but a rejection must not surface
      // as an unhandled rejection in the customer's console.
      void Promise.resolve(roll.toMessage(diceMessageData(plan), { rollMode: PUBLIC_ROLL })).catch((error: unknown) => {
        deps.log?.debug?.("[masteroftales-bridge] dice.show could not be posted to chat", error);
      });
    } catch (error) {
      deps.log?.debug?.("[masteroftales-bridge] dice.show could not be posted to chat", error);
    }
  };
}
