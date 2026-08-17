import { currencyKey, itemKey } from "../protocol/keys.js";
import type { CurrencyChangedPayload, Envelope, ItemChangePayload } from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import type { DocumentCaptureDeps, DocumentContext } from "./documents.js";
import {
  changeStamp,
  docName,
  docUuid,
  documentTimestamp,
  finiteNumber,
  isActorDocument,
  nonEmptyString,
  plainRecord,
} from "./documents.js";
import { isBridgeOrigin } from "./loopGuard.js";
import { currencySlot } from "./priorValues.js";

/**
 * Loot capture: `item.granted`, `item.removed`, `currency.changed`.
 *
 * ## Only items that belong to somebody
 *
 * `createItem` fires for world items and compendium imports as loudly as it does
 * for the sword a player just picked up. The parent check is the whole
 * difference between a loot log and a log of the GM's prep: an item with no
 * Actor parent is inventory that exists, not inventory that changed hands.
 *
 * ## Quantity and rarity are best-effort, and that is the honest shape
 *
 * Core Foundry has no notion of either. `system.quantity` and `system.rarity`
 * are read defensively and come back null on a system that keeps them elsewhere
 * or not at all — which costs a plainer sentence and never a wrong one.
 *
 * ## Currency is the adapter's, for a reason spelled out in adapters/index.ts
 *
 * There is no core currency concept to fall back to, so this file asks the
 * adapter whether an actor update moved coin and builds the same generic
 * envelope for whatever answers. A table on a system with no adapter gets no
 * coin lines and a completely unaffected log otherwise.
 */

// ------------------------------------------------------------ pure builders

/**
 * `createItem` / `deleteItem` on an Actor.
 *
 * Note what this does *not* try to be: a transfer. Moving a potion from the
 * rogue to the cleric is a delete and a create, half a second apart, and the
 * module reports both rather than inferring a hand-off it cannot actually
 * observe — the two documents share no id and nothing links them.
 */
export function buildItemEvent(
  item: FoundryItem | null | undefined,
  action: "granted" | "removed",
  context: DocumentContext,
): Envelope<ItemChangePayload> | null {
  if (!item || isBridgeOrigin(item)) return null;

  const parent = item.parent ?? null;
  if (!isActorDocument(parent)) return null;

  const itemUuid = docUuid(item);
  // No uuid, no stable key, and an unstable key is a duplicated line on the
  // next reconnect. Skipped rather than invented.
  if (!itemUuid) return null;

  const system = plainRecord(item.system);

  return {
    v: PROTOCOL_VERSION,
    type: action === "granted" ? "item.granted" : "item.removed",
    id: itemKey(itemUuid, action),
    ts: documentTimestamp(item, context),
    payload: {
      actorUuid: docUuid(parent),
      actorName: docName(parent),
      itemUuid,
      itemName: docName(item),
      quantity: finiteNumber(system?.quantity),
      rarity: nonEmptyString(system?.rarity),
    },
  };
}

/**
 * `updateActor`, filtered through the adapter's currency reader.
 *
 * Both maps carry **only the denominations that moved**, which is what makes the
 * event readable: "gp 12 → 27" rather than five numbers of which four are
 * unchanged. `from` is null on the first purse change this client observes —
 * Foundry's diff carries the new values and never the old, so "previous" is
 * whatever the module last saw.
 */
export function buildCurrencyEvent(
  actor: FoundryActor | null | undefined,
  change: unknown,
  context: DocumentContext,
): Envelope<CurrencyChangedPayload> | null {
  if (!actor || isBridgeOrigin(actor)) return null;

  const actorUuid = docUuid(actor);
  if (!actorUuid) return null;

  const system = plainRecord(actor.system);
  const delta = plainRecord(plainRecord(change)?.system);

  const detected = context.adapter.currency({ system, delta }, context.adapterContext);
  if (!detected) return null;

  const to = pick(detected.current, detected.changed);
  if (Object.keys(to).length === 0) return null;

  const slot = currencySlot(actorUuid);
  const remembered = numberRecord(context.prior.recall(slot));
  context.prior.remember(slot, detected.current);

  const from = remembered ? pick(remembered, detected.changed) : null;

  // The purse was written back unchanged — a sheet save, not a transaction.
  // Emitting it would put "the party's gold changed" in the log at a moment
  // when it demonstrably did not.
  if (from && sameAmounts(from, to)) return null;

  return {
    v: PROTOCOL_VERSION,
    type: "currency.changed",
    id: currencyKey(actorUuid, changeStamp(actor, context)),
    ts: documentTimestamp(actor, context),
    payload: {
      actorUuid,
      actorName: docName(actor),
      // An empty `from` map means "we knew this purse and none of the moved
      // denominations were in it" — null means "we had never seen it". Two
      // different sentences, kept apart.
      from,
      to,
    },
  };
}

function pick(source: Record<string, number>, keys: readonly string[]): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const key of keys) {
    const amount = finiteNumber(source[key]);
    if (amount !== null) picked[key] = amount;
  }
  return picked;
}

/** What {@link PriorValues} handed back, if it is still the shape we stored. */
function numberRecord(value: unknown): Record<string, number> | null {
  const record = plainRecord(value);
  if (!record) return null;

  const numbers: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const amount = finiteNumber(entry);
    if (amount !== null) numbers[key] = amount;
  }
  return numbers;
}

function sameAmounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((key) => a[key] === b[key]);
}

// ------------------------------------------------------------ hook registration

/**
 * Three hooks. `updateActor` is registered here *as well as* in `actors.ts`,
 * on purpose: the two handlers read disjoint parts of the same diff — hit points
 * there, coin here — and one update can legitimately be both. Merging them into
 * a single handler would mean one family's reader could suppress the other's,
 * which is exactly the coupling the one-file-per-family split exists to avoid.
 */
export function registerItemCapture(deps: DocumentCaptureDeps): number[] {
  const emit = (envelope: Envelope | null): void => {
    if (envelope) deps.emit(envelope);
  };

  return [
    deps.hooks.on("createItem", (item: FoundryItem) => {
      if (!deps.isActive()) return;
      emit(buildItemEvent(item, "granted", deps.context()));
    }),

    deps.hooks.on("deleteItem", (item: FoundryItem) => {
      if (!deps.isActive()) return;
      emit(buildItemEvent(item, "removed", deps.context()));
    }),

    deps.hooks.on("updateActor", (actor: FoundryActor, change: unknown) => {
      if (!deps.isActive()) return;
      emit(buildCurrencyEvent(actor, change, deps.context()));
    }),
  ];
}
