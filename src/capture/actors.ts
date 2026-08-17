import { toExt } from "../adapters/index.js";
import { actorChangeKey, combatantKey, effectKey, tokenAppearedKey } from "../protocol/keys.js";
import type { ActorAppearedPayload, ActorChangedPayload, Envelope, HpChange } from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import type { DocumentCaptureDeps, DocumentContext } from "./documents.js";
import {
  changeStamp,
  combatantRef,
  docName,
  docUuid,
  documentTimestamp,
  finiteNumber,
  isActorDocument,
  isHidden,
  nonEmptyString,
  plainRecord,
  readPath,
  recordAt,
  tokenDelta,
  tokenImage,
} from "./documents.js";
import { isBridgeOrigin } from "./loopGuard.js";
import { hpSlot, type PriorValues } from "./priorValues.js";

/**
 * Actor capture: `actor.appeared` and `actor.changed`.
 *
 * ## `updateToken` matters as much as `updateActor` — this is the classic miss
 *
 * A **linked** actor (the party's characters) keeps its hit points on the Actor
 * document, and `updateActor` reports them. Every **unlinked** token — which is
 * every mook in every encounter, four goblins stamped from one statblock — keeps
 * its hit points on *its own token*, as an override of the shared actor. Watching
 * only `updateActor` produces a combat log in which the party takes damage and
 * nothing they fight ever does.
 *
 * So both hooks are registered, and the token's override is read from `delta`
 * (v11+) or `actorData` (v10 and earlier), whichever the document carries.
 *
 * ## Where hit points live is a system question with no core answer
 *
 * Core Foundry has no hit points. Every system invents them somewhere, and the
 * capture layer cannot import a system to ask. So it probes a short list of the
 * well-travelled paths (`system.attributes.hp` covers dnd5e, pf2e, sw5e and most
 * of the d20 family; `system.hp` and `system.health` cover much of the rest) and
 * emits nothing at all when none of them match. A table on an unlisted system
 * gets a log with no damage lines rather than a log with wrong ones — and adding
 * a path is a one-line change with a test.
 *
 * ## Four sources, one event type
 *
 * `actor.changed` is emitted from `updateActor`, `updateToken`,
 * `create`/`deleteActiveEffect` and `updateCombatant`. They are one type because
 * they are one sentence at the table — "the ogre is bloodied", "the ogre is
 * poisoned", "the ogre is down" — and the server renders whichever fields
 * arrived. Each source mints its key from its *own* document, so the actor update
 * and the effect that accompanied it are two events rather than a collision.
 */

/**
 * Probed in order, relative to `system`. First match wins, and a system that
 * matches none produces no hp field rather than a guess.
 */
export const HP_PATHS: readonly (readonly string[])[] = [
  ["attributes", "hp"],
  ["hp"],
  ["health"],
  ["attributes", "health"],
];

/**
 * The status ids that mean "out of the fight".
 *
 * `dead` is Foundry's own default for `CONFIG.specialStatusEffects.DEFEATED`,
 * which is the id the tracker's skull toggles; `defeated` is what several
 * systems and modules use for the same idea. Deliberately short — "unconscious"
 * is *not* here, because a downed player character is not the same event as a
 * dead one and a log that conflates them is worse than one that only reports
 * what it is sure of.
 */
export const DEFEAT_STATUSES: readonly string[] = ["dead", "defeated"];

/**
 * Everything the payload needs about *who this happened to*, resolved once from
 * whichever document the hook handed us.
 */
export interface ActorSubject {
  actorUuid: string | null;
  tokenUuid: string | null;
  name: string | null;
  /** The hidden-token privacy rule, already applied. */
  private: boolean;
  /** Post-update system data, for the hp reader and for the adapter. */
  system: Record<string, unknown> | null;
}

/**
 * A world actor, or the synthetic actor behind an unlinked token.
 *
 * `actor.token` is set on the synthetic case and null on the world case, which
 * is what lets a single reader serve both: an `updateActor` on a mook's
 * synthetic actor still resolves the token, and therefore still gets the
 * token's uuid on the payload and the token's `hidden` on the privacy rule.
 */
export function subjectFromActor(actor: FoundryActor | null | undefined): ActorSubject {
  const token = actor?.token ?? null;

  return {
    actorUuid: docUuid(actor),
    tokenUuid: docUuid(token),
    name: docName(actor) ?? docName(token),
    private: isHidden(token),
    system: plainRecord(actor?.system),
  };
}

