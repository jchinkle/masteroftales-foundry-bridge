import { stripHtml, truncate } from "../capture/html.js";
import { bridgeOriginFlags } from "../capture/loopGuard.js";
import type { ActorCreationBody } from "../protocol/actors.js";
import { actorCreationBody } from "../protocol/actors.js";
import type { CommandLog } from "./index.js";

/**
 * `actor.create` — a creature invented in Master of Tales is written into this
 * world as a real Foundry Actor, with its picture written into the world's own
 * data directory.
 *
 * **The file is copied, never linked, and that is the whole design.** MoT already
 * serves the picture over https, and pointing `actor.img` at that URL would have
 * been one line. It was rejected on purpose: an actor whose token art hotlinks to
 * masteroftales.com is an actor that shows a broken square the evening MoT is
 * down, the evening the keeper's internet is, and the day the keeper stops paying
 * for MoT — which is to say the art would belong to somebody else's uptime rather
 * than to the world it was made for. So the bytes travel down the socket once,
 * land in `masteroftales-tokens/` inside the world's data, and from that moment
 * the creature is an ordinary Foundry actor with an ordinary local token image.
 * Nothing about it needs this module, or MoT, ever again.
 *
 * Four decisions worth stating, because each is the sort of thing a later reader
 * would tidy into a bug:
 *
 *  1. **`key` is opaque and is echoed back verbatim.** MoT minted it to match the
 *     answer to the request; this module never parses it, never logs it, and never
 *     assumes it means anything. It is emphatically **not** a MoT record id — the
 *     bridge wire does not carry those, in either direction, ever, and the report
 *     that goes home carries only the key, Foundry's own actor id and Foundry's
 *     own name.
 *  2. **A name collision makes a new name, never an overwrite.** Foundry's own
 *     `FilePicker.upload` silently replaces a file of the same name, and a keeper
 *     who made two goblins a week apart should end up with two pictures rather
 *     than one goblin quietly wearing the other's face.
 *  3. **The extension comes from the bytes, not from the suggested filename.** A
 *     PNG named `goblin.jpg` is a file that lies to every tool that opens it, and
 *     the suggested basename is a suggestion off a wire.
 *  4. **A failure is a notification and no report.** The keeper is standing in
 *     MoT waiting for an answer; a create that could not happen has to say so on
 *     the screen they are looking at *and* leave MoT's side unresolved, rather
 *     than reporting an actor id for something that is not in the world.
 *
 * GM-side only, like every other inbound command: the bridge socket lives in one
 * browser (src/activation.ts), and so does the token the report rides on.
 *
 * Everything with a decision in it is pure and lives above the glue line — the
 * plan, the data-URL parse, the filename, the uniquing, the actor type and the
 * `Actor.create` argument are all *values*, so their shapes are unit tests rather
 * than something a customer discovers at a table.
 */

// ------------------------------------------------------------------ the wire

/** The picture, as MoT sends it. Null when the creature has no art yet. */
export interface ActorCreateImagePayload {
  /** A base64 `data:image/…` URL. Any image content type; never another scheme. */
  dataUrl?: unknown;
  /** A suggested basename. Sanitised here regardless of what arrives. */
  filename?: unknown;
}

/** The `actor.create` payload as MoT broadcasts it. */
export interface ActorCreatePayload {
  /**
   * An opaque correlation string. Echoed back verbatim in the report and used for
   * nothing else — not parsed, not logged, not interpreted.
   */
  key?: unknown;
  name?: unknown;
  image?: unknown;
}

// ------------------------------------------------------------------ the plan

/** A picture that survived validation, ready to become a File. */
export interface ActorImage {
  /** Lower-cased, always `image/…`. */
  mimeType: string;
  /** The payload half of the data URL, whitespace already stripped. */
  base64: string;
  /** A safe basename whose extension matches {@link ActorImage.mimeType}. */
  filename: string;
}

/**
 * What arrived in `image`, as three cases rather than a nullable.
 *
 * The third is the reason this is not simply `ActorImage | null`: "MoT sent no
 * picture" and "MoT sent a picture this module refuses to decode" are opposite
 * outcomes. The first creates an art-less actor and reports it; the second creates
 * nothing at all, because a keeper who chose a portrait and got a blank creature
 * back would have to notice the difference themselves.
 */
export type ActorImageResult =
  | { status: "none" }
  | { status: "ready"; image: ActorImage }
  | { status: "refused"; reason: string };

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

/**
 * The most data URL this module will decode: about 6MB of picture.
 *
 * Generous for a token — the ones MoT generates are a few hundred KB — and finite,
 * because the string arrives over a socket and is turned into a byte array in the
 * keeper's browser before anything else happens.
 */
