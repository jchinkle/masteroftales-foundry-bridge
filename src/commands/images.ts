import { stripHtml, truncate } from "../capture/html.js";
import { MODULE_ID } from "../protocol/version.js";
import type { CommandLog } from "./index.js";

/**
 * `image.show` — MoT puts a picture on everyone's screen (or on one person's).
 *
 * This is the first command in the protocol that is **not** the active GM's
 * business alone, and that changes the shape of the file. `dice.show` and
 * `chat.post` create a *document*, and Foundry replicates documents to every
 * client for free — so rendering them on one client is both necessary and
 * sufficient. An image popout is a **window**, which is client-local: rendering
 * it on the GM's screen shows it to the GM and to nobody else.
 *
 * So the path has two halves, and they run on different machines:
 *
 *  1. **The GM's client** holds the only bridge socket (see src/activation.ts),
 *     receives `image.show`, and re-broadcasts it over Foundry's own module
 *     socket — the one channel this module has that reaches players' browsers.
 *     It also renders locally when the GM is among the targets, because Foundry
 *     deliberately does **not** echo `socket.emit` back to the sender.
 *  2. **Every client**, GM and player alike, listens on that module socket from
 *     `init` — *not* gated behind the activation gate, which is the one thing in
 *     this file that must not be "tidied up" to match the other commands. A
 *     listener registered only on the active GM would make this feature work
 *     exactly as well as printing the image on the GM's own monitor.
 *
 * Everything with a decision in it is pure: `planImageShow` validates, and
 * `isTargeted` answers the only question a receiving client has to ask.
 */

// ------------------------------------------------------------------ the wire

/** The `image.show` payload as MoT broadcasts it. */
export interface ImageShowPayload {
  url?: unknown;
  title?: unknown;
  /** `"all"`, or an array of Foundry user ids. */
  targets?: unknown;
}

/** `"all"` or a list of Foundry user ids. Normalised; never empty when a list. */
export type ImageTargets = "all" | string[];

/**
 * The event this module puts on Foundry's own socket. Deliberately a flat,
 * JSON-only object — Foundry serialises socket payloads, and anything clever
 * here would arrive as `{}` on the other end.
 */
export const IMAGE_SHOW_EVENT = "imageShow";

/** The module socket channel. Foundry namespaces these `module.<id>` by convention and by validation. */
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export interface ImageShowSocketEvent {
  type: typeof IMAGE_SHOW_EVENT;
  url: string;
  title: string | null;
  targets: ImageTargets;
}

// ------------------------------------------------------------------ the plan

export interface ImagePlan {
  url: string;
  /** Null when MoT sent nothing usable; the popout then titles itself. */
  title: string | null;
  targets: ImageTargets;
}

/** A window title, not a caption. */
export const MAX_TITLE_LENGTH = 120;

/** Foundry asset paths are long; URLs with signatures on them are longer. */
export const MAX_URL_LENGTH = 2_000;

/**
 * The most user ids one command may name. A table is not this big, and the list
 * is walked once per receiving client per command.
 */
export const MAX_TARGETS = 200;

/**
 * Schemes an image may come from.
 *
 * `https:` because that is where MoT's own uploads live, `http:` because a
 * self-hosted Foundry on a LAN is a real customer, and **a relative path**
 * because `worlds/curse-of-strahd/maps/barovia.webp` is how every asset already
 * in the GM's own Foundry is spelled.
 *
 * Everything else is refused, `javascript:` and `data:` included. An `<img src>`
 * makes `javascript:` inert, so this is not the last line of defence — it is the
 * first, and it is here because the day this file grows an `<a href>` or a
 * background-image the refusal should already be in place rather than needing to
 * be remembered.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validates and normalises an `image.show` payload. Null means "drop this
 * calmly" — no url, an unusable url, or a `targets` naming nobody.
 */
export function planImageShow(payload: unknown): ImagePlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as ImageShowPayload;

  const url = imageUrl(source.url);
  if (url === null) return null;

  const targets = planTargets(source.targets);
  if (targets === null) return null;

  return { url, title: imageTitle(source.title), targets };
}

/**
 * `"all"`, a non-empty deduped id list, or null.
 *
 * **A missing `targets` is null, not `"all"`.** Defaulting a broadcast is the
 * wrong direction to be wrong in: a command whose targeting MoT failed to send
 * should show nobody anything rather than putting an unexpected picture on every
 * player's screen mid-scene.
 */
