import { stripHtml, truncate } from "../capture/html.js";
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
 * `actor.place` — one token, for a creature this world already has, onto the map
 * the keeper is looking at.
 *
 * The sibling of `encounter.deploy` with everything a fight needs taken out of it.
 * A deploy is a plan: several rows, several copies each, a tray, a human dragging,
 * and Foundry's own initiative afterwards. This is the other half of how a monster
 * reaches a table — *"sometimes I just want to add an NPC to a view"* — and so it
 * is one token, placed where the keeper is already looking, with **no combat, no
 * initiative and no tracker** anywhere in the path. A command that quietly started
 * a fight because a keeper wanted a shopkeeper on the map would be the module
 * having an opinion about somebody else's evening.
 *
 * Four decisions worth stating:
 *
 *  1. **The current view, not the active scene.** The scene comes from `canvas`,
 *     which is the map on *this* screen; `game.scenes.active` is the map the
 *     players are on, and the two differ precisely when a keeper is setting
 *     something up before revealing it. A token that landed on the players' map
 *     because the keeper was preparing the next one is the worst failure this
 *     command could have. With no canvas and no scene, nothing is placed and the
 *     keeper is told.
 *  2. **The prototype token is the keeper's own configuration, and it wins.** Size,
 *     vision, disposition, link, bars, name — all of it comes from
 *     `actor.prototypeToken`, exactly as a drag from the actor directory would.
 *     This command overrides two things and only two: where it stands, and (when
 *     MoT sent a picture) which file it wears.
 *  3. **A picked variant dresses the token, never the actor.** The uploaded file
 *     goes onto *this token's* `texture.src`. The actor's prototype and portrait
 *     are not touched, because a keeper who wanted the bugbear to look different
 *     from now on would have edited the bugbear.
 *  4. **Fire and forget.** Nothing is reported back to MoT — there is no
 *     correlation key in the payload and none should be invented. The feedback is
 *     the token appearing, which is the same feedback `image.show` gives. Only a
 *     *failure* speaks, and it speaks on the keeper's own screen.
 *
 * GM-side only, like every other inbound command: the bridge socket lives in one
 * browser (src/activation.ts), and two GMs acting on one press would place two
 * tokens for one creature.
 *
 * Everything with a decision in it is pure and lives above the glue line — the
 * plan, the grid size, the view centre, the position and the token data are all
 * *values*, so their shapes are unit tests rather than something a customer
 * discovers at a table.
 */

// ------------------------------------------------------------------ the wire

/** The `actor.place` payload as MoT broadcasts it. */
export interface ActorPlacePayload {
  /**
   * A raw Foundry Actor id, not a uuid, and **not** a MoT record id — the bridge
   * wire does not carry those, in either direction, ever. It is a handle this
   * world minted and MoT is handing back.
   */
  actorId?: unknown;
  /** What MoT calls the creature. Used for the notification when a failure has to name it. */
  name?: unknown;
  /** See commands/tokenImages.ts. Null when the keeper picked no variant. */
  image?: unknown;
}

// ------------------------------------------------------------------ the plan

export interface ActorPlacePlan {
  actorId: string;
  /** Null when MoT sent nothing usable; the actor's own name is the better one anyway. */
  name: string | null;
  image: ActorImageResult;
}

/** A creature's name is a name, not a statblock. */
export const MAX_PLACED_NAME_LENGTH = 120;

/** A Foundry document id is a short handle. Anything longer is a payload bug. */
export const MAX_ACTOR_ID_LENGTH = 200;

/** When neither MoT nor this world could name the creature a failure is about. */
export const FALLBACK_PLACED_NAME = "Unnamed Creature";

/**
 * Validates and normalises an `actor.place` payload. Null means "drop this
 * calmly": no usable `actorId`, which is the one field the whole command turns on.
 * There is nothing to place without it and nobody to tell — MoT is not waiting on
 * an answer, so a payload this broken is a log line and no more.
 *
 * Note what is *not* a reason to return null: a missing name (the actor has one),
 * and a broken image (planned as `refused`, so the handler can say so out loud).
 */
export function planActorPlace(payload: unknown): ActorPlacePlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as ActorPlacePayload;

  const actorId = handle(source.actorId);
  if (actorId === null) return null;

  return { actorId, name: label(source.name), image: readActorImage(source.image) };
}

