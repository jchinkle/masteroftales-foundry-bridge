import { stripHtml, truncate } from "../capture/html.js";
import { ORIGIN_MOT } from "../capture/loopGuard.js";
import { MODULE_ID } from "../protocol/version.js";
import type { CommandLog } from "./index.js";
import type { FilePickerApi } from "./tokenImages.js";
import { DATA_SOURCE, extensionFor, uploadedPath } from "./tokenImages.js";

/**
 * `scene.upsert`: a map from Master of Tales becomes the surface this table
 * plays on.
 *
 * The largest command in the module, because it writes the most: a Scene, its
 * background copied into this world's own data directory, a square grid laid
 * over it, one Note per pin (with a journal entry behind each), the map's
 * lettering as text drawings and its roads and rivers as polylines.
 *
 * Three rules shape the whole file, and each is the sort of thing a later reader
 * would tidy into a bug:
 *
 *  1. **The picture is copied, never linked.** MoT serves it over https and
 *     pointing `background.src` at that URL would have been one line. The URL is
 *     signed and short-lived by design, a scene background pointed at it would
 *     be a black map before the session it was made for had ended, and a scene
 *     that hotlinks to masteroftales.com is a scene that breaks the evening MoT
 *     is down. Same decision, and the same paragraph, as commands/tokenImages.ts.
 *  2. **The filename is stable and overwritten**, which is the exact opposite of
 *     the uniquing `uploadTokenImage` does. Two goblins a week apart are two
 *     pictures; one map sent twice is one picture, and a trail of `barovia-1`,
 *     `barovia-2` up the keeper's Data folder is litter that never stops growing.
 *     The MoT map id is the name because it is the one string that is unique,
 *     stable, and not a title somebody may rename.
 *  3. **This module replaces what it owns and touches nothing else.** Every note
 *     and drawing it writes is stamped; a re-send deletes its *own* stamped
 *     documents and writes them again. A wall the GM drew, a light they placed, a
 *     token they parked and a note they pinned by hand all survive. Rebuild
 *     rather than diff, because the alternative is a three-way merge over
 *     documents in somebody else's world and the failure mode of a bad merge is a
 *     scene the keeper repairs mid-session.
 *
 * And one thing it deliberately does **not** do: activate the scene. Pulling the
 * whole table onto a new map because somebody pressed a button in a browser tab
 * is the most disruptive thing this bridge could do. The scene arrives in the
 * sidebar and waits for the gesture Foundry already has for it.
 */

// ------------------------------------------------------------------ the wire

/** The `scene.upsert` payload as MoT broadcasts it. */
export interface SceneUpsertPayload {
  mapId?: unknown;
  title?: unknown;
  width?: unknown;
  height?: unknown;
  grid?: unknown;
  notes?: unknown;
  texts?: unknown;
  drawings?: unknown;
}

/** The square the map is drawn on, when it has one. */
export interface GridPlan {
  size: number;
  /** Where the first intersection sits, in the map's own pixels. */
  originX: number;
  originY: number;
  /** What one square is worth, and in what, MoT's numbers, not assumed here. */
  distance: number;
  units: string;
}

/** One pin, on its way to being a Note with a journal entry behind it. */
export interface NotePlan {
  pinId: string;
  label: string;
  x: number;
  y: number;
  /** The pin's own words, or null. */
  text: string | null;
  /** The title of the page this pin opens in MoT, or null. */
  target: string | null;
  /** A keeper's pin: its entry is written so that only the GM may read it. */
  gmOnly: boolean;
}

/** One piece of map lettering, on its way to being a text drawing. */
export interface TextPlan {
  labelId: string;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string | null;
  rotation: number;
}

/** One polyline, on its way to being a drawing. */
export interface DrawingPlan {
  drawingId: string;
  name: string | null;
  kind: string | null;
  points: Array<{ x: number; y: number }>;
  color: string | null;
  width: number;
  opacity: number;
  /** Carried and stamped, never drawn, a DrawingDocument has no dash pattern. */
  dash: string | null;
}

export interface ScenePlan {
  mapId: string;
  title: string;
  width: number;
  height: number;
  grid: GridPlan | null;
  notes: NotePlan[];
  texts: TextPlan[];
  drawings: DrawingPlan[];
}

/** A scene name, not a document. */
export const MAX_SCENE_NAME_LENGTH = 120;

/** MoT ids are short handles. Anything longer is a payload bug. */
export const MAX_ID_LENGTH = 200;

/** A note's body is a paragraph, not a chapter. */
export const MAX_NOTE_TEXT_LENGTH = 20_000;

/**
 * The most of each kind one command may carry. A map with more than this is a
 * map whose author will not miss the tail, and an unbounded array off a wire is
 * a browser tab that stops responding at somebody's table.
 */
export const MAX_NOTES = 500;
export const MAX_TEXTS = 500;
export const MAX_DRAWINGS = 500;

/** The most vertices one polyline may carry, MoT's own ceiling, restated. */
export const MAX_POINTS = 500;

/** A scene has to be called something in a sidebar. */
export const FALLBACK_NAME = "Map";

/**
 * Validates and normalises a `scene.upsert` payload. Null means "drop this
 * calmly": no map id, or a canvas with no size to draw on.
 */
