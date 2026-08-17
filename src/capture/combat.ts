import { combatEndKey, combatStartKey, combatTurnKey } from "../protocol/keys.js";
import type {
  CombatEndedPayload,
  CombatStartedPayload,
  CombatTurnPayload,
  Envelope,
} from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import type { DocumentCaptureDeps, DocumentContext } from "./documents.js";
import {
  collectionValues,
  combatantRef,
  docUuid,
  documentTimestamp,
  finiteNumber,
  isHidden,
} from "./documents.js";
import { isBridgeOrigin } from "./loopGuard.js";

/**
 * Combat capture: `combat.started`, `combat.turn`, `combat.ended`.
 *
 * ## Why `createCombat` emits nothing
 *
 * Because a combat existing is not a combat happening. `createCombat` fires the
 * moment a GM drops a token into the tracker — during prep, on a Tuesday, three
 * times while building an encounter, and once more for the encounter that gets
 * deleted unused. A session log that opened a battle report every time would be
 * mostly wrong, and "the fight that never happened" is not a line anybody can
 * filter out afterwards.
 *
 * ## Which hook actually means "the fight started"
 *
 * There are two candidates and neither is perfect, so this is written down
 * rather than left to the next reader to rediscover:
 *
 * - **`combatStart`** fires *pre-update*, on the client that pressed the button.
 *   At a real table that is the GM, and the GM is the active GM, so the activation
 *   gate sees it. But it is not guaranteed: a player-owned macro or a module that
 *   starts combat would fire it on a client the gate ignores, and the event would
 *   be lost.
 * - **The first `combatTurnChange`** fires post-update on every client and is
 *   therefore never missed — but it arrives *as* a turn, so using it would mean
 *   inferring "started" from "round 1 turn 0", which is also what a GM rewinding
 *   the tracker to the top of round 1 looks like.
 *
 * **Decision: `combatStart`, activation-gated.** The failure mode is a missing
 * `combat.started` in an exotic setup; the alternative's failure mode is a
 * *spurious* one in an ordinary setup, and a log that invents a second battle is
 * worse than a log that misses the first one's header. The turns still flow
 * either way — `combat.turn` does not depend on `combat.started` having arrived,
 * on this end or on the server's — so the worst case degrades to a fight whose
 * rounds are all present under no header.
 *
 * The key is `fvtt:combat:<uuid>:start`, so if the hook does fire twice the
 * second is a `duplicate` receipt rather than a second header.
 */

// -------------------------------------------------------------- pure builders

/**
 * The roster at the moment the fight began, which is the interesting one: it is
 * what the table faced before anybody died, fled or was summoned.
 */
export function buildCombatStarted(
  combat: FoundryCombat | null | undefined,
  context: DocumentContext,
): Envelope<CombatStartedPayload> | null {
  if (!combat || isBridgeOrigin(combat)) return null;

  const combatUuid = docUuid(combat);
  if (!combatUuid) return null;

  const combatants = collectionValues<FoundryCombatant>(combat.combatants)
    .map((combatant) => combatantRef(combatant))
    .filter((ref): ref is NonNullable<typeof ref> => ref !== null);

  return {
    v: PROTOCOL_VERSION,
    type: "combat.started",
    id: combatStartKey(combatUuid),
    ts: documentTimestamp(combat, context),
    // An empty roster still emits. A fight started with the tracker empty is
    // strange, but it is a thing that happened and the header is what the
    // rounds below it hang from.
    payload: { combatUuid, combatants },
  };
}

/**
 * `combatTurnChange(combat, prior, current)` — post-update, on every client,
 * which is what makes it the reliable half of combat capture.
 *
 * `current` carries `{round, turn, combatantId, tokenId}`. Both it and the
 * document are read, in that order, because the marker is what the hook is
 * *about* while the document is what the world now holds — and on the paths
 * where the marker is absent entirely (older builds, a couple of module-driven
 * flows) the document is still correct.
 */