/**
 * A short opaque handle. Control characters are refused because this string is
 * compared against ids read off documents and rendered into a toast; neither
 * reads well with a newline in the middle.
 */
function handle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_ACTOR_ID_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/** Stripped of markup and capped: it is written into a notification, not rendered. */
function label(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = truncate(stripHtml(value).trim(), MAX_PLACED_NAME_LENGTH);
  return text === "" ? null : text;
}

// ------------------------------------------------------------------ the actor

/**
 * An Actor, as this command touches it. Three fields, and the module has no
 * business with a fourth: the prototype token is the keeper's own answer to what
 * this creature looks like on a map.
 */
export interface PlaceableActor {
  id?: string | null;
  name?: string | null;
  /**
   * A `PrototypeToken` data model on a real Foundry actor, and a plain object on
   * the source objects several Foundry paths (and every one of our stubs) hand
   * back. Both are read — see {@link prototypeTokenData}.
   */
  prototypeToken?: unknown;
}

/**
 * The prototype token as plain data, however this Foundry spells it.
 *
 * `toObject()` first, which is what a real `PrototypeToken` answers with and the
 * only way to get its defaults filled in; a plain object second; an empty object
 * last, which produces a token Foundry builds entirely from its own schema
 * defaults. Never throws: a prototype that will not serialise is a plainer token,
 * not a lost command.
 */
export function prototypeTokenData(actor: PlaceableActor | null | undefined): Record<string, unknown> {
  const proto = actor?.prototypeToken;
  if (!proto || typeof proto !== "object") return {};

  const toObject = (proto as { toObject?: unknown }).toObject;
  if (typeof toObject === "function") {
    try {
      const data = (toObject as () => unknown).call(proto);
      if (data && typeof data === "object" && !Array.isArray(data)) return { ...(data as Record<string, unknown>) };
    } catch {
      // A data model mid-teardown. The raw object below is the fallback.
    }
  }

  return Array.isArray(proto) ? {} : { ...(proto as Record<string, unknown>) };
}

// ------------------------------------------------------------------ the map

/** A point in scene coordinates — pixels, with the scene's padding already in them. */
export interface ScenePoint {
  x: number;
  y: number;
}

/** How many grid squares of map a token covers. */
export interface TokenFootprint {
  width: number;
  height: number;
}

/** The Scene this command writes one token into. */
export interface PlacementScene {
  id?: string | null;
  name?: string | null;
  /** v10+: the scene's own grid block, and the authority on its size. */
  grid?: { size?: unknown } | null;
  createEmbeddedDocuments?(embeddedName: string, data: Record<string, unknown>[]): unknown;
}

/**
 * `canvas`, as this command reads it. Every field is optional: a client still
 * booting, or one with no scene up, has most of them missing, and that is a
 * notification rather than an exception.
 */
export interface CanvasLike {
  /** False while the canvas is between scenes. */
  ready?: boolean;
  scene?: PlacementScene | null;
  /** PIXI's stage. `pivot` is the point in scene coordinates the view is centred on. */
  stage?: { pivot?: { x?: unknown; y?: unknown } | null } | null;
  /** The rendered grid layer. A fallback for the size; the scene document is the first source. */
  grid?: { size?: unknown } | null;
  /** The scene rectangle, including padding. The fallback for "where is the view". */
  dimensions?: { sceneX?: unknown; sceneY?: unknown; sceneWidth?: unknown; sceneHeight?: unknown } | null;
}

/**
 * Picks `canvas` out of a global scope.
 *
 * Unlike `Actor`, `Combat` and `FilePicker` there is no namespaced spelling to
 * prefer — `canvas` is a bare global on every major this module supports, and it
 * is `null` until the first scene is drawn. Taking the scope as an argument makes
 * every "this client is not ready" branch a unit test rather than something a
 * customer discovers at a table.
 */
export function resolveCanvas(scope: unknown): CanvasLike | null {
  if (!scope || typeof scope !== "object") return null;
  const value = (scope as { canvas?: unknown }).canvas;
  if (!value || typeof value !== "object") return null;
  return value as CanvasLike;
}