export function planSceneUpsert(payload: unknown): ScenePlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as SceneUpsertPayload;

  const mapId = safeId(source.mapId);
  if (mapId === null) return null;

  // A scene with no dimensions is not a scene. MoT refuses to send one, a map
  // with no background image is a 422 there, so this is the belt to that
  // braces rather than a case anybody should reach.
  const width = wholeNumber(source.width);
  const height = wholeNumber(source.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;

  return {
    mapId,
    title: sceneName(source.title) ?? FALLBACK_NAME,
    width,
    height,
    grid: planGrid(source.grid),
    notes: planList(source.notes, planNote, MAX_NOTES),
    texts: planList(source.texts, planText, MAX_TEXTS),
    drawings: planList(source.drawings, planDrawing, MAX_DRAWINGS),
  };
}

/**
 * The grid, or null.
 *
 * Null is the wire's own answer for a map with no square on it, MoT sends the
 * object or it sends nothing, never a half-filled one, and null is also what
 * every malformed grid becomes. A gridless scene is a working scene; a scene
 * with a grid built out of guesses is a scene where a token that should move one
 * square moves somewhere near one square.
 */
export function planGrid(value: unknown): GridPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const size = wholeNumber(source.size);
  const originX = wholeNumber(source.originX);
  const originY = wholeNumber(source.originY);
  if (size === null || size <= 0 || originX === null || originY === null) return null;

  const distance = finiteNumber(source.distance);
  const units = typeof source.units === "string" ? source.units.trim().slice(0, 32) : "";

  return {
    size,
    originX,
    originY,
    // Foundry needs a positive distance or the ruler measures in zeroes. Five is
    // MoT's own default and the fallback for a payload that forgot to say.
    distance: distance !== null && distance > 0 ? distance : 5,
    units: units === "" ? "ft" : units,
  };
}

function planNote(value: unknown): NotePlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const pinId = safeId(source.pinId);
  const x = finiteNumber(source.x);
  const y = finiteNumber(source.y);
  if (pinId === null || x === null || y === null) return null;

  return {
    pinId,
    label: plainText(source.label, MAX_SCENE_NAME_LENGTH) ?? FALLBACK_NOTE_LABEL,
    x,
    y,
    text: plainText(source.text, MAX_NOTE_TEXT_LENGTH),
    target: plainText(source.target, MAX_SCENE_NAME_LENGTH),
    // **Strictly `true`.** Anything else is a note the players may read, and the
    // direction to be wrong in is the one where a keeper's pin stays the
    // keeper's: a truthy `1` off some other sender must not decide this.
    gmOnly: source.gmOnly === true,
  };
}

/** What a pin with no label is called on the canvas. */
export const FALLBACK_NOTE_LABEL = "Pin";

function planText(value: unknown): TextPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const labelId = safeId(source.labelId);
  const text = plainText(source.text, MAX_SCENE_NAME_LENGTH);
  const x = finiteNumber(source.x);
  const y = finiteNumber(source.y);
  if (labelId === null || text === null || x === null || y === null) return null;

  const size = wholeNumber(source.size);
  const rotation = finiteNumber(source.rotation);

  return {
    labelId,
    text,
    x,
    y,
    size: size !== null && size > 0 ? size : DEFAULT_FONT_SIZE,
    color: hexColor(source.color),
    rotation: rotation === null ? 0 : rotation,
  };
}

function planDrawing(value: unknown): DrawingPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const drawingId = safeId(source.drawingId);
  const points = planPoints(source.points);
  if (drawingId === null || points === null) return null;

  const width = wholeNumber(source.width);
  const opacity = finiteNumber(source.opacity);

  return {
    drawingId,
    name: plainText(source.name, MAX_SCENE_NAME_LENGTH),
    kind: typeof source.kind === "string" ? source.kind.trim().slice(0, 32) || null : null,
    points,
    color: hexColor(source.color),
    width: width !== null && width > 0 ? width : DEFAULT_STROKE_WIDTH,
    opacity: opacity !== null && opacity > 0 && opacity <= 1 ? opacity : 1,
    dash: typeof source.dash === "string" ? source.dash.trim().slice(0, 32) || null : null,
  };
}

/** Two points or more, or null: one point is not a line. */
export function planPoints(value: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(value)) return null;

  const points: Array<{ x: number; y: number }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const x = finiteNumber((entry as Record<string, unknown>).x);
    const y = finiteNumber((entry as Record<string, unknown>).y);
    if (x === null || y === null) continue;
    points.push({ x, y });
    if (points.length >= MAX_POINTS) break;
  }

  return points.length >= 2 ? points : null;
}

function planList<T>(value: unknown, plan: (entry: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(value)) return [];

  const planned: T[] = [];
  for (const entry of value) {
    const one = plan(entry);
    if (one) planned.push(one);
    if (planned.length >= max) break;
  }
  return planned;
}

/**
 * An id off the wire, or null.
 *
 * The map id goes into a URL path and into a filename, so the refusals are about
 * both: no control characters, no whitespace, no separators, and never `.` or
 * `..`. `handoutNodeId`'s rule, and here it is load-bearing twice over,
 * `../../worlds/…` must not be able to name a file.
 */
export function safeId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_ID_LENGTH) return null;
  if (/[\u0000-\u0020\u007f/\\]/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "..") return null;

  return trimmed;
}

