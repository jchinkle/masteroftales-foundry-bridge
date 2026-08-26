import type { CommandLog } from "./index.js";

/**
 * The picture pipeline: a token image off the wire, validated, decoded, and
 * written into the world's own data directory.
 *
 * Two commands send one, and they send it in exactly the same shape:
 * `actor.create` (a creature invented in Master of Tales becomes a real Actor,
 * portrait and prototype token both pointing at the file) and `actor.place` (a
 * creature this world already has walks onto the map wearing a picked variant).
 * The rules below are the same for both, and they live here rather than in either
 * command precisely so that they cannot drift apart — a second copy of
 * `safeFileName` is a second answer to "may a filename off a wire name a path".
 *
 * **The file is copied, never linked, and that is the whole design.** MoT already
 * serves the picture over https, and pointing `texture.src` at that URL would have
 * been one line. It was rejected on purpose: art that hotlinks to
 * masteroftales.com is art that shows a broken square the evening MoT is down, the
 * evening the keeper's internet is, and the day the keeper stops paying for MoT —
 * which is to say it would belong to somebody else's uptime rather than to the
 * world it was made for. So the bytes travel down the socket once, land in
 * `masteroftales-tokens/` inside the world's data, and from that moment the
 * picture is an ordinary local file. Nothing about it needs this module, or MoT,
 * ever again.
 *
 * Three decisions worth stating, because each is the sort of thing a later reader
 * would tidy into a bug:
 *
 *  1. **A name collision makes a new name, never an overwrite.** Foundry's own
 *     `FilePicker.upload` silently replaces a file of the same name, and a keeper
 *     who made two goblins a week apart should end up with two pictures rather
 *     than one goblin quietly wearing the other's face.
 *  2. **The extension comes from the bytes, not from the suggested filename.** A
 *     PNG named `goblin.jpg` is a file that lies to every tool that opens it, and
 *     the suggested basename is a suggestion off a wire.
 *  3. **A refused picture refuses the whole command, loudly.** "MoT sent no
 *     picture" and "MoT sent a picture this module will not decode" are opposite
 *     outcomes: the first is a command that carries on, the second stops
 *     everything and says so on the screen the keeper is looking at. A keeper who
 *     chose a portrait and silently got the default art back would have to notice
 *     the difference themselves.
 */

// ------------------------------------------------------------------ the wire

/** The picture, as MoT sends it. Null when the creature has no art picked. */
export interface TokenImagePayload {
  /** A base64 `data:image/…` URL. Any image content type; never another scheme. */
  dataUrl?: unknown;
  /** A suggested basename. Sanitised here regardless of what arrives. */
  filename?: unknown;
}

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
 * The third is the reason this is not simply `ActorImage | null` — see decision 3
 * in the header.
 */
export type ActorImageResult =
  | { status: "none" }
  | { status: "ready"; image: ActorImage }
  | { status: "refused"; reason: string };

/**
 * The most data URL this module will decode: about 6MB of picture.
 *
 * Generous for a token — the ones MoT generates are a few hundred KB — and finite,
 * because the string arrives over a socket and is turned into a byte array in the
 * keeper's browser before anything else happens.
 */
export const MAX_DATA_URL_LENGTH = 8_000_000;

/**
 * Reads a payload's `image` field into one of the three cases.
 *
 * Absent and `null` are the same thing and both mean "no art"; anything else is
 * held to the contract, because the two ends of these commands ship from the same
 * design and a shape that disagrees with it is a bug worth surfacing rather than
 * a picture worth guessing at.
 */
export function readActorImage(value: unknown): ActorImageResult {
  if (value === null || value === undefined) return { status: "none" };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { status: "refused", reason: "image was not an object" };
  }

  const source = value as TokenImagePayload;
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

// -------------------------------------------------------------- the data URL

/** A parsed `data:image/…;base64,…` URL. */
export interface ImageDataUrl {
  mimeType: string;
  base64: string;
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

// --------------------------------------------------------------- the filename

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
 * `worlds/`, not next to the system's own art. Both commands that carry a picture
 * write here and nowhere else, which is what keeps that sentence true as the
 * protocol grows.
 */
export const TOKEN_DIRECTORY = "masteroftales-tokens";

/**
 * `FilePicker`, as these commands use it. `browse` and `createDirectory` are
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

/** The `File` constructor, as these commands call it. */
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
 * the document should point at. Null means the picture did not land, and the
 * caller then writes nothing at all.
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
    log?.warn?.("[masteroftales-bridge] could not decode a token image that arrived from Master of Tales");
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

// ------------------------------------------------------------- what to say

/**
 * The three failures of the picture path, as sentences a keeper can act on.
 *
 * Here rather than in either command because they describe *this* pipeline; the
 * verb in front of them ("Could not create…", "Could not place…") belongs to the
 * command and stays there.
 */
export const REASON_BAD_IMAGE = "the token image did not arrive as a readable image.";
export const REASON_NO_FILE_API = "this Foundry has no file picker available yet.";
export const REASON_UPLOAD_FAILED = "the token image could not be saved into this world's data folder.";

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
