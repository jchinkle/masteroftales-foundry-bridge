/**
 * Session state — **one parser, four arrival points.**
 *
 * The server sends the identical object from `Bridge::Commands.session_state`
 * on every surface that mentions a session:
 *
 *   - `bridge.welcome`'s `payload.session`, on connect
 *   - the `session.state` command, when a session starts or ends
 *   - the `session` field of every `202` receipt from the events endpoint
 *   - the handshake body's `session`, behind the Test Connection button
 *
 * `{ status, id, name }`, or **null** when nothing is live. Parsing it in one
 * place is not tidiness — it is the reason the chip cannot disagree with itself
 * depending on which message happened to arrive last.
 */

/** `PlaySession::STATUSES` on the server. Never renumbered, never renamed. */
export type SessionStatus = "planned" | "live" | "ended";

export interface SessionState {
  /** The only question the capture path cares about: is anything recording? */
  live: boolean;
  status: SessionStatus | null;
  id: string | null;
  name: string | null;
}

export const NO_SESSION_STATE: SessionState = { live: false, status: null, id: null, name: null };

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function status(value: unknown): SessionStatus | null {
  const raw = text(value);
  return raw === "planned" || raw === "live" || raw === "ended" ? raw : null;
}

/**
 * `null` in, "nothing is live" out — which is the state a table spends most of
 * its week in and is never an error.
 *
 * An `ended` session arrives as a populated object rather than as null (the
 * server sends the session that just changed), so `live` is decided by the
 * status and not by the object's presence. Getting that backwards would leave
 * the chip green all night after a session ended.
 */
export function parseSessionState(raw: unknown): SessionState {
  if (!raw || typeof raw !== "object") return { ...NO_SESSION_STATE };

  const source = raw as Record<string, unknown>;
  const parsed = status(source.status);

  return {
    live: parsed === "live",
    status: parsed,
    id: text(source.id),
    name: text(source.name),
  };
}

/** True when the object carried a `session` key at all — absent is not the same as null. */
export function carriesSession(body: unknown): boolean {
  return !!body && typeof body === "object" && "session" in (body as Record<string, unknown>);
}