/** Stripped of markup and capped. Foundry renders these as text, so no escaping. */
function plainText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = truncate(stripHtml(value).trim(), max);
  return text === "" ? null : text;
}

function sceneName(value: unknown): string | null {
  return plainText(value, MAX_SCENE_NAME_LENGTH);
}

/** `#rrggbb` or `#rgb`, or null. Anything else is a colour Foundry would refuse. */
export function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function wholeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.round(number);
}

// ------------------------------------------------------------- the background

/** The one directory this command writes into, ever. */
export const SCENE_DIRECTORY = "masteroftales-scenes";

/** What the bridge's background door answered. Never a thrown error. */
export interface SceneBackgroundResponse {
  status: number;
  /** The bytes, or null when the body could not be read. */
  bytes: Uint8Array | null;
  /** The response's own content type, which is where the extension comes from. */
  contentType: string | null;
}

/**
 * `masteroftales-scenes/<mapId>.<ext>`.
 *
 * The extension comes from the **response's** content type rather than from
 * anything on the wire, for `safeFileName`'s reason said the other way round: a
 * PNG named `.jpg` is a file that lies to every tool that opens it, and the only
 * honest source for what these bytes are is the server that served them.
 */
export function scenePath(mapId: string, contentType: string | null): string {
  // Split on `;` because a served picture may carry a charset it does not need,
  // and the extension comes from the type alone.
  const type = (contentType ?? "").split(";")[0]?.trim() ?? "";
  return `${SCENE_DIRECTORY}/${mapId}.${extensionFor(type)}`;
}

/**
 * The bytes as a `File`, which is what `FilePicker.upload` takes.
 *
 * The scope is an argument for `resolveFilePicker`'s reason: "does this client
 * have a File constructor" is the sort of thing a laptop can only answer by
 * being handed a scope that does not.
 */
export function buildSceneFile(
  bytes: Uint8Array,
  filename: string,
  contentType: string | null,
  scope: unknown = globalThis,
): unknown | null {
  const Factory = (scope as { File?: unknown } | null)?.File;
  if (typeof Factory !== "function") return null;

  try {
    return new (Factory as new (parts: unknown[], name: string, options?: Record<string, unknown>) => unknown)(
      [bytes],
      filename,
      { type: contentType ?? "image/png" },
    );
  } catch {
    return null;
  }
}

/**
 * Writes the background into the world's data directory and answers with the
 * path the scene should point at. Null means the picture did not land, and the
 * caller then writes nothing at all, a scene with no background is the one
 * outcome worse than no scene.
 *
 * `createDirectory` failures are swallowed for `prepareTokenDirectory`'s reason:
 * "EEXIST" is another client having made it a moment ago, and the upload below
 * is the step whose failure the keeper hears about.
 */
export async function uploadBackground(
  api: FilePickerApi,
  mapId: string,
  background: { bytes: Uint8Array; contentType: string | null },
  scope: unknown = globalThis,
  log?: CommandLog,
): Promise<string | null> {
  if (typeof api.createDirectory === "function") {
    try {
      await api.createDirectory(DATA_SOURCE, SCENE_DIRECTORY);
    } catch (error) {
      log?.debug?.(`[masteroftales-bridge] could not create ${SCENE_DIRECTORY}`, error);
    }
  }

  const path = scenePath(mapId, background.contentType);
  const filename = path.slice(SCENE_DIRECTORY.length + 1);

  const file = buildSceneFile(background.bytes, filename, background.contentType, scope);
  if (!file) {
    log?.warn?.("[masteroftales-bridge] could not build a file out of the map background");
    return null;
  }

  let result: unknown;
  try {
    // `notify: false` for `uploadTokenImage`'s reason: this module reports its
    // own failures, in its own voice, once.
    result = await api.upload(DATA_SOURCE, SCENE_DIRECTORY, file, {}, { notify: false });
  } catch (error) {
    log?.warn?.("[masteroftales-bridge] Foundry refused the map background upload", error);
    return null;
  }

  return uploadedPath(result, path);
}

// -------------------------------------------------------------- foundry glue

/** `CONST.GRID_TYPES`, the two this module ever writes. */
export interface GridTypes {
  GRIDLESS: number;
  SQUARE: number;
}

/** `CONST.DOCUMENT_OWNERSHIP_LEVELS`, the two a pin's entry is ever written at. */
export interface OwnershipLevels {
  NONE: number;
  OBSERVER: number;
}

/**
 * The values Foundry has used since v10, and the fallback when `CONST` cannot be
 * read out of the scope at all. Stated rather than assumed, so the day one of
 * them moves the failure is a diff in this file rather than a scene that arrives
 * gridless on a customer's screen.
 */
export const DEFAULT_GRID_TYPES: GridTypes = { GRIDLESS: 0, SQUARE: 1 };
export const DEFAULT_OWNERSHIP_LEVELS: OwnershipLevels = { NONE: 0, OBSERVER: 2 };

/** How big a note's marker is drawn, in pixels. Foundry's own default. */
export const NOTE_ICON_SIZE = 40;

/** A text drawing's size when MoT sent none. */
export const DEFAULT_FONT_SIZE = 48;

/** A line's width when MoT sent none. */
export const DEFAULT_STROKE_WIDTH = 4;