export function planTargets(value: unknown): ImageTargets | null {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return null;

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id === "" || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_TARGETS) break;
  }

  return ids.length > 0 ? ids : null;
}

/** True when this client is one of the people the command was aimed at. */
export function isTargeted(targets: ImageTargets | null | undefined, userId: string | null | undefined): boolean {
  if (!targets) return false;
  if (targets === "all") return true;
  if (typeof userId !== "string" || userId === "") return false;
  return targets.includes(userId);
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LENGTH) return null;
  // No control characters and no interior whitespace. A `java\nscript:` is the
  // classic way past a naive scheme check, and `URL` itself strips tabs, newlines
  // and returns *before* parsing — which is precisely what would turn the
  // protocol check below into a lie. Refusing them is what makes it mean what
  // it reads as.
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return null;

  // A relative path — the spelling of every asset already inside the GM's own
  // Foundry. `new URL` needs a base to parse one, and the base is thrown away.
  let parsed: URL;
  try {
    parsed = new URL(trimmed, "https://example.invalid/");
  } catch {
    return null;
  }

  // The scheme check has to run against the *parsed* protocol rather than a
  // `startsWith`, so that `HTTPS:` and `\thttps:` are answered honestly.
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;

  // The original string is returned, not `parsed.href`: a relative path must
  // stay relative or it would resolve against `example.invalid` at render time.
  return trimmed;
}

/** Stripped of markup and capped. Foundry renders a window title as text, so no escaping. */
function imageTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = truncate(stripHtml(value).trim(), MAX_TITLE_LENGTH);
  return title === "" ? null : title;
}

// -------------------------------------------------------------- foundry glue

/** The `ImagePopout` surface this module touches. */
export interface ImagePopoutLike {
  render(force?: boolean): unknown;
}

/**
 * How the resolved class wants to be constructed.
 *
 * `"v13"` — `new ImagePopout({src, window: {title}})`. The ApplicationV2
 * rewrite, at `foundry.applications.apps.ImagePopout`, whose constructor takes a
 * **single options object** and reads the title from `window.title`.
 *
 * `"legacy"` — `new ImagePopout(src, {title})`. The v12-and-earlier global. The
 * module's own `compatibility.minimum` is 13, so this branch should never fire
 * in the field; it exists because the cost is four lines and the failure mode it
 * covers is a blank window with no error.
 */
export type ImagePopoutStyle = "v13" | "legacy";

export interface ImagePopoutApi {
  ImagePopout: new (...args: any[]) => ImagePopoutLike;
  style: ImagePopoutStyle;
}

/**
 * Picks the ImagePopout class out of a global scope, namespaced spelling first.
 *
 * The order is load-bearing, not stylistic. On v13 **both** spellings exist and
 * they are the same class — the bare global is a deprecated alias for the
 * namespaced one — so reaching for the global first would find the ApplicationV2
 * class and then call it with the v12 argument list, producing a popout with no
 * image in it. Namespace first means the version question is answered by where
 * the class was found rather than by parsing `game.version`.
 *
 * Takes the scope as an argument for the same reason `resolveDiceApi` does: this
 * is the single place "v13 or v12?" is asked about this class, and it is the one
 * thing here that a laptop cannot check by running the suite.
 */
export function resolveImagePopout(scope: unknown): ImagePopoutApi | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const apps = (global.foundry as { applications?: { apps?: Record<string, unknown> } } | undefined)?.applications
    ?.apps;

  const namespaced = apps?.ImagePopout;
  if (typeof namespaced === "function") {
    return { ImagePopout: namespaced as ImagePopoutApi["ImagePopout"], style: "v13" };
  }

  const legacy = global.ImagePopout;
  if (typeof legacy === "function") {
    return { ImagePopout: legacy as ImagePopoutApi["ImagePopout"], style: "legacy" };
  }

  return null;
}

/**
 * The constructor argument list for a plan, as a value.
 *
 * Pure and exported so both shapes are a unit test rather than a thing somebody
 * finds out about from a customer running the other major.
 *
 * On the v13 path the title is sent as **both** `window.title` and a bare
 * `title`. `window.title` is the real one; the flat key is inert padding that
 * costs nothing and means a subclass reading the old spelling still gets a
 * title rather than "Image".
 *
 * `shareable: false` goes on both. On v12 it suppressed the "Show to players"
 * header button; on v13+ that button is a `window.controls` entry gated on
 * `game.user.isGM`, so the option is ignored — harmlessly, since an unknown key
 * in an ApplicationV2 options object is merged and forgotten. It stays because
 * MoT is already deciding who sees this image, and a *second* share button
 * that re-broadcasts it through Foundry's own path is a footgun on the one
 * screen (the GM's) that has it.
 */
