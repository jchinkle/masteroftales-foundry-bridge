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

export type InboundEnvelope =
  | Envelope<RollMadePayload>
  | Envelope<ChatPostedPayload>;

// ------------------------------------------------------------------- batching

export interface BridgeInfo {
  world: string;
  foundry: string;
  system: { id: string; version: string };
  module: string;
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