export const MAX_DATA_URL_LENGTH = 8_000_000;

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

// -------------------------------------------------------------- the picture

/** A parsed `data:image/…;base64,…` URL. */
export interface ImageDataUrl {
  mimeType: string;
  base64: string;
}

/**
 * Reads `payload.image` into one of the three cases.
 *
 * Absent and `null` are the same thing and both mean "no art"; anything else is
 * held to the contract, because the two ends of this command ship from the same
 * design and a shape that disagrees with it is a bug worth surfacing rather than
 * a picture worth guessing at.
 */
export function readActorImage(value: unknown): ActorImageResult {
  if (value === null || value === undefined) return { status: "none" };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { status: "refused", reason: "image was not an object" };
  }

  const source = value as ActorCreateImagePayload;
  const parsed = parseImageDataUrl(source.dataUrl);
  if (!parsed) return { status: "refused", reason: "dataUrl was not a base64 image data URL" };

  return {
    status: "ready",
    image: {
      mimeType: parsed.mimeType,
      base64: parsed.base64,
      filename: safeFileName(source.filename, parsed.mimeType),
    },
  };
}

/**
 * `data:image/png;base64,iVBOR…` → its content type and its payload. Null for
 * anything else, and "anything else" is the point of the function.
 *
 * **Only `data:` URLs, and only `image/` ones, and only base64.** A `javascript:`
 * URL, an `https:` one, a `data:text/html` one and a percent-encoded (non-base64)
 * `data:` URL are all refused here rather than further down, because everything
 * below this line turns the string into bytes and then into a file inside the
 * keeper's own world directory. A scheme check at the door is the cheapest place
 * this decision can live.
 */