/**
 * The scene a token may be placed on right now, or null.
 *
 * **`canvas.scene`, deliberately, and never `game.scenes.active`.** See decision 1
 * in the header: the active scene is the players' map, and this command is about
 * the one in front of the keeper. A canvas that says it is not ready is between
 * scenes and is refused for the same reason.
 */
export function placementScene(canvas: CanvasLike | null | undefined): PlacementScene | null {
  if (!canvas || canvas.ready === false) return null;

  const scene = canvas.scene;
  if (!scene || typeof scene !== "object") return null;
  // A scene document that cannot take embedded documents is a client mid-teardown.
  if (typeof scene.createEmbeddedDocuments !== "function") return null;

  return scene;
}

/** Foundry's own default, and what a scene that will not say gets measured in. */
export const DEFAULT_GRID_SIZE = 100;

/**
 * The scene's grid size in pixels.
 *
 * The scene document first — it is the world's saved answer and it is right even
 * on a client whose canvas layers have not finished drawing — then the rendered
 * grid, then Foundry's default. A token two squares wide is only two squares wide
 * relative to this number.
 */
export function gridSize(canvas: CanvasLike | null | undefined, scene: PlacementScene | null | undefined): number {
  for (const candidate of [scene?.grid?.size, canvas?.grid?.size]) {
    const size = positive(candidate);
    if (size !== null) return size;
  }
  return DEFAULT_GRID_SIZE;
}

/**
 * Where the keeper is looking, in scene coordinates.
 *
 * `stage.pivot` is exactly that point and is what "centred in the current view"
 * means; the scene rectangle's middle is the fallback for a canvas that has not
 * drawn yet. Null when neither can be read, and null is not smoothed over: a
 * token placed at a guessed origin is a token off the edge of the keeper's screen,
 * which is the silent failure this whole file is written to avoid.
 */
export function viewCenter(canvas: CanvasLike | null | undefined): ScenePoint | null {
  const pivotX = finite(canvas?.stage?.pivot?.x);
  const pivotY = finite(canvas?.stage?.pivot?.y);
  if (pivotX !== null && pivotY !== null) return { x: pivotX, y: pivotY };

  const rect = canvas?.dimensions;
  const originX = finite(rect?.sceneX);
  const originY = finite(rect?.sceneY);
  const width = positive(rect?.sceneWidth);
  const height = positive(rect?.sceneHeight);
  if (originX !== null && originY !== null && width !== null && height !== null) {
    return { x: originX + width / 2, y: originY + height / 2 };
  }

  return null;
}

/**
 * How much map the prototype says this creature covers, in grid squares.
 *
 * One square for anything unreadable, which is Foundry's own schema default and
 * the right answer for the overwhelming majority of creatures.
 */
export function tokenFootprint(proto: Record<string, unknown>): TokenFootprint {
  return { width: positive(proto.width) ?? 1, height: positive(proto.height) ?? 1 };
}

/**
 * The token's top-left corner, such that the creature stands on the centre of the
 * view.
 *
 * Foundry positions a token by its top-left corner, so a two-by-two ogre has to be
 * offset by a full square rather than by half of one — which is the entire reason
 * the footprint is threaded down here.
 *
 * **Not snapped to the grid.** Foundry's own snapping moved between majors, and a
 * token half a square off the lines is a token the keeper nudges with the mouse
 * they already have on it; a token snapped by the wrong rule on a hex map is a
 * bug report. Where the creature finally stands was always going to be the
 * keeper's decision — this command is about getting it onto the screen.
 */
export function tokenPosition(center: ScenePoint, footprint: TokenFootprint, grid: number): ScenePoint {
  return {
    x: Math.round(center.x - (footprint.width * grid) / 2),
    y: Math.round(center.y - (footprint.height * grid) / 2),
  };
}

