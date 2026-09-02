import { collectionValues } from "../capture/documents.js";
import { truncate } from "../capture/html.js";

/**
 * One actor's sheet, as this world holds it — the answer to one
 * `actor.sheet.request` (see commands/actorSheet.ts).
 *
 * It is the sibling of `protocol/actors.ts`'s catalog and the opposite of it in
 * every dimension that matters, which is worth stating plainly because the two
 * files sit next to each other and the catalog's header says "four fields, and
 * no fifth":
 *
 *  1. **The catalog is a pick-list; this is one sheet.** A catalog carries four
 *     display fields for five hundred actors and is sent unasked, twice a month.
 *     This carries a whole creature's system data for **exactly one actor**, and
 *     only because a human in Master of Tales pointed at it and pressed a button.
 *     Nothing here widens the catalog, and nothing here should tempt anybody to.
 *  2. **It is pushed, not pulled — same as everything else.** Nothing ever
 *     connects *into* a customer's Foundry. MoT rings the doorbell over the
 *     socket it already holds (`actor.sheet.request`), and this module answers
 *     with a POST of its own, carrying back the `requestId` MoT minted so the
 *     two halves can be matched on the side where the ids live.
 *  3. **The module trims; Master of Tales interprets.** What travels is the
 *     actor's own `system` object and a shortlist of its items, near enough raw.
 *     Not an armour class, not a saving throw, not a challenge rating — working
 *     out what any of those *are* is 5e knowledge, and 5e knowledge lives in
 *     MoT's game-system registry (and, in this repo, only in `adapters/`). The
 *     one system-shaped decision made here is **which item types are worth
 *     sending**, and it is asked of the adapter rather than hard-coded.
 *  4. **No user, member or role id ever rides here.** The same wall the whole
 *     bridge wire keeps, in both directions, forever. A sheet is a creature.
 */

/**
 * One item off the actor, trimmed to what a statblock could possibly need.
 *
 * `sort` travels because it is the order the sheet itself shows them in, and a
 * creature's actions read in the order their keeper arranged them. `system` is
 * the item's own system data, which is where a weapon's damage formula and a
 * feature's description live.
 */
export interface SheetItem {
  name: string;
  type: string | null;
  sort: number | null;
  system: Record<string, unknown>;
}

/**
 * The other shape the same door takes: **this world could not answer**.
 *
 * A refusal travels home rather than staying in a toast, and that is the whole
 * decision. The keeper is not looking at Foundry — they are standing in Master
 * of Tales with an import dialog open, watching a spinner. "That creature was
 * deleted since you last refreshed the list" is a sentence they can act on, and
 * twelve seconds of silence followed by a timeout is not. The notification on
 * this screen still happens; it is just no longer the only place the news goes.
 *
 * Three fields and no fourth. In particular no `system` key: MoT tells the two
 * apart by which one is present, and a refusal carrying an empty sheet is a
 * refusal that could be applied over the creature somebody already had.
 */
export interface ActorSheetFailure {
  requestId: string;
  actorId: string;
  /** One clause, in the module's own voice. Shown to a person by MoT. */
  error: string;
}

/** The refusal body, as a value, so its shape is a unit test. */
export function actorSheetFailure(
  requestId: string,
  actorId: string,
  reason: string,
): ActorSheetFailure {
  return { requestId, actorId, error: truncate(reason.trim(), MAX_REASON_LENGTH) };
}

/** A reason is one clause. MoT caps it again on arrival, at the same number. */
export const MAX_REASON_LENGTH = 200;

/** The `POST /api/v1/bridge/actor_sheets` body, as a value. */
export interface ActorSheetBody {
  /** The opaque correlation string MoT minted, echoed back verbatim. Never parsed here. */
  requestId: string;
  /** Foundry's own actor id — the one MoT named in the request. */
  actorId: string;
  /** Foundry's own name for the creature. Never empty; falls back to the id. */
  name: string;
  /** `game.system.id` — which game this sheet is written in, said out loud. */
  foundrySystemId: string;
  /** The actor's `system` data, as JSON. */
  system: Record<string, unknown>;
  items: SheetItem[];
  /**
   * True when the cap below took something out. MoT shows it as a line in the
   * dialog rather than as a failure: a creature whose longest three feature
   * descriptions were dropped is still a statblock worth importing, and silence
   * about it would be the dishonest half of the bargain.
   */
  truncated: boolean;
}

/** A creature's name is a name. Anything longer is a payload bug. */
export const MAX_SHEET_NAME_LENGTH = 120;