export function parseImageDataUrl(value: unknown): ImageDataUrl | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_DATA_URL_LENGTH) return null;

  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;

  const header = trimmed.slice(0, comma);
  // `data:` + an `image/<subtype>`, optional `;key=value` parameters, and a
  // trailing `;base64`. The trailing marker is required: a URL-encoded data URL
  // would decode to different bytes than `atob` produces from it.
  const match = /^data:(image\/[a-z0-9!#$&^_.+-]+)((?:;[a-z0-9!#$&^_.+-]+=[^;,]*)*);base64$/i.exec(header);
  if (!match) return null;

  const mimeType = (match[1] ?? "").toLowerCase();

  // Whitespace is legal inside a base64 payload and illegal inside `atob`'s
  // argument on some engines. Stripped rather than refused.
  const base64 = trimmed.slice(comma + 1).replace(/\s+/g, "");
  if (base64 === "" || base64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

  return { mimeType, base64 };
}

/**
 * The content types this module knows a file extension for. Anything else keeps
 * its subtype as the extension (see {@link extensionFor}) — the allow-list is a
 * spelling table, not a gate, and Foundry's own upload refuses what it will not
 * store.
 */
export const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** The extension of last resort, and the one MoT's own tokens arrive as. */
export const FALLBACK_EXTENSION = "png";

/** When the suggested basename sanitises away to nothing. */
export const FALLBACK_FILE_STEM = "token";

/** A basename is a label on a file, not a sentence. */
export const MAX_FILE_STEM_LENGTH = 60;

/** `image/jpeg` → `jpg`. Never empty, never a path separator, never a dot. */
export function extensionFor(mimeType: string): string {
  const known = EXTENSIONS[mimeType.toLowerCase()];
  if (known) return known;

  // `image/svg+xml` → `svg`; `image/x-tga` → `x-tga` minus the punctuation.
  const subtype = mimeType.toLowerCase().split("/")[1] ?? "";
  const cleaned = (subtype.split("+")[0] ?? "").replace(/[^a-z0-9]/g, "").slice(0, 8);
  return cleaned === "" ? FALLBACK_EXTENSION : cleaned;
}

/**
 * MoT's suggested basename, made safe to write into a directory.
 *
 * Directory components are stripped rather than escaped — a filename off a wire
 * has no business naming a path, and `../../worlds/…` must not be able to become
 * one. What survives is `[A-Za-z0-9._-]`, capped, never starting with a dot, and
 * **always carrying the extension the bytes actually are**: a PNG named
 * `goblin.jpg` is a file that lies to every tool that later opens it.
 */
export function safeFileName(value: unknown, mimeType: string): string {
  const raw = typeof value === "string" ? value : "";
  const base = raw.split(/[\\/]/).pop() ?? "";

  const stem = splitExtension(base)
    .stem.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, MAX_FILE_STEM_LENGTH)
    .replace(/[-.]+$/, "");

  return `${stem === "" ? FALLBACK_FILE_STEM : stem}.${extensionFor(mimeType)}`;
}

/** `goblin.png` → `{stem: "goblin", extension: ".png"}`. A dotfile is all stem. */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * A name nothing in `taken` already uses: `goblin.png`, then `goblin-1.png`, then
 * `goblin-2.png`.
 *
 * **Uniquing rather than overwriting**, because `FilePicker.upload` replaces a
 * file of the same name without asking and two creatures a week apart must not
 * end up sharing one picture. Compared case-insensitively, since the world data
 * directory may sit on a filesystem that thinks `Goblin.png` and `goblin.png` are
 * the same file — and on that filesystem the overwrite would be the *silent* kind.
 *
 * `taken` may be full paths; only the basenames are compared. The loop is bounded
 * by pigeonhole: with `n` names taken, one of the first `n + 1` candidates is free.
 */
export function uniqueFileName(desired: string, taken: readonly string[]): string {
  const used = new Set<string>();
  for (const entry of taken) {
    if (typeof entry !== "string") continue;
    const base = entry.split(/[\\/]/).pop()?.trim().toLowerCase();
    if (base) used.add(base);
  }

  if (!used.has(desired.toLowerCase())) return desired;

  const { stem, extension } = splitExtension(desired);
  for (let suffix = 1; suffix <= used.size + 1; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  // Unreachable: the loop above tries more names than the set can hold.
  return desired;
}

// ------------------------------------------------------------ the file write

/** Foundry's own word for the world's data directory. */
export const DATA_SOURCE = "data";

/**
 * The one directory this module writes into, ever.
 *
 * Module-owned and named after the module, so a keeper looking at their Data
 * folder can see exactly what arrived from Master of Tales and delete the lot in
 * one gesture if they ever want to. Nothing is written anywhere else — not into
 * `worlds/`, not next to the system's own art.
 */
export const TOKEN_DIRECTORY = "masteroftales-tokens";

/**
 * `FilePicker`, as this command uses it. `browse` and `createDirectory` are
 * optional because a Foundry that has one of them and not the others is a client
 * this module should still be able to upload from.
 */
export interface FilePickerApi {
  upload(
    source: string,
    path: string,
    file: unknown,
    body?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): unknown;
  browse?(source: string, target: string, options?: Record<string, unknown>): unknown;
  createDirectory?(source: string, target: string, options?: Record<string, unknown>): unknown;
}

/**
 * Picks FilePicker out of a global scope, namespaced spelling first.
 *
 * Same discipline, and the same reason, as `resolveJournalApi` and
 * `resolveCombatApi`: on v13 both spellings exist and the bare global is a
 * deprecated alias, so the namespace is asked first and the version question is
 * answered by *where the class was found* rather than by parsing `game.version`.
 *
 * v13/v14: `foundry.applications.apps.FilePicker`.
 */
export function resolveFilePicker(scope: unknown): FilePickerApi | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const apps = (global.foundry as { applications?: { apps?: Record<string, unknown> } } | undefined)?.applications
    ?.apps;

  for (const candidate of [apps?.FilePicker, global.FilePicker]) {
    if (typeof candidate !== "function") continue;
    if (typeof (candidate as unknown as Record<string, unknown>).upload === "function") {
      return candidate as unknown as FilePickerApi;
    }
  }

  return null;
}

/** The `File` constructor, as this command calls it. */
export type FileFactory = new (parts: unknown[], name: string, options?: Record<string, unknown>) => unknown;

/** base64 → bytes. Null when the string is not base64, or when `atob` is absent. */
export function decodeBase64(base64: string, scope: unknown = globalThis): Uint8Array | null {
  const decode = (scope as { atob?: unknown } | null)?.atob;
  if (typeof decode !== "function") return null;

  let binary: string;
  try {
    binary = (decode as (value: string) => string)(base64);
  } catch {
    // A payload `atob` refused. Reported as a refused image, never thrown.
    return null;
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return bytes;
}

/**
 * The picture as a `File`, which is what `FilePicker.upload` takes.
 *
 * The scope is an argument for `resolveFilePicker`'s reason: "does this client
 * have a File constructor" is the sort of thing a laptop can only answer by being
 * handed a scope that does not.
 */
export function buildTokenFile(image: ActorImage, scope: unknown = globalThis): unknown | null {
  const Factory = (scope as { File?: unknown } | null)?.File;
  if (typeof Factory !== "function") return null;

  const bytes = decodeBase64(image.base64, scope);
  if (!bytes) return null;

  try {
    return new (Factory as FileFactory)([bytes], image.filename, { type: image.mimeType });
  } catch {
    return null;
  }
}

/**
 * The files already in the token directory, and the directory itself if it was
 * not there.
 *
 * Never throws, and returns an empty list for every failure: the only thing this
 * list is used for is uniquing, and the *upload* is the step whose failure the
 * keeper hears about. A `browse` that throws is Foundry's own way of saying the
 * directory does not exist yet; a `createDirectory` that throws is almost always
 * "EEXIST", which is another client having made it a moment ago and is precisely
 * the case this must tolerate.
 */
export async function prepareTokenDirectory(api: FilePickerApi, log?: CommandLog): Promise<string[]> {
  const first = await listTokenFiles(api);
  if (first !== null) return first;

  if (typeof api.createDirectory === "function") {
    try {
      await api.createDirectory(DATA_SOURCE, TOKEN_DIRECTORY);
    } catch (error) {
      // Already there, or a data directory this client may not write to. The
      // upload below decides which, and it is the one that reports.
      log?.debug?.(`[masteroftales-bridge] could not create ${TOKEN_DIRECTORY}`, error);
    }
  }

  return (await listTokenFiles(api)) ?? [];
}

/** The directory's file list, or null when it could not be read at all. */
async function listTokenFiles(api: FilePickerApi): Promise<string[] | null> {
  if (typeof api.browse !== "function") return null;

  try {
    const listing = await api.browse(DATA_SOURCE, TOKEN_DIRECTORY);
    const files = (listing as { files?: unknown } | null)?.files;
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
  } catch {
    return null;
  }
}

/**
 * What `FilePicker.upload` said, as a path or as a failure.
 *
 * Foundry returns `{path, status: "success"}` and returns **`false`** rather than
 * throwing when the server refuses the file, which is the case this function
 * exists for. A truthy answer carrying no path at all is a Foundry this module
 * does not recognise; the composed path is used, because the upload neither threw
 * nor said no.
 */
export function uploadedPath(result: unknown, fallback: string): string | null {
  if (result === false || result === null || result === undefined) return null;
  if (typeof result !== "object") return fallback;

  const record = result as Record<string, unknown>;
  const status = record.status;
  if (typeof status === "string" && status.toLowerCase() === "error") return null;

  const path = nonEmpty(record.path);
  return path ?? fallback;
}

/** `masteroftales-tokens` + `goblin.png` → `masteroftales-tokens/goblin.png`. */
export function tokenPath(filename: string): string {
  return `${TOKEN_DIRECTORY}/${filename}`;
}

/**
 * Writes the picture into the world's data directory and answers with the path
 * the actor should point at. Null means the picture did not land, and the caller
 * then creates nothing at all.
 *
 * `notify: false` is passed to Foundry's own upload deliberately: this module
 * reports its own failures, in its own voice, once — and Foundry's default is a
 * second toast saying the same thing in a different one.
 */
export async function uploadTokenImage(
  api: FilePickerApi,
  image: ActorImage,
  log?: CommandLog,
): Promise<string | null> {
  const taken = await prepareTokenDirectory(api, log);
  const filename = uniqueFileName(image.filename, taken);

  const file = buildTokenFile({ ...image, filename });
  if (!file) {
    log?.warn?.("[masteroftales-bridge] could not decode the token image that arrived with actor.create");
    return null;
  }

  let result: unknown;
  try {
    result = await api.upload(DATA_SOURCE, TOKEN_DIRECTORY, file, {}, { notify: false });
  } catch (error) {
    log?.warn?.("[masteroftales-bridge] Foundry refused the token image upload", error);
    return null;
  }

  return uploadedPath(result, tokenPath(filename));
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
 * The origin flag is the same stamp every document this module writes carries; see
 * capture/loopGuard.ts.
 */
export function actorCreateData(name: string, type: string, path: string | null): Record<string, unknown> {
  const data: Record<string, unknown> = { name, type, flags: bridgeOriginFlags() };
  if (path !== null) {
    data.img = path;
    data.prototypeToken = { texture: { src: path } };
  }
  return data;
}

// ------------------------------------------------------------- what to say

/** The reason on a notification, as a sentence the keeper can act on. */
export const REASON_BAD_IMAGE = "the token image did not arrive as a readable image.";
export const REASON_NO_FILE_API = "this Foundry has no file picker available yet.";
export const REASON_UPLOAD_FAILED = "the token image could not be saved into this world's data folder.";
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