/**
 * A token document.
 *
 * The system data comes from the **synthetic actor** where Foundry built one,
 * because that is the base statblock with the token's overrides already applied
 * — the only place a mook's current hit points are correct. The raw delta is the
 * fallback for source-object paths where no synthetic actor exists, and it is
 * right whenever the delta is what changed.
 */
export function subjectFromToken(token: FoundryTokenDocument | null | undefined): ActorSubject {
  const actor = token?.actor ?? null;

  return {
    actorUuid: docUuid(actor),
    tokenUuid: docUuid(token),
    name: docName(token) ?? docName(actor),
    private: isHidden(token),
    system: plainRecord(actor?.system) ?? plainRecord(tokenDelta(token)?.system),
  };
}

/**
 * The uuid an event is keyed and remembered by: the **token** where there is
 * one, the actor otherwise.
 *
 * Not a detail. Four goblins share one actor and have four tokens; keying their
 * hit points off the actor would give all four the same idempotency key and the
 * same remembered HP, so three of every four damage lines would vanish as
 * duplicates and the fourth would report a nonsense delta.
 */
export function subjectUuid(subject: ActorSubject): string | null {
  return subject.tokenUuid ?? subject.actorUuid;
}

// ------------------------------------------------------------- hit points

/** The first well-known hp node present in some system data, with the path that found it. */
export function findHp(system: unknown): { path: readonly string[]; node: Record<string, unknown> } | null {
  for (const path of HP_PATHS) {
    const node = recordAt(system, path);
    if (node) return { path, node };
  }
  return null;
}

/**
 * `{from, to, max}`, or null when this update was not about hit points.
 *
 * `from` comes from {@link PriorValues} because Foundry's update hooks carry the
 * new value and the diff but never the old one. First sighting reports null and
 * says so on the wire.
 */
export function extractHp(
  subject: ActorSubject,
  deltaSystem: unknown,
  uuid: string,
  prior: PriorValues,
): HpChange | null {
  const delta = findHp(deltaSystem);
  if (!delta) return null;

  // The delta node exists but carries neither `value` nor `max`: a temp-hp-only
  // change, or a system writing some other sub-key. Core has nothing to say
  // about it — the dnd5e adapter garnishes temp HP separately — and inventing a
  // "12 → 12" line would be noise in the middle of a fight.
  const touchesPool = "value" in delta.node || "max" in delta.node;
  if (!touchesPool) return null;

  // The document is authoritative for what the values now *are*; the delta is
  // the fallback for source-object paths that carry no document.
  const current = recordAt(subject.system, delta.path) ?? delta.node;

  const to = finiteNumber(current.value) ?? finiteNumber(delta.node.value);
  if (to === null) return null;

  const max = finiteNumber(current.max) ?? finiteNumber(delta.node.max);

  // Both halves of the pool are remembered, not just the current value. Reading
  // `"max" in delta.node` instead would be wrong in both directions: dnd5e's
  // damage application writes `value` alone, while a plain sheet save writes the
  // whole hp object — so the presence of a `max` key says nothing about whether
  // the maximum moved.
  const slot = hpSlot(uuid);
  const remembered = plainRecord(prior.recall(slot));
  const from = finiteNumber(remembered?.value);
  const priorMax = finiteNumber(remembered?.max);
  prior.remember(slot, { value: to, max });

  // Nothing moved: a sheet save, an unrelated field written back alongside the
  // pool. Emitting it would put "Tharivol is at 12" in the log at a moment when
  // Tharivol demonstrably did not change. A max that moved *is* a change — that
  // is a level-up, and it belongs in the log even at unchanged current hp.
  if (from !== null && from === to && priorMax === max) return null;

  return { from, to, max };
}

/**
 * Records a freshly-placed token's hit points without emitting anything, so the
 * *first* hit it takes already has a `from`. Without this every encounter's
 * opening damage line would be the one with no delta.
 */
function seedHp(subject: ActorSubject, uuid: string, prior: PriorValues): void {
  const hp = findHp(subject.system);
  const value = finiteNumber(hp?.node.value);
  if (value !== null) prior.remember(hpSlot(uuid), { value, max: finiteNumber(hp?.node.max) });
}

// ------------------------------------------------------------ pure builders