export function imagePopoutArgs(plan: ImagePlan, style: ImagePopoutStyle): unknown[] {
  if (style === "legacy") {
    return [plan.url, { title: plan.title ?? undefined, shareable: false }];
  }

  const options: Record<string, unknown> = { src: plan.url, shareable: false };
  if (plan.title !== null) {
    options.title = plan.title;
    options.window = { title: plan.title };
  }
  return [options];
}

/**
 * Constructs and renders. Returns false when Foundry refused, which is a shrug:
 * an image that would not open is a missing picture, never an exception on a
 * socket handler that also has to keep working for the next command.
 */
export function renderImagePopout(plan: ImagePlan, api: ImagePopoutApi): boolean {
  try {
    const popout = new api.ImagePopout(...imagePopoutArgs(plan, api.style));
    if (!popout || typeof popout.render !== "function") return false;
    // `render(true)` is "force" on both majors: v13's ApplicationV2 keeps the
    // boolean-first overload precisely so this call did not have to change.
    void Promise.resolve(popout.render(true)).catch(() => {
      // A client mid-teardown. Swallowed rather than left as an unhandled
      // rejection in somebody's console.
    });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------- the GM-side handler

export interface ImageShowDeps {
  /**
   * The activation gate, read per command. Only the active GM re-broadcasts —
   * without it, two GMs on one world would each emit and every player would open
   * the same picture twice.
   */
  isActive(): boolean;
  /** Puts the event on Foundry's module socket. Absent on a client with no socket yet. */
  emit(event: ImageShowSocketEvent): void;
  /** This client's own Foundry user id, for the local-render decision. */
  selfId(): string | null;
  /** Renders on *this* machine. Separate from `emit` because Foundry does not echo. */
  renderLocal(plan: ImagePlan): void;
  log?: CommandLog;
}

/**
 * The `image.show` renderer, as the dispatcher wires it. Runs on the GM only.
 *
 * The order — emit first, then render locally — is deliberate. The local render
 * opens a window, and a window opening is the one thing on this path that can
 * plausibly take a frame; doing it first would delay every player's copy behind
 * the GM's own.
 */
export function createImageShowHandler(deps: ImageShowDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planImageShow(payload);
    if (!plan) {
      deps.log?.debug?.("[masteroftales-bridge] dropping an image.show with nothing showable in it", payload);
      return;
    }

    try {
      deps.emit({ type: IMAGE_SHOW_EVENT, url: plan.url, title: plan.title, targets: plan.targets });
    } catch (error) {
      // A socket that would not take it still leaves the GM's own copy worth
      // opening, so this is not a return.
      deps.log?.debug?.("[masteroftales-bridge] image.show could not be sent to the other clients", error);
    }

    if (isTargeted(plan.targets, deps.selfId())) deps.renderLocal(plan);
  };
}

// ------------------------------------------------------ the every-client half

export interface ImageListenerDeps {
  /** This client's Foundry user id, read per event — a client can log in late. */
  selfId(): string | null;
  /** Resolves the Foundry class. Called per event, not cached. */
  api(): ImagePopoutApi | null;
  log?: CommandLog;
}

/**
 * The module-socket listener, registered on **every** client at `init`.
 *
 * Everything arriving here is untrusted in the ordinary sense — it came over a
 * socket, from a client we did not write — so it goes through `planImageShow`
 * exactly like the bridge payload did, rather than being taken at its word
 * because "the GM sent it".
 */
export function createImageSocketListener(deps: ImageListenerDeps): (event: unknown) => void {
  return (event: unknown): void => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    // Not our event. Silent, and not even a debug line: this channel is ours
    // alone today, but a future slice adding a second event type must not make
    // every client log about the first.
    if ((event as { type?: unknown }).type !== IMAGE_SHOW_EVENT) return;

    const plan = planImageShow(event);
    if (!plan) {
      deps.log?.debug?.("[masteroftales-bridge] ignoring a malformed imageShow socket event", event);
      return;
    }

    if (!isTargeted(plan.targets, deps.selfId())) return;

    const api = deps.api();
    if (!api) {
      deps.log?.debug?.("[masteroftales-bridge] no Foundry ImagePopout class available; dropping imageShow");
      return;
    }

    if (!renderImagePopout(plan, api)) {
      deps.log?.debug?.("[masteroftales-bridge] could not open an image popout", plan);
    }
  };
}