/** What a line and a piece of lettering are inked in when nobody picked. */
export const DEFAULT_STROKE_COLOR = "#FFFFFF";
export const DEFAULT_TEXT_COLOR = "#FFFFFF";

/** Foundry's shape-type letters: a polygon, and a rectangle. */
export const SHAPE_POLYGON = "p";
export const SHAPE_RECTANGLE = "r";

/** A `Scene` as this module touches it. */
export interface SceneLike {
  id?: string | null;
  name?: string | null;
  flags?: Record<string, unknown> | null;
  notes?: unknown;
  drawings?: unknown;
  update(data: Record<string, unknown>): unknown;
  createEmbeddedDocuments(embeddedName: string, data: Record<string, unknown>[]): unknown;
  deleteEmbeddedDocuments(embeddedName: string, ids: string[]): unknown;
}

/** A `JournalEntry`, as the pin entries use it. */
export interface PinEntryLike {
  id?: string | null;
  name?: string | null;
  flags?: Record<string, unknown> | null;
  pages?: unknown;
  update(data: Record<string, unknown>): unknown;
  createEmbeddedDocuments(embeddedName: string, data: Record<string, unknown>[]): unknown;
}

/** A `Folder`, as this module reads one. */
export interface FolderLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  flags?: Record<string, unknown> | null;
}

/** The classes and constants this command needs out of a Foundry. */
export interface SceneApi {
  Scene: { create(data: Record<string, unknown>): unknown };
  JournalEntry: { create(data: Record<string, unknown>): unknown };
  Folder: { create(data: Record<string, unknown>): unknown };
  gridTypes: GridTypes;
  levels: OwnershipLevels;
  pageFormats: { MARKDOWN: number };
}

/**
 * Picks the classes out of a global scope, namespaced spelling first.
 *
 * Same discipline, and the same reason, as `resolveJournalApi` and
 * `resolveImagePopout`: on v13 both spellings exist and the bare global is a
 * deprecated alias, so the namespace is asked first and the version question is
 * answered by *where the class was found* rather than by parsing `game.version`.
 */
export function resolveSceneApi(scope: unknown): SceneApi | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const foundry = global.foundry as { documents?: Record<string, unknown>; CONST?: unknown } | undefined;
  const documents = foundry?.documents;

  const Scene = withMethod<SceneApi["Scene"]>([documents?.Scene, global.Scene], "create");
  const JournalEntry = withMethod<SceneApi["JournalEntry"]>(
    [documents?.JournalEntry, global.JournalEntry],
    "create",
  );
  const Folder = withMethod<SceneApi["Folder"]>([documents?.Folder, global.Folder], "create");

  if (!Scene || !JournalEntry || !Folder) return null;

  const constants = (foundry?.CONST ?? global.CONST) as Record<string, unknown> | undefined;

  return {
    Scene,
    JournalEntry,
    Folder,
    gridTypes: numbersOf(constants?.GRID_TYPES, DEFAULT_GRID_TYPES),
    levels: numbersOf(constants?.DOCUMENT_OWNERSHIP_LEVELS, DEFAULT_OWNERSHIP_LEVELS),
    pageFormats: numbersOf(constants?.JOURNAL_ENTRY_PAGE_FORMATS, { MARKDOWN: 2 }),
  };
}

/** The first candidate that is a constructor carrying the named static method. */
function withMethod<T>(candidates: unknown[], method: string): T | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "function") continue;
    if (typeof (candidate as unknown as Record<string, unknown>)[method] === "function") return candidate as T;
  }
  return null;
}

/** Reads the named numeric constants out of a `CONST` table, falling back per key. */
function numbersOf<T extends object>(table: unknown, fallback: T): T {
  if (!table || typeof table !== "object") return fallback;

  const source = table as Record<string, unknown>;
  const result: Record<string, unknown> = { ...(fallback as Record<string, unknown>) };
  for (const key of Object.keys(fallback)) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return result as T;
}

// ------------------------------------------------------------- the data plans

/** The `flags` block on the scene, the id map *and* the loop guard, one stamp. */
export function sceneFlags(mapId: string): Record<string, Record<string, string>> {
  return { [MODULE_ID]: { origin: ORIGIN_MOT, mapId } };
}

/** The stamp on one note, which is how a re-send knows the note is its own. */
export function noteFlags(mapId: string, pinId: string): Record<string, Record<string, string>> {
  return { [MODULE_ID]: { origin: ORIGIN_MOT, mapId, pinId } };
}

/** The stamp on one drawing, lettering and lines alike. */
export function drawingFlags(
  mapId: string,
  id: string,
  extra: Record<string, string> = {},
): Record<string, Record<string, string>> {
  return { [MODULE_ID]: { origin: ORIGIN_MOT, mapId, drawingId: id, ...extra } };
}

/** The stamp on one pin's journal entry. */
export function pinEntryFlags(mapId: string, pinId: string): Record<string, Record<string, string>> {
  return { [MODULE_ID]: { origin: ORIGIN_MOT, mapId, pinId } };
}

/**
 * How far to shift the picture so the drawn grid lands under the painted one.
 *
 * Foundry's grid is anchored to the scene rectangle's top-left corner and cannot
 * be moved; the background can. So a map whose first intersection sits at image
 * pixel `origin` is shifted back by `origin mod size`: the smallest shift that
 * aligns the two, and never more than one square.
 *
 * A negative origin (which MoT refuses, but a wire is a wire) shifts the other
 * way rather than producing a positive remainder, which is what `%` on a
 * negative number would give.
 */
