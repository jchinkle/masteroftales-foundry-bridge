import type { Envelope } from "../protocol/types.js";

/**
 * The ActionCable *client* protocol, as a pure parser.
 *
 * We speak this by hand rather than shipping `@rails/actioncable`, because the
 * module wants no runtime dependencies and the protocol is six message types.
 * Writing it out also means the one frame-ordering surprise below is documented
 * in the place a reader will actually be standing when it bites them.
 *
 * Server -> client frames:
 *   {"type":"welcome"}                                  handshake accepted
 *   {"type":"ping","message":1755468000}                every ~3s; liveness only
 *   {"type":"confirm_subscription","identifier":"…"}    subscription accepted
 *   {"type":"reject_subscription","identifier":"…"}     channel called `reject`
 *   {"type":"disconnect","reason":"…","reconnect":false} server is ending it
 *   {"identifier":"…","message":{…}}                    actual channel data
 *
 * Client -> server: {"command":"subscribe","identifier":"…"} and nothing else —
 * this module never talks back over the cable. The Foundry -> MoT direction is
 * HTTP, deliberately (see transport/outbox.ts).
 */

export const CHANNEL_NAME = "BridgeChannel";

/**
 * ActionCable identifiers are *strings containing JSON*, and the server matches
 * subscriptions by exact string equality after its own round-trip through
 * `JSON.parse`/`to_json`. `JSON.stringify` of a single-key object is stable, so
 * this is safe — but it is why the value is built once here rather than inlined.
 */
export const CHANNEL_IDENTIFIER = JSON.stringify({ channel: CHANNEL_NAME });

export const SUBSCRIBE_COMMAND = JSON.stringify({
  command: "subscribe",
  identifier: CHANNEL_IDENTIFIER,
});

export type CableFrame =
  | { kind: "welcome" }
  | { kind: "ping"; at: number | null }
  | { kind: "confirm_subscription"; identifier: string | null }
  | { kind: "reject_subscription"; identifier: string | null }
  | { kind: "disconnect"; reason: string | null; reconnect: boolean }
  | { kind: "message"; identifier: string | null; envelope: Envelope }
  | { kind: "unknown"; raw: unknown };

/**
 * Never throws. A frame we cannot parse is `unknown` and gets ignored — same
 * rule as an unknown envelope type, one layer down.
 */
export function parseCableFrame(data: unknown): CableFrame {
  let parsed: unknown = data;

  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      return { kind: "unknown", raw: data };
    }
  }

  if (!parsed || typeof parsed !== "object") return { kind: "unknown", raw: data };

  const frame = parsed as Record<string, unknown>;
  const identifier = typeof frame.identifier === "string" ? frame.identifier : null;

  switch (frame.type) {
    case "welcome":
      return { kind: "welcome" };

    case "ping":
      return { kind: "ping", at: typeof frame.message === "number" ? frame.message : null };

    case "confirm_subscription":
      return { kind: "confirm_subscription", identifier };

    case "reject_subscription":
      return { kind: "reject_subscription", identifier };

    case "disconnect":
      return {
        kind: "disconnect",
        reason: typeof frame.reason === "string" ? frame.reason : null,
        // ActionCable omits `reconnect` when it means true.
        reconnect: frame.reconnect !== false,
      };

    default:
      break;
  }

  // A data frame: no `type`, an `identifier`, and the channel's payload in
  // `message` — which for this channel is always a bridge envelope.
  if ("message" in frame && frame.message && typeof frame.message === "object") {
    return {
      kind: "message",
      identifier,
      envelope: frame.message as Envelope,
    };
  }

  return { kind: "unknown", raw: parsed };
}

/**
 * The auth failure shape, which is not the one you would guess: the socket
 * **upgrades successfully** (HTTP 101) and only then receives a `disconnect`
 * frame. There is no 401 to catch, because by the time Rails has resolved the
 * token the handshake is already done — which is also why a bad token looks
 * exactly like a good one for the first few hundred milliseconds.
 */
const UNAUTHORIZED_REASONS = new Set(["unauthorized", "invalid_request"]);

export function isUnauthorizedDisconnect(frame: CableFrame): boolean {
  return frame.kind === "disconnect" && UNAUTHORIZED_REASONS.has(frame.reason ?? "");
}

/**
 * `reconnect: false` is the server saying "do not come back". Distinct from the
 * check above because `server_restart` disconnects carry `reconnect: true` and
 * *should* be retried — treating every disconnect as fatal would leave the whole
 * customer base offline after a MoT deploy until each GM reloaded Foundry.
 */
export function shouldStopReconnecting(frame: CableFrame): boolean {
  return frame.kind === "disconnect" && frame.reconnect === false;
}
