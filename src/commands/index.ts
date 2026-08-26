import type { SessionState } from "../protocol/session.js";
import { NO_SESSION_STATE, parseSessionState } from "../protocol/session.js";
import type { BridgeWelcomePayload, Envelope } from "../protocol/types.js";

/**
 * The inbound command dispatcher.
 *
 * It understands ten types — `bridge.welcome` and `session.state`, which carry
 * session state, and `dice.show`, `chat.post`, `image.show`, `handout.show`,
 * `encounter.deploy`, `actors.request`, `actor.create` and `actor.place`, which
 * are acted on by `commands/dice.ts`, `commands/chat.ts`, `commands/images.ts`,
 * `commands/handouts.ts`, `commands/encounters.ts` (which owns `encounter.deploy`
 * and `actors.request`), `commands/actorCreate.ts` and `commands/actorPlace.ts`.
 * Everything else is ignored, and that is the point. Rule 1 of the protocol: **an unknown
 * `type` is ignored, not errored.** A module a version ahead of the server (or
 * behind it) loses a feature; it does not lose the connection, and it does not
 * fill a customer's console with red.
 *
 * The two session types carry the same `{status, id, name}` object, which is why
 * that parsing lives in `protocol/session.ts` and this file only decides where in
 * the envelope to look for it. The render types are handed to callbacks the
 * caller supplies, so this file stays free of every Foundry global.
 */

export interface SessionSummary extends SessionState {
  projectName: string | null;
}

export const NO_SESSION: SessionSummary = { ...NO_SESSION_STATE, projectName: null };

/** The logger shape every command path accepts. Nothing here is ever required. */
export interface CommandLog {
  debug?(message: string, ...rest: unknown[]): void;
  warn?(message: string, ...rest: unknown[]): void;
}

/**
 * A speaker alias is a character name — "Tharivol", "GM", "The Innkeeper".
 * Anything longer than this is a payload bug, and truncating it is kinder to the
 * chat log than rendering it.
 */
export const MAX_ALIAS_LENGTH = 120;

/**
 * `speaker.alias` as both render commands read it: a trimmed, capped string, or
 * null when MoT sent nothing usable.
 *
 * **Not** HTML-escaped, deliberately: the alias is a document field that
 * Foundry's own chat template renders through an escaping expression, so
 * escaping it here would put a literal `&amp;` above the message.
 */
export function speakerAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length <= MAX_ALIAS_LENGTH ? trimmed : `${trimmed.slice(0, MAX_ALIAS_LENGTH - 1)}…`;
}

export interface CommandDeps {
  /** Called whenever a command carried session state. */
  onSession(summary: SessionSummary): void;
  /**
   * Renders `dice.show`. Optional: a client with no renderer wired treats the
   * type exactly like an unknown one, which is what keeps this file testable
   * without a Foundry and honest about rule 1.
   */
  onDiceShow?(payload: unknown): void;
  /** Renders `chat.post`. Optional, for the same reason. */
  onChatPost?(payload: unknown): void;
  /**
   * Handles `image.show`. Optional, for the same reason again — but note that
   * "renders" is the wrong verb here: this one re-broadcasts over Foundry's own
   * module socket and only renders locally when the GM is a target. See
   * commands/images.ts, which is the one command whose work happens on machines
   * other than this one.
   */
  onImageShow?(payload: unknown): void;
  /**
   * Handles `handout.show`. Optional, for the same reason again — and "renders"
   * is the wrong verb for this one too. It fetches the page's player-safe
   * markdown from MoT over the bridge token, writes it into the world as a
   * JournalEntry, and lets Foundry show that document to the targets. Unlike
   * `image.show` all of that happens on this one client. See
   * commands/handouts.ts.
   */
  onHandoutShow?(payload: unknown): void;
  /**
   * Handles `encounter.deploy`. Optional, for the same reason again — and this
   * one renders least of all: it opens a tray on the GM's own screen and then
   * waits for a human to drag things out of it. Nothing reaches the table until
   * the GM puts it there. See commands/encounters.ts.
   */
  onEncounterDeploy?(payload: unknown): void;
  /**
   * Handles `actors.request`. Optional, for the same reason again — and the odd
   * one out of the whole table: it is the only inbound type whose answer travels
   * *back* to Master of Tales rather than into Foundry. MoT is asking this world
   * for its actor catalog so an encounter planner in the browser has a pick-list.
   * See commands/encounters.ts and protocol/actors.ts.
   */
  onActorsRequest?(payload: unknown): void;
  /**
   * Handles `actor.create`. Optional, for the same reason again — and it is the
   * one type that points **both** ways: a creature invented in Master of Tales is
   * written into this world as an Actor, its picture is written into the world's
   * own data directory, and the id Foundry gave it is POSTed home so MoT can
   * point its own page at a real actor. See commands/actorCreate.ts.
   */
  onActorCreate?(payload: unknown): void;
  /**
   * Handles `actor.place`. Optional, for the same reason again — and it is the
   * quietest of the lot: one token for a creature this world already has, onto
   * the scene the GM is looking at, centred in their current view. No combat, no
   * initiative, no answer back to MoT. See commands/actorPlace.ts.
   */
  onActorPlace?(payload: unknown): void;
  log?: CommandLog;
}

/**
 * The types this module renders into Foundry, and the dep that renders each.
 *
 * A Map rather than an object literal, because `envelope.type` is a string off
 * the wire: an object lookup would answer `"toString"` with something inherited
 * and truthy, and this table has to be able to say "no" to any string at all.
 */
const RENDERED = new Map<
  string,
  keyof Pick<
    CommandDeps,
    | "onDiceShow"
    | "onChatPost"
    | "onImageShow"
    | "onHandoutShow"
    | "onEncounterDeploy"
    | "onActorsRequest"
    | "onActorCreate"
    | "onActorPlace"
  >
>([
  ["dice.show", "onDiceShow"],
  ["chat.post", "onChatPost"],
  ["image.show", "onImageShow"],
  ["handout.show", "onHandoutShow"],
  ["encounter.deploy", "onEncounterDeploy"],
  ["actors.request", "onActorsRequest"],
  ["actor.create", "onActorCreate"],
  ["actor.place", "onActorPlace"],
]);

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

    const renderer = RENDERED.get(envelope.type);
    if (renderer) {
      const render = deps[renderer];
      if (!render) {
        // Wired nowhere — a dispatcher built without a Foundry to render into.
        // Reads as an unknown type rather than as a problem.
        deps.log?.debug?.(`[masteroftales-bridge] no renderer wired for "${envelope.type}"`);
        return;
      }
      try {
        render(envelope.payload);
      } catch (error) {
        // Belt and braces over each handler's own guards: a command that cannot
        // be rendered is a missing animation, never a socket that stops
        // delivering session state for the rest of the night.
        deps.log?.debug?.(`[masteroftales-bridge] could not render "${envelope.type}"`, error);
      }
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