export function gridOffset(origin: number, size: number): number {
  if (!Number.isFinite(origin) || !Number.isFinite(size) || size <= 0) return 0;

  const shift = Math.round(origin) % Math.round(size);
  // Spelled as a branch rather than a negation so that an aligned map gets a
  // plain `0` rather than JavaScript's `-0`, which is the same number and a
  // different thing to read in a document a customer may open.
  return shift === 0 ? 0 : -shift;
}

/**
 * The `Scene.create` argument, and the half of `scene.update` that describes the
 * canvas.
 *
 * `background.src` is a **local path** inside this world's data, never a URL:
 * see rule 1 in the header. The grid is square when MoT sent one and gridless
 * when it did not, because a scene with a guessed grid is a scene where a token
 * that should move one square moves somewhere near one square.
 */
export function sceneCanvasData(plan: ScenePlan, backgroundPath: string, api: SceneApi): Record<string, unknown> {
  const grid = plan.grid;

  return {
    name: plan.title,
    width: plan.width,
    height: plan.height,
    background: {
      src: backgroundPath,
      offsetX: grid ? gridOffset(grid.originX, grid.size) : 0,
      offsetY: grid ? gridOffset(grid.originY, grid.size) : 0,
    },
    grid: grid
      ? { type: api.gridTypes.SQUARE, size: grid.size, distance: grid.distance, units: grid.units }
      : { type: api.gridTypes.GRIDLESS, size: DEFAULT_GRIDLESS_SIZE },
    flags: sceneFlags(plan.mapId),
  };
}

/**
 * What `grid.size` says on a gridless scene.
 *
 * Foundry stores a size even when it draws no lines, it is what the ruler and
 * every distance measurement are built on, and it enforces a minimum of 50. A
 * gridless scene with a zero here is a scene Foundry refuses to create.
 */
export const DEFAULT_GRIDLESS_SIZE = 100;

/** The `Note` document for one pin. */
export function noteData(plan: ScenePlan, note: NotePlan, entryId: string): Record<string, unknown> {
  return {
    entryId,
    x: note.x,
    y: note.y,
    // The pin's own label, which is what a player reads under the marker
    // without opening anything.
    text: note.label,
    iconSize: NOTE_ICON_SIZE,
    // Visible whether or not the party has explored that corner. A note the
    // keeper chose to send is a note they meant the table to be able to find,
    // and fog is a decision about tokens rather than about labels.
    global: true,
    flags: noteFlags(plan.mapId, note.pinId),
  };
}

/**
 * Who may read a pin's journal entry, which is the whole of whether its Note is
 * visible on a player's canvas, because a Foundry Note's visibility *is* its
 * entry's permission.
 *
 * `{default: NONE}` for a keeper's pin, `{default: OBSERVER}` for everybody
 * else's: the same rank a handout is written at, and for its reason (LIMITED
 * would show a player the entry's name and nothing else).
 */
export function pinOwnership(gmOnly: boolean, levels: OwnershipLevels): Record<string, number> {
  return { default: gmOnly ? levels.NONE : levels.OBSERVER };
}

/**
 * The page inside a pin's journal entry: the pin's own words, and a line naming
 * the page it opens back in Master of Tales.
 *
 * The target is written as **its title** and not as a link, because a Foundry
 * player following a link would arrive at a login page for an app they have
 * never heard of (docs/features/foundry-bridge.md, "Handouts"). It is a
 * signpost, not a door.
 */
export function pinPageData(note: NotePlan, api: SceneApi): Record<string, unknown> {
  const lines: string[] = [];
  if (note.target) lines.push(`**${note.target}**`);
  if (note.text) lines.push(note.text);
  const markdown = lines.join("\n\n");

  return {
    name: note.label,
    type: "text",
    text: { markdown, content: markdownToPlainHtml(markdown), format: api.pageFormats.MARKDOWN },
  };
}

/**
 * The rendered half of a pin's page.
 *
 * Deliberately *not* Foundry's markdown converter, which `handouts.ts` reaches
 * for: a pin's body is one bold line and a paragraph, the conversion is four
 * characters of it, and borrowing a protected-by-convention static off a sheet
 * class is a cost worth paying for a three-page letter and not for this.
 */
export function markdownToPlainHtml(markdown: string): string {
  if (markdown === "") return "";

  return markdown
    .split("\n\n")
    .map((paragraph) => `<p>${escapeAndBold(paragraph)}</p>`)
    .join("");
}

function escapeAndBold(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
  return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** The `JournalEntry.create` argument for one pin. */
export function pinEntryData(
  plan: ScenePlan,
  note: NotePlan,
  api: SceneApi,
  folderId: string | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: note.label,
    flags: pinEntryFlags(plan.mapId, note.pinId),
    ownership: pinOwnership(note.gmOnly, api.levels),
    pages: [pinPageData(note, api)],
  };
  if (folderId !== null) data.folder = folderId;
  return data;
}