export function buildCombatTurn(
  combat: FoundryCombat | null | undefined,
  current: FoundryTurnMarker | null | undefined,
  context: DocumentContext,
): Envelope<CombatTurnPayload> | null {
  if (!combat || isBridgeOrigin(combat)) return null;

  const combatUuid = docUuid(combat);
  if (!combatUuid) return null;

  const round = finiteNumber(current?.round) ?? finiteNumber(combat.round);
  const turn = finiteNumber(current?.turn) ?? finiteNumber(combat.turn);

  // Both or nothing. The pair *is* the idempotency key, so a missing turn would
  // mean either inventing an index — which silently merges two real turns into
  // one line — or minting a key shape the replay path has never seen. A skipped
  // event is recoverable by the next turn; a wrong key is not.
  if (round === null || turn === null) return null;

  const combatant = resolveCurrentCombatant(combat, current);

  return {
    v: PROTOCOL_VERSION,
    type: "combat.turn",
    id: combatTurnKey(combatUuid, round, turn),
    ts: documentTimestamp(combat, context),
    payload: {
      combatUuid,
      round,
      turn,
      current: combatantRef(combatant),
      // A hidden ambusher's turn is a fact the players have not been told. It
      // still belongs in the GM's record of the night, which is exactly what
      // `private` means.
      private: isHidden(combatant?.token),
    },
  };
}

/**
 * `deleteCombat` — the tracker being cleared, which at a real table is what
 * "the fight is over" looks like. `combat.round` at that moment is how long it
 * lasted.
 */
export function buildCombatEnded(
  combat: FoundryCombat | null | undefined,
  context: DocumentContext,
): Envelope<CombatEndedPayload> | null {
  if (!combat || isBridgeOrigin(combat)) return null;

  const combatUuid = docUuid(combat);
  if (!combatUuid) return null;

  return {
    v: PROTOCOL_VERSION,
    type: "combat.ended",
    id: combatEndKey(combatUuid),
    ts: documentTimestamp(combat, context),
    payload: { combatUuid, rounds: finiteNumber(combat.round) },
  };
}

/**
 * Whose turn it is: the marker's combatant id looked up in the roster first,
 * `combat.combatant` second.
 *
 * That order matters. `combat.combatant` is a getter over the tracker's *current*
 * state, and by the time a batch of turn changes settles it can already have
 * moved on — the id in the marker is the one this event is about.
 */
function resolveCurrentCombatant(
  combat: FoundryCombat,
  current: FoundryTurnMarker | null | undefined,
): FoundryCombatant | null {
  const id = current?.combatantId ?? null;

  if (id) {
    const collection = combat.combatants;
    const getter = (collection as { get?(key: string): FoundryCombatant | undefined } | null)?.get;
    if (typeof getter === "function") {
      const found = getter.call(collection, id);
      if (found) return found;
    }

    const found = collectionValues<FoundryCombatant>(collection).find((combatant) => combatant?.id === id);
    if (found) return found;
  }

  return combat.combatant ?? null;
}

// ------------------------------------------------------------ hook registration

/**
 * Three hooks, one gate, no decisions. Returns the hook ids so a teardown could
 * unregister them — nothing does, because the only way out of a Foundry world is
 * a page reload, which takes them with it.
 */
export function registerCombatCapture(deps: DocumentCaptureDeps): number[] {
  const emit = (envelope: Envelope | null): void => {
    if (envelope) deps.emit(envelope);
  };

  return [
    deps.hooks.on("combatStart", (combat: FoundryCombat) => {
      if (!deps.isActive()) return;
      emit(buildCombatStarted(combat, deps.context()));
    }),

    deps.hooks.on(
      "combatTurnChange",
      (combat: FoundryCombat, _prior: FoundryTurnMarker, current: FoundryTurnMarker) => {
        if (!deps.isActive()) return;
        emit(buildCombatTurn(combat, current, deps.context()));
      },
    ),

    deps.hooks.on("deleteCombat", (combat: FoundryCombat) => {
      if (!deps.isActive()) return;
      emit(buildCombatEnded(combat, deps.context()));
    }),
  ];
}