/**
 * The `createEmbeddedDocuments("Token", …)` argument, as a value.
 *
 * The prototype is the base and everything below it is an override, in this order
 * for a reason:
 *
 *  - **`_id` is dropped.** A prototype that carries one (some systems and modules
 *    write to it) would otherwise ask the scene to create a token at an id that is
 *    not free, and the whole call fails.
 *  - **`actorId` is written after the spread**, so a stale one on the prototype
 *    cannot win. Without it the token is a picture with no creature behind it.
 *  - **`texture.src` is overridden only when a picture was uploaded**, and only on
 *    this token — see decision 3 in the header. The rest of the texture block (the
 *    scale, the tint, the offsets the keeper set) is kept.
 *  - **The name is filled in only if the prototype has none**, from the actor and
 *    then from what MoT called it. A keeper who named the prototype "Guard
 *    Captain" gets a Guard Captain.
 *
 * Everything else is passed through untouched, wildcards included: a prototype set
 * to `randomImg` keeps the `*` in its texture path exactly as the keeper spelled
 * it, because picking one of somebody's variant pictures is Foundry's job and a
 * module that chose for them would be choosing their art.
 *
 * No origin flag, and that is the one omission here worth defending. The flag is
 * an *echo brake* (capture/loopGuard.ts): it stops a document this module wrote
 * from coming back as a captured event. Nothing in MoT reacts to `actor.appeared`,
 * so there is no echo to brake — and a stamped token would be dropped by
 * `buildTokenUpdate` too, which would silently mute this creature's hit points and
 * conditions in the session log for the rest of the night. A monster that walks
 * onto the map is a thing the table watched happen, exactly as it is when the
 * keeper drags it out of an encounter tray.
 */
export function placedTokenData(
  actor: PlaceableActor,
  proto: Record<string, unknown>,
  position: ScenePoint,
  path: string | null,
  fallbackName: string | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...proto };
  delete data._id;

  data.actorId = nonEmpty(actor.id);
  data.x = position.x;
  data.y = position.y;

  if (path !== null) {
    const texture = plainRecord(proto.texture) ?? {};
    data.texture = { ...texture, src: path };
  }

  if (nonEmpty(data.name) === null) {
    const name = nonEmpty(actor.name) ?? fallbackName;
    if (name !== null) data.name = name;
    else delete data.name;
  }

  return data;
}

// ------------------------------------------------------------- what to say

/** The reason on a notification, as a sentence the keeper can act on. */
export const REASON_NO_ACTOR = "that creature is not in this world.";
export const REASON_NO_SCENE = "there is no scene open on this screen to put it on.";
export const REASON_NO_VIEW = "this Foundry could not say where the view is looking.";
export const REASON_PLACE_FAILED = "Foundry refused the new token.";
export const REASON_UNEXPECTED = "something in this world refused the write.";

/** The notification voice: one sentence, the creature's name, and why. */
export function failureMessage(name: string, reason: string): string {
  return `Could not place "${name}" in Foundry: ${reason}`;
}

// ----------------------------------------------------- the GM-side handler

export interface ActorPlaceDeps {
  /**
   * The activation gate, read per command. Only the active GM places: two GM
   * clients acting on one press would put two tokens on the map, and the second
   * one would be standing exactly on top of the first.
   */
  isActive(): boolean;
  /** `game.actors.get`, called once per command. */
  lookupActor(actorId: string): PlaceableActor | null;
  /** `resolveCanvas(globalThis)`. Called per command, not cached — the scene changes. */
  canvas(): CanvasLike | null;
  /** Resolves FilePicker. Called per command, not cached. */
  files(): FilePickerApi | null;
  /** A Foundry ui notification, in the module's own voice. */
  notify(level: "info" | "warn" | "error", message: string): void;
  log?: CommandLog;
}

/**
 * The `actor.place` handler, as the dispatcher wires it.
 *
 * Returns synchronously — the dispatcher is synchronous, and a command carrying a
 * megabyte of picture must not hold up the next frame off the socket. Nothing here
 * ever throws into the dispatcher, and nothing here ever leaves an unhandled
 * rejection.
 */
export function createActorPlaceHandler(deps: ActorPlaceDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planActorPlace(payload);
    if (!plan) {
      // No actor id means nothing to place and nobody waiting on an answer.
      deps.log?.debug?.("[masteroftales-bridge] dropping an actor.place with no actorId in it");
      return;
    }

    void run(deps, plan).catch((error: unknown) => {
      deps.log?.warn?.("[masteroftales-bridge] could not place a token from Master of Tales", error);
      announce(deps, "error", failureMessage(plan.name ?? FALLBACK_PLACED_NAME, REASON_UNEXPECTED));
    });
  };
}

