/**
 * Protocol v1 wire types — the module's own copy. See protocol/version.ts for
 * why this is duplicated rather than shared with the server.
 *
 * The three rules that make this survive two repos shipping on different days:
 *   1. An unknown `type` is ignored, never errored. Both directions.
 *   2. `ext` is garnish. Nothing in this module branches on it, and the server
 *      promises the same. It exists so a 5e line reads well.
 *   3. Idempotency keys are computed by the sender, from things Foundry already
 *      guarantees are stable. See `protocol/keys.ts`.
 */

import type { BridgeUser } from "./roster.js";

export type { BridgeUser };

/** One envelope, both directions. */
export interface Envelope<P = unknown> {
  v: number;
  type: string;
  /** Sender-computed idempotency key. Absent on outbound-from-server commands. */
  id?: string;
  /** ISO 8601. For captures this is the *Foundry* timestamp, not send time. */
  ts: string;
  payload: P;
  ext?: Record<string, unknown>;
}

// ------------------------------------------------------------ inbound payloads
// (inbound = Foundry -> MoT; the direction this module produces)

export interface Speaker {
  name: string;
  /** Foundry actor id/uuid as the message carried it, or null for narration. */
  actorUuid: string | null;
  tokenUuid: string | null;
  gm: boolean;
}

export interface RollDieResult {
  value: number;
  /** False for results Foundry discarded (kh/kl/dl, rerolls). */
  kept: boolean;
}

export interface RollDie {
  sides: number;
  results: RollDieResult[];
}

export interface RollMadePayload {
  formula: string;
  total: number | null;
  dice: RollDie[];
  /**
   * Flat modifier, when the module can say so cheaply and honestly. It cannot
   * yet — the server recomputes totals from the formula anyway, so this is null
   * in v0.1.0 rather than a guess.
   */
  modifier: number | null;
  flavor: string | null;
  speaker: Speaker;
}

export interface ChatPostedPayload {
  text: string;
  speaker: Speaker;
  /** Whispers included by default; the server files them as `min_role: editor`. */
  private: boolean;
}

// ------------------------------------------------------------------- combat

/**
 * A combatant as the roster reports it. Every field is best-effort: a system
 * with no dispositions, a combatant with no actor behind it, and a token deleted
 * between the hook firing and the read all have to produce a line rather than an
 * exception.
 */
export interface Combatant {
  name: string | null;
  actorUuid: string | null;
  tokenUuid: string | null;
  /** Foundry's `CONST.TOKEN_DISPOSITIONS`: -2 secret, -1 hostile, 0 neutral, 1 friendly. */
  disposition: number | null;
}

export interface CombatStartedPayload {
  combatUuid: string;
  combatants: Combatant[];
}

export interface CombatTurnPayload {
  combatUuid: string;
  round: number;
  /** 0-based index into the initiative order, as Foundry counts it. */
  turn: number;
  /** Whose turn it now is, or null when the roster could not name one. */
  current: Combatant | null;
  /** True when the token whose turn it is, is hidden from the players. */
  private: boolean;
}

export interface CombatEndedPayload {
  combatUuid: string;
  /** `combat.round` at deletion — how long the fight lasted. */
  rounds: number | null;
}

// -------------------------------------------------------------------- actors

/** A token walked onto the scene. */
export interface ActorAppearedPayload {
  actorUuid: string | null;
  tokenUuid: string | null;
  name: string | null;
  disposition: number | null;
  imageUrl: string | null;
  /** Hidden token: GM-only in MoT. See the README's data-flow section. */
  private: boolean;
}

/**
 * `from` is null the first time this module sees a given pool. Foundry's update
 * hooks carry the *new* value and the diff, never the old one, so "previous" is
 * whatever this client last observed. A GM who enables the module mid-fight gets
 * one line with no `from` and correct deltas after that.
 */
export interface HpChange {
  from: number | null;
  to: number;
  max: number | null;
}

export interface ActorChangedPayload {
  actorUuid: string | null;
  tokenUuid: string | null;
  name: string | null;
  private: boolean;
  /** Absent when the update did not touch a hit point pool. */
  hp?: HpChange;
  /** Absent unless this update is what set or cleared it. */
  defeated?: boolean;
  /**
   * Effect names, or their status ids when the effect was unnamed. The key is
   * absent when the update was not about conditions, and each side is absent
   * when nothing went that way — one `createActiveEffect` sends `added` alone.
   */
  conditions?: ConditionChange;
}

export interface ConditionChange {
  added?: string[];
  removed?: string[];
}

// ---------------------------------------------------------------------- loot

export interface ItemChangePayload {
  actorUuid: string | null;
  actorName: string | null;
  itemUuid: string | null;
  itemName: string | null;
  /** `system.quantity` where the system keeps one. */
  quantity: number | null;
  /** `system.rarity` where the system keeps one. */
  rarity: string | null;
  /**
   * True for loot on an actor no player owns — what is in the villain's pockets
   * is the GM's business. See `lootIsPrivate` in capture/items.ts.
   */
  private: boolean;
}