/** A token walked onto the scene. */
export function buildActorAppeared(
  token: FoundryTokenDocument | null | undefined,
  context: DocumentContext,
): Envelope<ActorAppearedPayload> | null {
  if (!token || isBridgeOrigin(token)) return null;

  const tokenUuid = docUuid(token);
  // No uuid, no stable key — and an event whose key is not stable is an event a
  // reconnect duplicates. Skipped rather than sent with a minted id.
  if (!tokenUuid) return null;

  const subject = subjectFromToken(token);
  seedHp(subject, tokenUuid, context.prior);

  return {
    v: PROTOCOL_VERSION,
    type: "actor.appeared",
    id: tokenAppearedKey(tokenUuid),
    ts: documentTimestamp(token, context),
    payload: {
      actorUuid: subject.actorUuid,
      tokenUuid,
      name: subject.name,
      disposition: finiteNumber(token.disposition),
      imageUrl: tokenImage(token),
      private: subject.private,
    },
  };
}

/** `updateActor` — the linked half: player characters and named NPCs. */
export function buildActorUpdate(
  actor: FoundryActor | null | undefined,
  change: unknown,
  context: DocumentContext,
): Envelope<ActorChangedPayload> | null {
  if (!actor || isBridgeOrigin(actor)) return null;
  return buildPoolChange(subjectFromActor(actor), change, actor, context);
}

/** `updateToken` — the unlinked half: every mook in every encounter. */
export function buildTokenUpdate(
  token: FoundryTokenDocument | null | undefined,
  change: unknown,
  context: DocumentContext,
): Envelope<ActorChangedPayload> | null {
  if (!token || isBridgeOrigin(token)) return null;

  // A token update's actor data rides `delta` (v11+) or `actorData` (v10),
  // one level down from the diff root — unlike an actor update, whose system
  // node is at the root.
  return buildPoolChange(subjectFromToken(token), tokenDelta(change), token, context);
}

/**
 * The shared body of both update hooks: read the pool, and emit only if it
 * moved.
 */
function buildPoolChange(
  subject: ActorSubject,
  changeRoot: unknown,
  doc: FoundryDocument,
  context: DocumentContext,
): Envelope<ActorChangedPayload> | null {
  const uuid = subjectUuid(subject);
  if (!uuid) return null;

  const deltaSystem = plainRecord(plainRecord(changeRoot)?.system);
  const hp = extractHp(subject, deltaSystem, uuid, context.prior);
  if (!hp) return null;

  const envelope: Envelope<ActorChangedPayload> = {
    v: PROTOCOL_VERSION,
    type: "actor.changed",
    id: actorChangeKey(uuid, changeStamp(doc, context)),
    ts: documentTimestamp(doc, context),
    payload: {
      actorUuid: subject.actorUuid,
      tokenUuid: subject.tokenUuid,
      name: subject.name,
      private: subject.private,
      hp,
    },
  };

  const ext = toExt(
    context.adapter.actorExt({ system: subject.system, delta: deltaSystem }, context.adapterContext),
  );
  if (ext) envelope.ext = ext;

  return envelope;
}

/**
 * `createActiveEffect` / `deleteActiveEffect` — conditions arriving and lifting.
 *
 * The parent check is doing real work: ActiveEffects live on Items at least as
 * often as on Actors, and "the +1 sword gained an effect" rendered as "Tharivol
 * is poisoned" would be a wrong line rather than a missing one.
 */
export function buildEffectChange(
  effect: FoundryActiveEffect | null | undefined,
  action: "added" | "removed",
  context: DocumentContext,
): Envelope<ActorChangedPayload> | null {
  if (!effect || isBridgeOrigin(effect)) return null;

  const parent = effect.parent ?? null;
  if (!isActorDocument(parent)) return null;

  const subject = subjectFromActor(parent as FoundryActor);
  const uuid = subjectUuid(subject);
  if (!uuid) return null;

  const statuses = effectStatuses(effect);
  // An unnamed effect still says something if it carries a status id — that is
  // how several systems apply conditions, with the id as the only label there is.
  const label = effectLabel(effect) ?? statuses[0] ?? null;
  const defeat = statuses.some((status) => DEFEAT_STATUSES.includes(status));

  // No name, no status: an anonymous mechanical effect (a bonus, an aura). It
  // has no sentence in it, so it makes no entry.
  if (!label && !defeat) return null;

  const payload: ActorChangedPayload = {
    actorUuid: subject.actorUuid,
    tokenUuid: subject.tokenUuid,
    name: subject.name,
    private: subject.private,
  };

  // `{added: [...]}` / `{removed: [...]}` — one side only, because one hook
  // firing is one direction. The server reads the two sides independently, so a
  // list that is never sent is cheaper than a list that is always empty.
  if (label) payload.conditions = action === "added" ? { added: [label] } : { removed: [label] };
  if (defeat) payload.defeated = action === "added";

  // The effect's own uuid: applying, curing and re-applying a condition creates
  // three documents, which is three events rather than one key reused.
  const effectUuid = docUuid(effect) ?? `${uuid}:${changeStamp(effect, context)}`;

  return {
    v: PROTOCOL_VERSION,
    type: "actor.changed",
    id: effectKey(effectUuid, action),
    ts: documentTimestamp(effect, context),
    payload,
  };
}