/** The `entry.update` argument for a pin whose entry already exists. */
export function pinEntryUpdate(
  plan: ScenePlan,
  note: NotePlan,
  api: SceneApi,
  folderId: string | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: note.label,
    // Re-stamped rather than left alone: an entry a keeper dragged out of the
    // folder, or whose flags a migration flattened, is repaired by the next
    // press instead of quietly becoming a second entry.
    flags: pinEntryFlags(plan.mapId, note.pinId),
    ownership: pinOwnership(note.gmOnly, api.levels),
  };
  if (folderId !== null) data.folder = folderId;
  return data;
}

/**
 * One piece of map lettering as a Foundry text drawing.
 *
 * A rectangle with no stroke and no fill, sized generously around the words:
 * Foundry needs a shape with real dimensions to hang text on, and a box a little
 * too big is invisible while a box too small clips the name.
 */
export function textDrawingData(plan: ScenePlan, text: TextPlan): Record<string, unknown> {
  const width = Math.max(Math.round(text.text.length * text.size * 0.62), text.size);
  const height = Math.round(text.size * 1.5);

  return {
    x: Math.round(text.x - width / 2),
    y: Math.round(text.y - height / 2),
    shape: { type: SHAPE_RECTANGLE, width, height },
    text: text.text,
    fontSize: text.size,
    textColor: text.color ?? DEFAULT_TEXT_COLOR,
    rotation: text.rotation,
    strokeWidth: 0,
    strokeAlpha: 0,
    fillType: 0,
    flags: drawingFlags(plan.mapId, text.labelId, { role: "label" }),
  };
}

/**
 * One MoT polyline as a Foundry drawing.
 *
 * Foundry's polygons are relative to the drawing's own `x`/`y`, so the bounding
 * box's top-left corner becomes the origin and every vertex is offset from it.
 * The vertices are a flat `[x0, y0, x1, y1, …]` list, which is Foundry's own
 * spelling and not this app's.
 *
 * `dash` is stamped into the flags and drawn nowhere: a DrawingDocument has no
 * dash pattern, so a dashed border and a dotted road both arrive solid. The word
 * survives so the intent is recoverable rather than lost at the wire.
 */
export function polylineDrawingData(plan: ScenePlan, drawing: DrawingPlan): Record<string, unknown> {
  const xs = drawing.points.map((point) => point.x);
  const ys = drawing.points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);

  const flat: number[] = [];
  for (const point of drawing.points) {
    flat.push(Math.round((point.x - left) * 100) / 100, Math.round((point.y - top) * 100) / 100);
  }

  const extra: Record<string, string> = { role: "line" };
  if (drawing.dash) extra.dash = drawing.dash;
  if (drawing.kind) extra.kind = drawing.kind;

  return {
    x: left,
    y: top,
    shape: {
      type: SHAPE_POLYGON,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top,
      points: flat,
    },
    strokeColor: drawing.color ?? DEFAULT_STROKE_COLOR,
    strokeWidth: drawing.width,
    strokeAlpha: drawing.opacity,
    fillType: 0,
    flags: drawingFlags(plan.mapId, drawing.drawingId, extra),
  };
}

// ---------------------------------------------------------- finding what's there

/** Everything in a Foundry world this command reads. */
export interface SceneWorld {
  /** `game.scenes`. */
  scenes(): unknown;
  /** `game.journal`. */
  entries(): unknown;
  /** `game.folders`. */
  folders(): unknown;
}

/**
 * Foundry's collections are Map subclasses, so spreading one yields `[id, doc]`
 * pairs; `.contents` is the documented array accessor. The same walk
 * commands/handouts.ts makes, and kept local for its reason.
 */
export function values<T>(collection: unknown): T[] {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection as T[];

  const contents = (collection as { contents?: unknown }).contents;
  if (Array.isArray(contents)) return contents as T[];

  const iterate = (collection as { values?: () => Iterable<unknown> }).values;
  if (typeof iterate === "function") {
    try {
      return [...iterate.call(collection)] as T[];
    } catch {
      return [];
    }
  }

  if (typeof (collection as Iterable<unknown>)[Symbol.iterator] === "function") {
    try {
      return [...(collection as Iterable<unknown>)] as T[];
    } catch {
      return [];
    }
  }

  return [];
}

/** This module's flag block on a document, if it wrote one. */
export function moduleFlags(
  doc: { flags?: Record<string, unknown> | null } | null | undefined,
): Record<string, unknown> | null {
  const scoped = doc?.flags?.[MODULE_ID];
  return scoped && typeof scoped === "object" ? (scoped as Record<string, unknown>) : null;
}

/** The scene this MoT map was written to before, if any. */
export function findScene(collection: unknown, mapId: string): SceneLike | null {
  return values<SceneLike>(collection).find((scene) => moduleFlags(scene)?.mapId === mapId) ?? null;
}

/** The journal entry this pin was written to before, if any. */
export function findPinEntry(collection: unknown, mapId: string, pinId: string): PinEntryLike | null {
  return (
    values<PinEntryLike>(collection).find((entry) => {
      const flags = moduleFlags(entry);
      return flags?.mapId === mapId && flags?.pinId === pinId;
    }) ?? null
  );
}

/** The journal folder MoT files things under, the handouts folder, shared. */
export const FOLDER_NAME = "Master of Tales";
export const FOLDER_TYPE = "JournalEntry";
export const FOLDER_ROLE = "handouts";