/**
 * Coin. The only payload in the protocol an *adapter* is allowed to bring into
 * existence, because core Foundry has no concept of currency at all — see
 * `adapters/index.ts`. Both maps carry only the denominations that moved.
 */
export interface CurrencyChangedPayload {
  actorUuid: string | null;
  actorName: string | null;
  from: Record<string, number> | null;
  to: Record<string, number>;
  /** The same rule as items: an NPC's purse is not the table's business. */
  private: boolean;
}

// -------------------------------------------------------------------- scenes

export interface SceneActivatedPayload {
  sceneUuid: string;
  name: string | null;
}

export type InboundEnvelope =
  | Envelope<RollMadePayload>
  | Envelope<ChatPostedPayload>
  | Envelope<CombatStartedPayload>
  | Envelope<CombatTurnPayload>
  | Envelope<CombatEndedPayload>
  | Envelope<ActorAppearedPayload>
  | Envelope<ActorChangedPayload>
  | Envelope<ItemChangePayload>
  | Envelope<CurrencyChangedPayload>
  | Envelope<SceneActivatedPayload>;

// ------------------------------------------------------------------- batching

export interface BridgeInfo {
  world: string;
  foundry: string;
  system: { id: string; version: string };
  module: string;
  /**
   * The table's roster — see protocol/roster.ts. Present on every batch and on
   * every heartbeat, which is what makes MoT's "show this image to…" pick-list
   * possible at all, and never more than one heartbeat stale.
   */
  users: BridgeUser[];
}

export interface EventBatch {
  v: number;
  bridge: BridgeInfo;
  events: Envelope[];
}

/** Per-event outcome. Note `dropped` is the *normal* no-live-session case. */
/**
 * Per-event outcomes, returned as **four parallel arrays** rather than one list
 * carrying a status field. The names are the whole vocabulary:
 *
 * | `accepted`  | Written. Carries the entry id. |
 * | `duplicate` | Already in this session's log. The retry worked. Not a problem. |
 * | `dropped`   | Understood, deliberately not stored. Not a problem either. |
 * | `rejected`  | Malformed. This is the module's bug list. |
 *
 * The `dropped`/`rejected` split is load-bearing and is the server's decision to
 * make, not ours: an unknown type is `dropped`, because a module one version
 * ahead of the server has no bug — it has a server that has not shipped slice 3.
 */
export type ReceiptStatus = "accepted" | "duplicate" | "dropped" | "rejected";

/** `id` is null when an event arrived without one; the receipt still reports it. */
export interface WrittenReceipt {
  id: string | null;
  entryId: string | null;
}

export interface DroppedReceipt {
  id: string | null;
  /** `no_live_session` (the normal state) or `unknown_type`. */
  code: string;
}

export interface RejectedReceipt {
  id: string | null;
  code: string;
  message?: string | null;
}

/**
 * The 202 body. Note `session`: every receipt is **also** a session-state
 * signal, which means a module that only ever POSTs still learns when a session
 * starts. Parsed by `protocol/session.ts` like every other arrival point.
 */
export interface BatchResponse {
  session?: unknown;
  accepted?: WrittenReceipt[];
  duplicate?: WrittenReceipt[];
  dropped?: DroppedReceipt[];
  rejected?: RejectedReceipt[];
}

/** Every non-2xx in the bridge namespace shares this body. */
export interface ApiErrorBody {
  error?: {
    code?: string | null;
    message?: string | null;
  } | null;
}

/** The drop code meaning "connected, nothing recording" — silent by design. */
export const NO_LIVE_SESSION = "no_live_session";

/**
 * The drop code meaning "this project switched that family off".
 *
 * The toggles are **server-side**, in MoT's settings panel, and deliberately not
 * mirrored into module settings. Two switches for one behaviour is a support
 * conversation that starts with "but I turned it off" — and the server is the
 * only end that can change its mind about a family without asking a customer to
 * update a module. So the module captures everything it knows how to capture and
 * the server drops what the project does not want.
 *
 * Which makes this receipt the *expected* answer for a quiet table, exactly like
 * `no_live_session`, and it is silenced for the same reason: a log line per
 * dropped event, all night, for a setting working as configured.
 */
export const CAPTURE_DISABLED = "capture_disabled";

/** Drop codes that mean "working as intended". Warned about: nothing in here. */
export const SILENT_DROP_CODES: readonly string[] = [NO_LIVE_SESSION, CAPTURE_DISABLED];

// ----------------------------------------------------------------- outbound
// (outbound = MoT -> Foundry; the direction this module consumes)

export interface BridgeWelcomePayload {
  project_id?: string | null;
  project_name?: string | null;
  /** `{status, id, name}` or null — see protocol/session.ts. */
  session?: unknown;
}

// ------------------------------------------------------------------ handshake

/** `GET /api/v1/bridge/handshake`, 200. */
export interface HandshakeResult {
  project?: { id?: string | null; name?: string | null } | null;
  session?: unknown;
  protocol?: { v?: number | null } | null;
}