/**
 * The most items one sheet may carry.
 *
 * A 5e NPC has a dozen; a player character with three spell lists has two
 * hundred and fifty, and the two-hundred-and-fifty-first is not the one anybody
 * is putting in a statblock. The cap keeps a pathological sheet from reaching
 * the byte budget below by sheer count and having every description blanked for
 * it.
 */
export const MAX_SHEET_ITEMS = 200;

/**
 * The hard cap on the whole POST body.
 *
 * A quarter of a megabyte is enormous for a creature and small for a browser,
 * which is exactly the band a cap wants to sit in. Over it, descriptions go
 * first and whole items second — see {@link trimSheetBody} — because a
 * statblock's numbers are worth far more than its prose and the numbers are the
 * cheap half.
 */
export const MAX_SHEET_BYTES = 256_000;

/** What {@link actorSheetBody} is shown of an actor, already flattened to JSON. */
export interface SheetActorSource {
  name: string | null;
  system: Record<string, unknown>;
  items: unknown;
}

/**
 * An Actor document read as plain, freshly-owned JSON.
 *
 * **The live `system` object first, and `toObject()` only as a fallback.** That
 * order is the load-bearing decision in this file, and it is the opposite of
 * what looks right at a glance. `toObject()` returns *source* data — the fields
 * a keeper typed — while what a statblock is made of is very largely
 * **derived**: the armour class a system worked out from its calculation, the
 * proficiency bonus it derived from a challenge rating, the total on each
 * proficient skill, the modifier under each ability score. A sheet built from
 * source data alone would arrive in Master of Tales with half its numbers
 * missing and no way to tell that they had ever existed. The live data model
 * carries both, because a system writes its derived values onto it.
 *
 * Everything is put through one `JSON.parse(JSON.stringify(…))` here, per part,
 * which does three jobs at once: it flattens Foundry's data models to plain
 * objects, it hands back copies so nothing downstream can edit somebody's world
 * by trimming a description, and it is where a data model that cannot be
 * serialised at all falls back to source data instead of taking the whole sheet
 * down with it.
 *
 * Null for anything that is not an object — a lookup that missed, a client
 * mid-teardown — so the caller has one absence to handle.
 */
export function readSheetSource(actor: unknown): SheetActorSource | null {
  if (!actor || typeof actor !== "object") return null;

  const live = actor as Record<string, unknown>;
  const source = sourceOf(live);

  return {
    name: nonEmpty(live.name) ?? nonEmpty(source?.name),
    system: plain(live.system) ?? plain(source?.system) ?? {},
    items: collectionValues<unknown>(live.items).length > 0 ? live.items : (source?.items ?? live.items),
  };
}

/**
 * The items worth sending, filtered by the adapter's allowlist.
 *
 * `allowed` null means "keep everything", which is what the generic adapter
 * answers for a system this module has never met: a Pathfinder sheet's items are
 * not ours to shortlist, and MoT will simply find nothing it can map — which is
 * the honest failure rather than a silently emptied sheet.
 *
 * Each item's `system` goes through {@link readSheetSource}'s treatment for
 * {@link readSheetSource}'s reason: the live model first, because a weapon's
 * damage parts and its attack bonus are derived, and the item's own source data
 * only if that could not be serialised.
 */
export function collectSheetItems(items: unknown, allowed: readonly string[] | null): SheetItem[] {
  const out: SheetItem[] = [];

  for (const item of collectionValues<Record<string, unknown>>(items)) {
    if (out.length >= MAX_SHEET_ITEMS) break;
    if (!isRecord(item)) continue;

    const source = sourceOf(item);
    const type = nonEmpty(item.type) ?? nonEmpty(source?.type);
    if (allowed !== null && (type === null || !allowed.includes(type))) continue;

    const id = nonEmpty(item._id) ?? nonEmpty(item.id);
    out.push({
      name: capped(item.name ?? source?.name, MAX_SHEET_NAME_LENGTH) ?? id ?? "",
      type,
      sort: numeric(item.sort) ?? numeric(source?.sort),
      system: plain(item.system) ?? plain(source?.system) ?? {},
    });
  }

  return out;
}

