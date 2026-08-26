import { stripHtml, truncate } from "../capture/html.js";
import type { ActorCreationBody } from "../protocol/actors.js";
import { actorCreationBody } from "../protocol/actors.js";
import type { CommandLog } from "./index.js";
import type { ActorImageResult, FilePickerApi } from "./tokenImages.js";
import {
  readActorImage,
  REASON_BAD_IMAGE,
  REASON_NO_FILE_API,
  REASON_UPLOAD_FAILED,
  uploadTokenImage,
} from "./tokenImages.js";

/**
 * `actor.create` — a creature invented in Master of Tales is written into this
 * world as a real Foundry Actor, with its picture written into the world's own
 * data directory.
 *
 * The picture half of that sentence lives in commands/tokenImages.ts, which is
 * shared with `actor.place` and carries the whole argument for copying the bytes
 * rather than hotlinking them. What is left here is the *actor*.
 *
 * Two decisions worth stating, because each is the sort of thing a later reader
 * would tidy into a bug:
 *
 *  1. **`key` is opaque and is echoed back verbatim.** MoT minted it to match the
 *     answer to the request; this module never parses it, never logs it, and never
 *     assumes it means anything. It is emphatically **not** a MoT record id — the
 *     bridge wire does not carry those, in either direction, ever, and the report
 *     that goes home carries only the key, Foundry's own actor id and Foundry's
 *     own name.
 *  2. **A failure is a notification and no report.** The keeper is standing in
 *     MoT waiting for an answer; a create that could not happen has to say so on
 *     the screen they are looking at *and* leave MoT's side unresolved, rather
 *     than reporting an actor id for something that is not in the world.
 *
 * GM-side only, like every other inbound command: the bridge socket lives in one
 * browser (src/activation.ts), and so does the token the report rides on.
 *
 * Everything with a decision in it is pure and lives above the glue line — the
 * plan, the actor type and the `Actor.create` argument are all *values*, so their
 * shapes are unit tests rather than something a customer discovers at a table.
 */

// ------------------------------------------------------------------ the wire

/** The `actor.create` payload as MoT broadcasts it. */
export interface ActorCreatePayload {
  /**
   * An opaque correlation string. Echoed back verbatim in the report and used for
   * nothing else — not parsed, not logged, not interpreted.
   */
  key?: unknown;
  name?: unknown;
  /** See commands/tokenImages.ts. Null when the creature has no art yet. */
  image?: unknown;
}

// ------------------------------------------------------------------ the plan

export interface ActorCreatePlan {
  /** Opaque. Echoed, never read. */
  key: string;
  /** Never empty — see {@link FALLBACK_ACTOR_NAME}. */
  name: string;
  image: ActorImageResult;
}

/** A creature's name is a name, not a statblock. */
export const MAX_ACTOR_NAME_LENGTH = 120;

/** The correlation key is a short handle. Anything longer is a payload bug. */
export const MAX_KEY_LENGTH = 200;

/** When MoT sent nothing usable in `name`. Better than refusing the creature. */
export const FALLBACK_ACTOR_NAME = "Unnamed Creature";

/**
 * Validates and normalises an `actor.create` payload. Null means "drop this
 * calmly": no usable `key`, which is the one field the whole command turns on —
 * without it there is nothing to report an answer against, and an actor created
 * for a request nobody can match is litter in somebody's world.
 *
 * Note what is *not* a reason to return null: a missing name (falls back), and a
 * broken image (planned as `refused`, so the handler can say so out loud).
 */
export function planActorCreate(payload: unknown): ActorCreatePlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as ActorCreatePayload;

  const key = handle(source.key);
  if (key === null) return null;

  return { key, name: creatureName(source.name), image: readActorImage(source.image) };
}

/** Stripped of markup, capped, and never empty. */
function creatureName(value: unknown): string {
  if (typeof value !== "string") return FALLBACK_ACTOR_NAME;
  const text = truncate(stripHtml(value).trim(), MAX_ACTOR_NAME_LENGTH);
  return text === "" ? FALLBACK_ACTOR_NAME : text;
}

/**
 * A short opaque handle. Control characters are refused because this string is
 * put back on the wire; nothing here is ever parsed for meaning.
 */
function handle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_KEY_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

// ------------------------------------------------------------- the actor

/** An Actor as this command reads the one it just made. */
export interface CreatedActor {
  id?: string | null;
  name?: string | null;
}

/** The one class this command constructs. */
export interface ActorApi {
  Actor: { create(data: Record<string, unknown>): unknown };
}

