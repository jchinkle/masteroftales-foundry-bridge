import type { SessionState } from "../protocol/session.js";
import { NO_SESSION_STATE, parseSessionState } from "../protocol/session.js";
import type { BridgeWelcomePayload, Envelope } from "../protocol/types.js";

/**
 * The inbound command dispatcher.
 *
 * v0.1.0 understands exactly two types — `bridge.welcome` and `session.state` —
 * and that is the point. Rule 1 of the protocol: **an unknown `type` is ignored,
 * not errored.** A module a version ahead of the server (or behind it) loses a
 * feature; it does not lose the connection, and it does not fill a customer's
 * console with red. Slice 4's `dice.show` and `chat.post` land here as new cases
 * and nothing else in the module changes.
 *
 * Both types carry the same `{status, id, name}` session object, which is why
 * the parsing lives in `protocol/session.ts` and this file only decides where in
 * the envelope to look for it.
 */

export interface SessionSummary extends SessionState {
  projectName: string | null;
}

export const NO_SESSION: SessionSummary = { ...NO_SESSION_STATE, projectName: null };

export interface CommandDeps {
  /** Called whenever a command carried session state. */
  onSession(summary: SessionSummary): void;
  log?: {
    debug?(message: string, ...rest: unknown[]): void;
    warn?(message: string, ...rest: unknown[]): void;
  };
}

/**
 * Reads session state out of an envelope, or returns null when the type is not
 * one that carries any. Pure — the dispatcher is a thin wrapper over this.
 */
export function readSessionState(envelope: Envelope | null | undefined): SessionSummary | null {
  if (!envelope || typeof envelope !== "object") return null;

  if (envelope.type === "bridge.welcome") {
    // The welcome nests the session inside a payload that also names the
    // project, so that a module reconnecting mid-session knows both facts
    // without a second round trip.
    const payload = (envelope.payload ?? {}) as BridgeWelcomePayload;
    return {
      ...parseSessionState(payload.session),
      projectName: text(payload.project_name) ?? text(payload.project_id),
    };
  }

  if (envelope.type === "session.state") {
    // Here the payload *is* the session object — same shape, one level up.
    return { ...parseSessionState(envelope.payload), projectName: null };
  }

  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Builds the handler wired to `BridgeSocket`'s `onEnvelope`.
 *
 * Project name is remembered across frames: `bridge.welcome` names the project
 * once at connect, and every `session.state` afterwards would otherwise blank it.
 */
export function createDispatcher(deps: CommandDeps): (envelope: Envelope) => void {
  let projectName: string | null = null;

  return (envelope: Envelope): void => {
    if (!envelope || typeof envelope !== "object") return;

    if (envelope.type === "bridge.unsupported") {
      // The visible half of rule 1, pointed the other way: the server telling us
      // it did not understand something we sent. Worth a line, never fatal.
      deps.log?.warn?.("[masteroftales-bridge] server did not understand an event we sent", envelope.payload);
      return;
    }

    const summary = readSessionState(envelope);
    if (!summary) {
      deps.log?.debug?.(`[masteroftales-bridge] ignoring unknown command type "${envelope.type}"`);
      return;
    }

    if (summary.projectName) projectName = summary.projectName;
    deps.onSession({ ...summary, projectName });
  };
}