/** A document's source data, or null for a plain object that has none. */
function sourceOf(document: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!document || typeof document.toObject !== "function") return null;

  try {
    const value = (document.toObject as () => unknown).call(document);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A JSON-flattened, freshly-owned copy of an object, or null for anything else. */
function plain(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;

  try {
    const copy: unknown = JSON.parse(JSON.stringify(value));
    return isRecord(copy) ? copy : null;
  } catch {
    // A cycle, a BigInt, a getter that threw. The caller has a fallback.
    return null;
  }
}

/** What {@link actorSheetBody} needs beyond the actor itself. */
export interface SheetContext {
  requestId: string;
  actorId: string;
  systemId: string;
  /** The adapter's answer; null keeps every item type. */
  itemTypes: readonly string[] | null;
}

/**
 * The POST body, as a value, so its shape is a unit test rather than something
 * a customer discovers.
 *
 * Everything in it is already plain and freshly owned — {@link readSheetSource}
 * and {@link collectSheetItems} see to that — so the trimmer below can blank a
 * description without editing somebody's item, and nothing here can throw.
 */
export function actorSheetBody(source: SheetActorSource, context: SheetContext): ActorSheetBody {
  return trimSheetBody({
    requestId: context.requestId,
    actorId: context.actorId,
    name: capped(source.name, MAX_SHEET_NAME_LENGTH) ?? context.actorId,
    foundrySystemId: context.systemId,
    system: isRecord(source.system) ? source.system : {},
    items: collectSheetItems(source.items, context.itemTypes),
    truncated: false,
  });
}

/**
 * Brings a body inside {@link MAX_SHEET_BYTES}, cheapest loss first.
 *
 * Two passes, and the order is the whole decision:
 *
 *  1. **Descriptions, largest item first.** A feature's description is the
 *     longest thing on a sheet by an order of magnitude and the least load
 *     bearing: MoT flattens it to plain text anyway, and a statblock entry with
 *     a name and no prose is still an entry a keeper can fill in. A dozen
 *     blanked descriptions usually ends the problem.
 *  2. **Whole items, largest first.** Only if blanking was not enough, which
 *     means a sheet carrying a quarter megabyte of structured data.
 *
 * Mutates the body it is given — it is the freshly-owned copy from
 * {@link actorSheetBody} — and returns it with `truncated` set when anything
 * went.
 */
export function trimSheetBody(body: ActorSheetBody, max = MAX_SHEET_BYTES): ActorSheetBody {
  const base = measure({ ...body, items: [] });
  const sizes = body.items.map((item) => measure(item));
  const total = (): number => sizes.reduce((sum, size) => sum + size + 1, base);

  let truncated = body.truncated;

  if (total() > max) {
    for (const index of largestFirst(sizes)) {
      if (total() <= max) break;
      if (!stripDescriptions(body.items[index])) continue;
      sizes[index] = measure(body.items[index]);
      truncated = true;
    }
  }

  while (total() > max && body.items.length > 0) {
    const index = largestFirst(sizes)[0] ?? 0;
    body.items.splice(index, 1);
    sizes.splice(index, 1);
    truncated = true;
  }

  body.truncated = truncated;
  return body;
}

/**
 * Blanks every string under the item's `description`, whatever shape the system
 * keeps it in — a bare string on some, `{value, chat, unidentified}` on dnd5e.
 *
 * Returns whether anything was actually emptied, so the caller does not re-measure
 * an item it did not change.
 */
function stripDescriptions(item: SheetItem | undefined): boolean {
  if (!item) return false;

  const description = item.system.description;

  if (typeof description === "string") {
    if (description === "") return false;
    item.system.description = "";
    return true;
  }

  if (!isRecord(description)) return false;

  let changed = false;
  for (const key of Object.keys(description)) {
    if (typeof description[key] === "string" && description[key] !== "") {
      description[key] = "";
      changed = true;
    }
  }
  return changed;
}

/** Item indexes, biggest first. Rebuilt per pass; a sheet has hundreds, not millions. */
function largestFirst(sizes: readonly number[]): number[] {
  return sizes.map((size, index) => ({ size, index }))
    .sort((a, b) => b.size - a.size)
    .map((entry) => entry.index);
}

/**
 * What a finished body weighs, for the one caller that has to decide whether to
 * send it at all.
 *
 * {@link trimSheetBody} takes descriptions and then whole items, and there is a
 * sheet it cannot save: one whose `system` object *alone* is over the cap.
 * Nothing here trims that — a system's own data is the thing being imported, and
 * a half-deleted one is worse than none — so the handler measures what came out
 * and posts a refusal instead of a body the server would reject as a 400 the
 * keeper would read as a timeout.
 */
export function sheetBodyBytes(body: ActorSheetBody): number {
  return measure(body);
}

/** Bytes on the wire, not characters: the cap is a POST size and `é` is two of them. */
function measure(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function capped(value: unknown, max: number): string | null {
  const trimmed = nonEmpty(value);
  return trimmed === null ? null : truncate(trimmed, max);
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