/** Picks the Actor class out of a global scope, namespaced spelling first. */
export function resolveActorApi(scope: unknown): ActorApi | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const documents = (global.foundry as { documents?: Record<string, unknown> } | undefined)?.documents;

  for (const candidate of [documents?.Actor, global.Actor]) {
    if (typeof candidate !== "function") continue;
    if (typeof (candidate as unknown as Record<string, unknown>).create === "function") {
      return { Actor: candidate as unknown as ActorApi["Actor"] };
    }
  }

  return null;
}

/** What a creature from MoT is, when the system has a word for it. */
export const PREFERRED_ACTOR_TYPE = "npc";

/** Foundry's own type on every document family. Never a thing to create. */
export const BASE_ACTOR_TYPE = "base";

/**
 * The actor types this world has, read out of whatever Foundry handed over.
 *
 * `game.documentTypes.Actor` is an array of strings; a system's own
 * `documentTypes.Actor` is an object keyed by type. Both are accepted, because
 * which one a call site can reach has moved between majors and neither is worth a
 * version check.
 */
export function actorTypeNames(source: unknown): string[] {
  const raw: unknown[] = Array.isArray(source)
    ? source
    : source && typeof source === "object"
      ? Object.keys(source as Record<string, unknown>)
      : [];

  const names: string[] = [];
  for (const value of raw) {
    const name = nonEmpty(value);
    if (name === null || name === BASE_ACTOR_TYPE || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * The type a creature from MoT is created as.
 *
 * `npc` when the system has one, which covers dnd5e, pf2e and most of the d20
 * family; otherwise the system's **first** actor type, which is the one its own
 * dialog offers first. `npc` again when the world could not be read at all — a
 * create that fails on a type the system rejects is a notification the keeper can
 * act on, and it is a better answer than refusing to try.
 */
export function defaultActorType(source: unknown): string {
  const names = actorTypeNames(source);
  if (names.includes(PREFERRED_ACTOR_TYPE)) return PREFERRED_ACTOR_TYPE;
  return names[0] ?? PREFERRED_ACTOR_TYPE;
}

/**
 * The `Actor.create` argument, as a value.
 *
 * `img` **and** `prototypeToken.texture.src` both point at the uploaded file: the
 * first is the portrait on the sheet and in the directory, the second is what
 * stands on the map when the keeper drags the row out of an encounter tray. A
 * creature with only one of them set is a creature that looks right in exactly
 * one of the two places it appears.
 *
 * With no picture, neither field is written — not `null`, not `""`. Foundry's own
 * schema default is the system's placeholder silhouette, and overriding it with an
 * empty string produces a broken image square instead.
 *
 * **No origin stamp, and that is a decision, not an omission.** The loop guard's
 * flag means "this document's creation *is* the echo" — right for a mirrored
 * chat message, whose whole life is the event it echoes. An Actor is a
 * persistent creature: nothing captures `createActor`, so there is no echo to
 * brake — and a stamped Actor is dropped by `buildActorUpdate` on sight, which
 * mutes its hit points and conditions in the session log for the rest of its
 * life. A creature made from MoT must live in the world exactly as one made by
 * hand, which is also the rule the placed token in actorPlace.ts follows.
 */
export function actorCreateData(name: string, type: string, path: string | null): Record<string, unknown> {
  const data: Record<string, unknown> = { name, type };
  if (path !== null) {
    data.img = path;
    data.prototypeToken = { texture: { src: path } };
  }
  return data;
}

// ------------------------------------------------------------- what to say

/** The reason on a notification, as a sentence the keeper can act on. */
export const REASON_NO_ACTOR_API = "this Foundry has no Actor class available yet.";
export const REASON_CREATE_FAILED = "Foundry refused the new actor.";
export const REASON_UNEXPECTED = "something in this world refused the write.";

/** The notification voice: one sentence, the creature's name, and why. */
export function failureMessage(name: string, reason: string): string {
  return `Could not create "${name}" in Foundry: ${reason}`;
}

/** The half-success: the actor is real, MoT does not know about it. */
export function unreportedMessage(name: string): string {
  return `Created "${name}" in Foundry, but Master of Tales did not hear back about it.`;
}

// ----------------------------------------------------- the GM-side handler

export interface ActorCreateDeps {
  /**
   * The activation gate, read per command. Only the active GM writes: two GM
   * clients acting on one press would put two goblins in the directory and report
   * two different ids for one request.
   */
  isActive(): boolean;
  /** Resolves FilePicker. Called per command, not cached. */
  files(): FilePickerApi | null;
  /** Resolves the Actor class. Called per command, not cached. */
  actors(): ActorApi | null;
  /** `game.documentTypes?.Actor`, or the system's own table. Read per command. */
  actorTypes(): unknown;
  /** `POST /api/v1/bridge/actor_creations`, with the bearer token. */
  report(body: ActorCreationBody): Promise<unknown>;
  /** A Foundry ui notification, in the module's own voice. */
  notify(level: "info" | "warn" | "error", message: string): void;
  log?: CommandLog;
}

/**
 * The `actor.create` handler, as the dispatcher wires it.
 *
 * Returns synchronously — the dispatcher is synchronous, and a command carrying a
 * megabyte of picture and a network round trip must not hold up the next frame off
 * the socket. Nothing here ever throws into the dispatcher, and nothing here ever
 * leaves an unhandled rejection.
 */
export function createActorCreateHandler(deps: ActorCreateDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planActorCreate(payload);
    if (!plan) {
      // No key means no answer can be matched to this request. Dropped quietly
      // rather than notified: nobody at this table asked for it.
      deps.log?.debug?.("[masteroftales-bridge] dropping an actor.create with no correlation key in it");
      return;
    }

    void run(deps, plan).catch((error: unknown) => {
      deps.log?.warn?.("[masteroftales-bridge] could not create an actor from Master of Tales", error);
      announce(deps, "error", failureMessage(plan.name, REASON_UNEXPECTED));
    });
  };
}

async function run(deps: ActorCreateDeps, plan: ActorCreatePlan): Promise<void> {
  if (plan.image.status === "refused") {
    deps.log?.warn?.(`[masteroftales-bridge] refusing a token image for "${plan.name}": ${plan.image.reason}`);
    announce(deps, "error", failureMessage(plan.name, REASON_BAD_IMAGE));
    return;
  }

  const api = deps.actors();
  if (!api) {
    deps.log?.warn?.("[masteroftales-bridge] no Foundry Actor class available; dropping actor.create");
    announce(deps, "error", failureMessage(plan.name, REASON_NO_ACTOR_API));
    return;
  }

  let path: string | null = null;
  if (plan.image.status === "ready") {
    const files = deps.files();
    if (!files) {
      deps.log?.warn?.("[masteroftales-bridge] no Foundry FilePicker available; dropping actor.create");
      announce(deps, "error", failureMessage(plan.name, REASON_NO_FILE_API));
      return;
    }

    // The picture first, and the actor only if it landed. The other order would
    // leave a creature in the directory wearing the system's placeholder while MoT
    // was told it has art.
    path = await uploadTokenImage(files, plan.image.image, deps.log);
    if (path === null) {
      announce(deps, "error", failureMessage(plan.name, REASON_UPLOAD_FAILED));
      return;
    }
  }

  let created: CreatedActor | null;
  try {
    created =
      ((await api.Actor.create(
        actorCreateData(plan.name, defaultActorType(deps.actorTypes()), path),
      )) as CreatedActor | null) ?? null;
  } catch (error) {
    deps.log?.warn?.("[masteroftales-bridge] Foundry refused to create the actor", error);
    announce(deps, "error", failureMessage(plan.name, REASON_CREATE_FAILED));
    return;
  }

  const actorId = nonEmpty(created?.id);
  if (actorId === null) {
    // A create that resolved to nothing, or to a document with no id. There is no
    // honest report to send: `actorId` is the whole point of the answer.
    deps.log?.warn?.("[masteroftales-bridge] Foundry created no actor for an actor.create");
    announce(deps, "error", failureMessage(plan.name, REASON_CREATE_FAILED));
    return;
  }

  // Foundry's own name wins over the planned one, for `resolveEntries`'s reason:
  // the thing that now exists in this world is the thing MoT should be told about,
  // and a system or module that renamed it on creation renamed it for real.
  const name = nonEmpty(created?.name) ?? plan.name;

  try {
    await deps.report(actorCreationBody(plan.key, actorId, name));
  } catch (error) {
    // The actor is real and is in the directory; only the answer went astray.
    // Said out loud, because the keeper is watching MoT wait for it.
    deps.log?.warn?.("[masteroftales-bridge] could not report the new actor to Master of Tales", error);
    announce(deps, "warn", unreportedMessage(name));
    return;
  }

  deps.log?.debug?.(`[masteroftales-bridge] created actor ${actorId} from Master of Tales`);
}

/**
 * A notification that cannot itself become the failure.
 *
 * `ui.notifications` is a global on somebody else's client, and this is the path
 * that *reports* trouble — a toast that threw would turn a handled failure into an
 * unhandled rejection, which is the one thing the header promises does not happen.
 */
function announce(deps: ActorCreateDeps, level: "info" | "warn" | "error", message: string): void {
  try {
    deps.notify(level, message);
  } catch (error) {
    deps.log?.debug?.("[masteroftales-bridge] could not show a notification", error);
  }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