/**
 * The folder, stamp first and then the name.
 *
 * The same folder `handout.show` writes into, deliberately: a keeper looking for
 * "the things Master of Tales put in my world" should find one place rather than
 * three. Stamp first so a keeper who renamed it to "Letters" keeps getting their
 * pages filed there; name second so a folder made by hand is adopted rather than
 * duplicated.
 */
export function findFolder(collection: unknown): FolderLike | null {
  const folders = values<FolderLike>(collection).filter((folder) => folder?.type === FOLDER_TYPE);

  const stamped = folders.find((folder) => moduleFlags(folder)?.role === FOLDER_ROLE);
  if (stamped) return stamped;

  return folders.find((folder) => folder?.name === FOLDER_NAME) ?? null;
}

/** The `Folder.create` argument. */
export function folderData(): Record<string, unknown> {
  return {
    name: FOLDER_NAME,
    type: FOLDER_TYPE,
    flags: { [MODULE_ID]: { origin: ORIGIN_MOT, role: FOLDER_ROLE } },
  };
}

/**
 * The ids of the embedded documents **this module owns** on a scene.
 *
 * The whole of rule 3 lives in this one function: what is stamped is replaced,
 * and what is not stamped is a wall the GM drew, a light they placed or a note
 * they pinned by hand, and is never touched.
 */
export function ownedEmbeddedIds(collection: unknown, mapId: string): string[] {
  return values<{ id?: string | null; flags?: Record<string, unknown> | null }>(collection)
    .filter((doc) => {
      const flags = moduleFlags(doc);
      return flags?.origin === ORIGIN_MOT && flags?.mapId === mapId;
    })
    .map((doc) => doc.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}

// ----------------------------------------------------------------- the write

/** What `writeScene` did, for the notification and for the tests. */
export type SceneOutcome = "created" | "updated";

/**
 * Writes the scene, its pins' entries, its notes and its drawings.
 *
 * The only impure function in the file, and every object it hands Foundry came
 * from a pure builder above. Nothing here activates anything.
 */
export async function writeScene(
  plan: ScenePlan,
  backgroundPath: string,
  api: SceneApi,
  world: SceneWorld,
  log?: CommandLog,
): Promise<SceneOutcome> {
  const canvas = sceneCanvasData(plan, backgroundPath, api);

  const existing = findScene(world.scenes(), plan.mapId);

  let scene: SceneLike | null = existing;
  let outcome: SceneOutcome = "updated";

  if (!scene) {
    scene = ((await api.Scene.create(canvas)) as SceneLike | null) ?? null;
    if (!scene) throw new Error("Foundry created no scene");
    outcome = "created";
  } else {
    // Update in place: same document, same id, same sidebar position, same
    // folder the keeper dragged it to. The map they already have simply becomes
    // the map as it is now.
    await scene.update(canvas);
  }

  await replaceOwned(scene, plan, log);
  await writeNotes(scene, plan, api, world, log);
  await writeDrawings(scene, plan, log);

  return outcome;
}

/** Rule 3, executed: our own notes and drawings go, everything else stays. */
async function replaceOwned(scene: SceneLike, plan: ScenePlan, log?: CommandLog): Promise<void> {
  for (const [embeddedName, collection] of [
    ["Note", scene.notes],
    ["Drawing", scene.drawings],
  ] as const) {
    const ids = ownedEmbeddedIds(collection, plan.mapId);
    if (ids.length === 0) continue;

    try {
      await scene.deleteEmbeddedDocuments(embeddedName, ids);
    } catch (error) {
      // A delete Foundry refused leaves duplicates rather than losing the send.
      log?.warn?.(`[masteroftales-bridge] could not clear this map's ${embeddedName}s`, error);
    }
  }
}

async function writeNotes(
  scene: SceneLike,
  plan: ScenePlan,
  api: SceneApi,
  world: SceneWorld,
  log?: CommandLog,
): Promise<void> {
  if (plan.notes.length === 0) return;

  let folder = findFolder(world.folders());
  if (!folder) {
    folder = ((await api.Folder.create(folderData())) as FolderLike | null) ?? null;
    if (!folder) log?.debug?.("[masteroftales-bridge] could not create the Master of Tales folder");
  }
  const folderId = typeof folder?.id === "string" ? folder.id : null;

  const documents: Record<string, unknown>[] = [];

  for (const note of plan.notes) {
    const entryId = await upsertPinEntry(plan, note, api, world, folderId, log);
    // A note with no entry behind it is a marker a player cannot open, and
    // Foundry's own visibility rule has nothing to read. Skipped rather than
    // written empty.
    if (entryId === null) continue;

    documents.push(noteData(plan, note, entryId));
  }

  if (documents.length === 0) return;

  try {
    await scene.createEmbeddedDocuments("Note", documents);
  } catch (error) {
    log?.warn?.("[masteroftales-bridge] Foundry refused this map's notes", error);
  }
}

async function upsertPinEntry(
  plan: ScenePlan,
  note: NotePlan,
  api: SceneApi,
  world: SceneWorld,
  folderId: string | null,
  log?: CommandLog,
): Promise<string | null> {
  const existing = findPinEntry(world.entries(), plan.mapId, note.pinId);

  try {
    if (existing) {
      await existing.update(pinEntryUpdate(plan, note, api, folderId));

      const page = values<{ id?: string | null; update(data: Record<string, unknown>): unknown }>(
        existing.pages,
      )[0];
      if (page) await page.update(pinPageData(note, api));
      else await existing.createEmbeddedDocuments("JournalEntryPage", [pinPageData(note, api)]);

      return typeof existing.id === "string" ? existing.id : null;
    }

    const created = (await api.JournalEntry.create(
      pinEntryData(plan, note, api, folderId),
    )) as PinEntryLike | null;
    return typeof created?.id === "string" ? created.id : null;
  } catch (error) {
    log?.warn?.(`[masteroftales-bridge] could not write the page behind pin ${note.pinId}`, error);
    return null;
  }
}

async function writeDrawings(scene: SceneLike, plan: ScenePlan, log?: CommandLog): Promise<void> {
  const documents = [
    ...plan.drawings.map((drawing) => polylineDrawingData(plan, drawing)),
    ...plan.texts.map((text) => textDrawingData(plan, text)),
  ];
  if (documents.length === 0) return;

  try {
    await scene.createEmbeddedDocuments("Drawing", documents);
  } catch (error) {
    log?.warn?.("[masteroftales-bridge] Foundry refused this map's drawings", error);
  }
}

// ----------------------------------------------------- the GM-side handler

export interface SceneUpsertDeps {
  /**
   * The activation gate, read per command. Only the active GM runs any of this,
   * and on any other client it could not run at all: the bridge token is
   * client-scoped, and the background is fetched over it.
   */
  isActive(): boolean;
  /** `GET /api/v1/bridge/maps/<mapId>/background`, with the bearer token. */
  fetchBackground(mapId: string): Promise<SceneBackgroundResponse>;
  /** Resolves the Foundry document classes. Called per command, not cached. */
  api(): SceneApi | null;
  /** Resolves FilePicker. Called per command, not cached. */
  files(): FilePickerApi | null;
  /** `game.scenes`, `game.journal` and `game.folders`, read per command. */
  world(): SceneWorld;
  /**
   * Says so on the keeper's own screen. This command is the one that most needs
   * it: the keeper is standing in Master of Tales having pressed a button, and
   * whether a scene was *made* or *refreshed* is a fact only this side knows,
   * nothing acks an outbound command, so the `202` they already saw could not
   * carry it.
   */
  notify(level: "info" | "warn" | "error", message: string): void;
  log?: CommandLog;
}

/**
 * The `scene.upsert` handler, as the dispatcher wires it.
 *
 * Returns synchronously, the dispatcher is synchronous, and a command that
 * fetches a picture and writes a dozen documents must not hold up the next frame
 * off the socket. Nothing here ever throws into the dispatcher, and nothing here
 * ever leaves an unhandled rejection.
 */
export function createSceneUpsertHandler(deps: SceneUpsertDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planSceneUpsert(payload);
    if (!plan) {
      deps.log?.debug?.("[masteroftales-bridge] dropping a scene.upsert with nothing playable in it", payload);
      return;
    }

    void run(deps, plan).catch((error: unknown) => {
      deps.log?.warn?.("[masteroftales-bridge] could not write a scene from Master of Tales", error);
      deps.notify("error", `Could not build the scene "${plan.title}": something in this world refused the write.`);
    });
  };
}