async function run(deps: ActorPlaceDeps, plan: ActorPlacePlan): Promise<void> {
  // The picture is refused before anything else is even looked up: a keeper who
  // picked a variant and got the default art instead would have to notice the
  // difference themselves. Loud, and nothing placed.
  if (plan.image.status === "refused") {
    deps.log?.warn?.(
      `[masteroftales-bridge] refusing a token image for "${plan.name ?? FALLBACK_PLACED_NAME}": ${plan.image.reason}`,
    );
    announce(deps, "error", failureMessage(plan.name ?? FALLBACK_PLACED_NAME, REASON_BAD_IMAGE));
    return;
  }

  const actor = lookup(deps, plan.actorId);
  if (!actor || nonEmpty(actor.id) === null) {
    deps.log?.warn?.(`[masteroftales-bridge] no actor ${plan.actorId} in this world; dropping actor.place`);
    announce(deps, "error", failureMessage(plan.name ?? FALLBACK_PLACED_NAME, REASON_NO_ACTOR));
    return;
  }

  // Foundry's own name wins for the message, for `resolveEntries`' reason: the
  // thing about to stand on the map is this world's actor, and a keeper who
  // renamed it renamed it for real.
  const name = nonEmpty(actor.name) ?? plan.name ?? FALLBACK_PLACED_NAME;

  const canvas = deps.canvas();
  const scene = placementScene(canvas);
  if (!scene) {
    deps.log?.warn?.("[masteroftales-bridge] no scene on this canvas; dropping actor.place");
    announce(deps, "error", failureMessage(name, REASON_NO_SCENE));
    return;
  }

  const center = viewCenter(canvas);
  if (!center) {
    deps.log?.warn?.("[masteroftales-bridge] could not read the view centre; dropping actor.place");
    announce(deps, "error", failureMessage(name, REASON_NO_VIEW));
    return;
  }

  // The picture last of the checks and first of the writes: nothing is uploaded
  // for a command that was going to fail anyway, and nothing is placed wearing
  // the wrong art.
  let path: string | null = null;
  if (plan.image.status === "ready") {
    const files = deps.files();
    if (!files) {
      deps.log?.warn?.("[masteroftales-bridge] no Foundry FilePicker available; dropping actor.place");
      announce(deps, "error", failureMessage(name, REASON_NO_FILE_API));
      return;
    }

    path = await uploadTokenImage(files, plan.image.image, deps.log);
    if (path === null) {
      announce(deps, "error", failureMessage(name, REASON_UPLOAD_FAILED));
      return;
    }
  }

  const proto = prototypeTokenData(actor);
  const position = tokenPosition(center, tokenFootprint(proto), gridSize(canvas, scene));
  const data = placedTokenData(actor, proto, position, path, plan.name);

  try {
    await scene.createEmbeddedDocuments?.("Token", [data]);
  } catch (error) {
    deps.log?.warn?.("[masteroftales-bridge] Foundry refused the new token", error);
    announce(deps, "error", failureMessage(name, REASON_PLACE_FAILED));
    return;
  }

  // Nothing is said on success and nothing goes home: the token appearing on the
  // map is the answer. See decision 4 in the header.
  deps.log?.debug?.(`[masteroftales-bridge] placed a token for actor ${plan.actorId} from Master of Tales`);
}

function lookup(deps: ActorPlaceDeps, actorId: string): PlaceableActor | null {
  try {
    return deps.lookupActor(actorId) ?? null;
  } catch (error) {
    // A collection that is not there yet, on a client still booting. A creature
    // that cannot be looked up is a creature this world does not have.
    deps.log?.debug?.("[masteroftales-bridge] could not look up an actor for actor.place", error);
    return null;
  }
}

/**
 * A notification that cannot itself become the failure.
 *
 * `ui.notifications` is a global on somebody else's client, and this is the path
 * that *reports* trouble — a toast that threw would turn a handled failure into an
 * unhandled rejection, which is the one thing the header promises does not happen.
 */
function announce(deps: ActorPlaceDeps, level: "info" | "warn" | "error", message: string): void {
  try {
    deps.notify(level, message);
  } catch (error) {
    deps.log?.debug?.("[masteroftales-bridge] could not show a notification", error);
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