/**
 * `updateCombatant` — the tracker's skull button, which is the other way a
 * table marks something dead and does not always come with an ActiveEffect.
 */
export function buildCombatantDefeat(
  combatant: FoundryCombatant | null | undefined,
  change: unknown,
  context: DocumentContext,
): Envelope<ActorChangedPayload> | null {
  if (!combatant || isBridgeOrigin(combatant)) return null;

  // Only when *this* update is what moved the flag. Combatant updates fire for
  // initiative, for the active turn, and for nothing at all.
  const defeated = plainRecord(change)?.defeated;
  if (typeof defeated !== "boolean") return null;

  const combatantUuid = docUuid(combatant);
  if (!combatantUuid) return null;

  const ref = combatantRef(combatant);

  return {
    v: PROTOCOL_VERSION,
    type: "actor.changed",
    id: combatantKey(combatantUuid, changeStamp(combatant, context)),
    ts: documentTimestamp(combatant, context),
    payload: {
      actorUuid: ref?.actorUuid ?? null,
      tokenUuid: ref?.tokenUuid ?? null,
      name: ref?.name ?? null,
      private: isHidden(combatant.token),
      defeated,
    },
  };
}

// ------------------------------------------------------------ effect readers

/** v11+ calls it `name`; v10 called it `label`. Both are read. */
export function effectLabel(effect: FoundryActiveEffect | null | undefined): string | null {
  return nonEmptyString(effect?.name) ?? nonEmptyString(effect?.label);
}

/**
 * Status ids, from the v11+ `statuses` Set and the v10 `flags.core.statusId`
 * alike. Deduplicated, because a world migrated forward carries both.
 */
export function effectStatuses(effect: FoundryActiveEffect | null | undefined): string[] {
  const found = new Set<string>();

  const statuses = effect?.statuses;
  if (statuses) {
    const values = statuses instanceof Set ? [...statuses] : Array.isArray(statuses) ? statuses : [];
    for (const status of values) {
      const id = nonEmptyString(status);
      if (id) found.add(id.toLowerCase());
    }
  }

  const legacy = nonEmptyString(readPath(effect?.flags ?? null, ["core", "statusId"]));
  if (legacy) found.add(legacy.toLowerCase());

  return [...found];
}

// ------------------------------------------------------------ hook registration

/**
 * Six hooks, one gate, no decisions. The gate is re-read per event because
 * `activeGM` moves when a GM drops off the wifi mid-session.
 */
export function registerActorCapture(deps: DocumentCaptureDeps): number[] {
  const emit = (envelope: Envelope | null): void => {
    if (envelope) deps.emit(envelope);
  };

  return [
    deps.hooks.on("createToken", (token: FoundryTokenDocument) => {
      if (!deps.isActive()) return;
      emit(buildActorAppeared(token, deps.context()));
    }),

    deps.hooks.on("updateActor", (actor: FoundryActor, change: unknown) => {
      if (!deps.isActive()) return;
      emit(buildActorUpdate(actor, change, deps.context()));
    }),

    deps.hooks.on("updateToken", (token: FoundryTokenDocument, change: unknown) => {
      if (!deps.isActive()) return;
      emit(buildTokenUpdate(token, change, deps.context()));
    }),

    deps.hooks.on("createActiveEffect", (effect: FoundryActiveEffect) => {
      if (!deps.isActive()) return;
      emit(buildEffectChange(effect, "added", deps.context()));
    }),

    deps.hooks.on("deleteActiveEffect", (effect: FoundryActiveEffect) => {
      if (!deps.isActive()) return;
      emit(buildEffectChange(effect, "removed", deps.context()));
    }),

    deps.hooks.on("updateCombatant", (combatant: FoundryCombatant, change: unknown) => {
      if (!deps.isActive()) return;
      emit(buildCombatantDefeat(combatant, change, deps.context()));
    }),
  ];
}