async function run(deps: SceneUpsertDeps, plan: ScenePlan): Promise<void> {
  const api = deps.api();
  if (!api) {
    deps.log?.warn?.("[masteroftales-bridge] no Foundry scene classes available; dropping scene.upsert");
    return;
  }

  const files = deps.files();
  if (!files) {
    deps.notify("error", `Could not build the scene "${plan.title}": this Foundry has no file picker available yet.`);
    return;
  }

  let response: SceneBackgroundResponse;
  try {
    response = await deps.fetchBackground(plan.mapId);
  } catch (error) {
    // The server was unreachable for the length of one press. Said out loud
    // rather than logged, because the keeper is waiting for a map.
    deps.log?.warn?.("[masteroftales-bridge] could not fetch a map background from Master of Tales", error);
    deps.notify("warn", `Could not build the scene "${plan.title}": Master of Tales could not be reached.`);
    return;
  }

  if (response.status !== 200 || !response.bytes || response.bytes.length === 0) {
    deps.log?.warn?.(
      `[masteroftales-bridge] Master of Tales refused a map background (HTTP ${response.status}); nothing was built`,
    );
    deps.notify("warn", `Could not build the scene "${plan.title}": its background could not be fetched.`);
    return;
  }

  const backgroundPath = await uploadBackground(
    files,
    plan.mapId,
    { bytes: response.bytes, contentType: response.contentType },
    globalThis,
    deps.log,
  );
  if (!backgroundPath) {
    deps.notify(
      "error",
      `Could not build the scene "${plan.title}": its background could not be saved into this world's data folder.`,
    );
    return;
  }

  const outcome = await writeScene(plan, backgroundPath, api, deps.world(), deps.log);

  deps.log?.debug?.(`[masteroftales-bridge] scene ${plan.mapId} ${outcome}`);
  deps.notify(
    "info",
    outcome === "created"
      ? `Scene "${plan.title}" created from Master of Tales. Activate it when the party is ready.`
      : `Scene "${plan.title}" updated from Master of Tales.`,
  );
}
