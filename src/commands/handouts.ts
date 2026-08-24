import { escapeHtmlWithBreaks, stripHtml, truncate } from "../capture/html.js";
import { ORIGIN_MOT } from "../capture/loopGuard.js";
import { MODULE_ID } from "../protocol/version.js";
import type { ImageTargets } from "./images.js";
import { planTargets } from "./images.js";
import type { CommandLog } from "./index.js";

/**
 * `handout.show` — the keeper hands a page from Master of Tales to the table.
 *
 * **Why there is no every-client half here, and why that is not an oversight.**
 * `image.show` (commands/images.ts) is split across two machines because an
 * `ImagePopout` is a *window*, and a window is client-local: the GM's client has
 * to re-broadcast over Foundry's own module socket or the picture opens on the
 * GM's monitor and nowhere else. A handout is not a window. It is a
 * **JournalEntry**, and Foundry replicates documents to every client that has
 * permission to see them, for free. Foundry then ships the "put this on their
 * screens" half itself: `Journal.show(doc, {force, users})` takes an array of
 * user ids and pops the sheet open on exactly those clients.
 *
 * So the whole path runs on the active GM's client, and that is also the only
 * place it *could* run: the bridge API token is client-scoped and lives in the
 * keeper's browser alone (see settings.ts), and this command has to fetch the
 * page's content over that credential before it can write anything.
 *
 * The order matters and is the one sequencing decision in the file:
 *
 *  1. **Fetch** the player-safe markdown from MoT — a bridge GET, GM-side.
 *  2. **Write** the JournalEntry, filed in a "Master of Tales" folder, keyed to
 *     the MoT page by a flag so a second press *updates the same letter in
 *     place* rather than littering the journal directory with copies. The
 *     players keep it between sessions and can reopen it from their sidebar.
 *  3. **Grant** ownership to the targets, and *then* show. Ownership first is
 *     load-bearing: Foundry only replicates a JournalEntry to a client that has
 *     at least LIMITED permission on it, so a `show` that raced ahead of the
 *     ownership update would reach a client with no such document to open.
 *
 * Paper styling does not travel. A Foundry journal wears Foundry's look, and
 * pretending otherwise by shipping MoT's CSS into somebody else's world would be
 * a worse lie than the honest one.
 *
 * Everything with a decision in it is pure: the planners below build the exact
 * objects handed to Foundry as *values*, so the shapes are unit tests rather
 * than something a customer discovers at a table.
 */

// ------------------------------------------------------------------ the wire

/** The `handout.show` payload as MoT broadcasts it. */
export interface HandoutShowPayload {
  /** The MoT node id of the page. The fetch key, and the id-mapping key. */
  nodeId?: unknown;
  title?: unknown;
  /** `"all"`, or an array of Foundry user ids. */
  targets?: unknown;
}

/** Same normalisation as `image.show`: `"all"` or a non-empty list of user ids. */
export type HandoutTargets = ImageTargets;

export interface HandoutPlan {
  nodeId: string;
  /** Null when MoT sent nothing usable; the fetched title then names the entry. */
  title: string | null;
  targets: HandoutTargets;
}

/** A journal entry name, not a document. */
export const MAX_HANDOUT_NAME_LENGTH = 120;

/** MoT node ids are short handles. Anything longer is a payload bug. */
export const MAX_NODE_ID_LENGTH = 200;

/**
 * A hard cap on the letter itself. Generous — a handout is prose and a long one
 * is a legitimate three-page letter — but finite, because this string is written
 * into a world document that then replicates to every targeted client.
 */
export const MAX_HANDOUT_LENGTH = 200_000;

/** The journal folder every MoT handout is filed under. */
export const FOLDER_NAME = "Master of Tales";

/** Foundry types its folders by the document they hold. */
export const FOLDER_TYPE = "JournalEntry";

/** The `flags[MODULE_ID].role` stamp that finds our folder after a rename. */
export const FOLDER_ROLE = "handouts";

/** The only page type this module writes. */
export const PAGE_TYPE = "text";

/** When MoT sent no usable title and the server returned none either. */
export const FALLBACK_NAME = "Handout";

/**
 * Validates and normalises a `handout.show` payload. Null means "drop this
 * calmly" — no node id, or a `targets` naming nobody.
 */
export function planHandoutShow(payload: unknown): HandoutPlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as HandoutShowPayload;

  const nodeId = handoutNodeId(source.nodeId);
  if (nodeId === null) return null;

  // `planTargets` is imported rather than re-implemented, and its rule carries
  // over unchanged and on purpose: **a missing `targets` is null, not `"all"`.**
  // Defaulting a broadcast is the wrong direction to be wrong in — here even
  // more so than for a picture, because the wrong answer would grant every
  // player at the table permanent read access to a page the keeper never meant
  // to hand over.
  const targets = planTargets(source.targets);
  if (targets === null) return null;

  return { nodeId, title: handoutName(source.title), targets };
}

/**
 * The node id, or null.
 *
 * It goes into a URL path, so the refusals are about that: no control
 * characters, no whitespace, no separators. `encodeURIComponent` at the call
 * site is the second line of defence; this is the first, and it is what makes
 * `handoutPath` readable as "this cannot be anything but one path segment".
 */
function handoutNodeId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_NODE_ID_LENGTH) return null;
  // Control characters, whitespace and DEL, plus both slashes — the only
  // characters that could turn one path segment into two.
  if (/[\u0000-\u0020\u007f/\\]/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "..") return null;

  return trimmed;
}

/** Stripped of markup and capped. Foundry renders a document name as text. */
function handoutName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = truncate(stripHtml(value).trim(), MAX_HANDOUT_NAME_LENGTH);
  return name === "" ? null : name;
}

// ------------------------------------------------------------- the fetch body

/**
 * `GET /api/v1/bridge/handouts/<nodeId>` → `{title, markdown}`.
 *
 * The markdown is already player-safe when it arrives: MoT strips secrets
 * server-side, because the alternative is a module deciding what a player may
 * read, on the machine the player's GM is running. This end does not re-derive
 * that judgement; it renders what it was given.
 */
export interface HandoutContent {
  title: string | null;
  markdown: string;
}

/**
 * Reads the fetch body, or null when it was not the object we asked for.
 *
 * An **empty** markdown is accepted rather than refused: a page whose body the
 * keeper has not written yet is a real thing to hand over, and an empty letter
 * with a title on it is a truer report of the world than silence would be.
 */
export function readHandoutContent(body: unknown): HandoutContent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const source = body as { title?: unknown; markdown?: unknown };
  if (typeof source.markdown !== "string") return null;

  return {
    title: handoutName(source.title),
    markdown: truncate(source.markdown, MAX_HANDOUT_LENGTH),
  };
}

/**
 * What the entry is called. The server's title wins over the command's: both
 * describe the same page, and the fetch is the fresher of the two — a page
 * renamed between the press and the fetch should arrive under its new name.
 */
export function handoutTitle(plan: HandoutPlan, content: HandoutContent): string {
  return content.title ?? plan.title ?? FALLBACK_NAME;
}

// -------------------------------------------------------------- foundry glue

/** `CONST.JOURNAL_ENTRY_PAGE_FORMATS`. */
export interface PageFormats {
  HTML: number;
  MARKDOWN: number;
}

/** `CONST.DOCUMENT_OWNERSHIP_LEVELS`, the two levels this module ever writes. */
export interface OwnershipLevels {
  NONE: number;
  OBSERVER: number;
}

/**
 * The values Foundry has used since v9, and the fallback when `CONST` cannot be
 * read out of the scope at all. Stated rather than assumed, so that the day one
 * of them moves the failure is a diff in this file rather than a page that
 * renders as the wrong format on a customer's screen.
 */
export const DEFAULT_PAGE_FORMATS: PageFormats = { HTML: 1, MARKDOWN: 2 };
export const DEFAULT_OWNERSHIP_LEVELS: OwnershipLevels = { NONE: 0, OBSERVER: 2 };

/** A `JournalEntryPage` as this module touches it. */
export interface JournalPageLike {
  id?: string | null;
  type?: string | null;
  text?: { markdown?: string | null; content?: string | null; format?: number | null } | null;
  update(data: Record<string, unknown>): unknown;
}

/** A `JournalEntry` as this module touches it. */
export interface JournalEntryLike {
  id?: string | null;
  name?: string | null;
  flags?: Record<string, unknown> | null;
  pages?: unknown;
  update(data: Record<string, unknown>): unknown;
  createEmbeddedDocuments(embeddedName: string, data: Record<string, unknown>[]): unknown;
}

/** A `Folder` as this module touches it. */
export interface FolderLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  flags?: Record<string, unknown> | null;
}

/**
 * Showdown, as Foundry itself carries it. See `handoutPageData` for why this
 * module wants a converter at all.
 */
export interface MarkdownConverter {
  makeHtml(markdown: string): string;
}

/** The classes and constants this command needs out of a Foundry. */
export interface JournalApi {
  Journal: { show(doc: unknown, options: Record<string, unknown>): unknown };
  JournalEntry: { create(data: Record<string, unknown>): unknown };
  Folder: { create(data: Record<string, unknown>): unknown };
  formats: PageFormats;
  levels: OwnershipLevels;
  /** Null on a Foundry whose sheet classes moved; see `handoutPageData`. */
  converter: MarkdownConverter | null;
}

/**
 * Picks the journal classes out of a global scope, namespaced spelling first.
 *
 * Same discipline, and the same reason, as `resolveImagePopout`: on v13 both
 * spellings exist and the bare global is a deprecated alias, so the namespace is
 * asked first and the version question is answered by *where the class was
 * found* rather than by parsing `game.version`. Taking the scope as an argument
 * is what makes the one thing a laptop cannot verify — which spelling a real
 * v13 or v14 client has — a table of cases in a test rather than a guess.
 *
 * v13/v14 namespaces:
 *  - `foundry.documents.collections.Journal` — the collection class carrying the
 *    static `show(doc, {force, users})`.
 *  - `foundry.documents.JournalEntry` / `foundry.documents.Folder`.
 */
export function resolveJournalApi(scope: unknown): JournalApi | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const foundry = global.foundry as
    | { documents?: { collections?: Record<string, unknown> } & Record<string, unknown>; CONST?: unknown }
    | undefined;
  const documents = foundry?.documents;

  const Journal = withMethod<JournalApi["Journal"]>(
    [documents?.collections?.Journal, global.Journal],
    "show",
  );
  const JournalEntry = withMethod<JournalApi["JournalEntry"]>(
    [documents?.JournalEntry, global.JournalEntry],
    "create",
  );
  const Folder = withMethod<JournalApi["Folder"]>([documents?.Folder, global.Folder], "create");

  if (!Journal || !JournalEntry || !Folder) return null;

  const constants = (foundry?.CONST ?? global.CONST) as Record<string, unknown> | undefined;

  return {
    Journal,
    JournalEntry,
    Folder,
    formats: numbersOf(constants?.JOURNAL_ENTRY_PAGE_FORMATS, DEFAULT_PAGE_FORMATS),
    levels: numbersOf(constants?.DOCUMENT_OWNERSHIP_LEVELS, DEFAULT_OWNERSHIP_LEVELS),
    converter: resolveMarkdownConverter(scope),
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

/**
 * Foundry's own bi-directional HTML ⇄ Markdown converter, off whichever sheet
 * class this major keeps it on.
 *
 * It is a `_converter` static, which is to say protected-by-convention, and this
 * module reads it anyway with a null fallback rather than shipping a second
 * markdown implementation into somebody else's world. See `handoutPageData`.
 */
export function resolveMarkdownConverter(scope: unknown): MarkdownConverter | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const foundry = global.foundry as
    | {
        applications?: { sheets?: { journal?: Record<string, unknown> } };
        appv1?: { sheets?: Record<string, unknown> };
      }
    | undefined;
  const journalSheets = foundry?.applications?.sheets?.journal;
  const appv1 = foundry?.appv1?.sheets;

  const candidates = [
    journalSheets?.JournalEntryPageMarkdownSheet,
    journalSheets?.MarkdownJournalPageSheet,
    appv1?.MarkdownJournalPageSheet,
    appv1?.JournalTextPageSheet,
    global.MarkdownJournalPageSheet,
    global.JournalTextPageSheet,
  ];

  for (const candidate of candidates) {
    if (!candidate || (typeof candidate !== "function" && typeof candidate !== "object")) continue;
    let converter: unknown;
    try {
      converter = (candidate as unknown as Record<string, unknown>)._converter;
    } catch {
      // A getter that throws on a class Foundry has not finished setting up.
      continue;
    }
    if (converter && typeof (converter as MarkdownConverter).makeHtml === "function") {
      return converter as MarkdownConverter;
    }
  }

  return null;
}

// ------------------------------------------------------------- the data plans

/** The `flags` block on a handout entry — the id map *and* the loop guard, one stamp. */
export function handoutFlags(nodeId: string): Record<string, Record<string, string>> {
  // `origin: "mot"` is the same stamp capture/loopGuard.ts drops on sight, so
  // the entry this module writes cannot come back through the capture layer as
  // a thing that happened at the table. The nodeId beside it is what makes a
  // second press an update rather than a second letter.
  return { [MODULE_ID]: { origin: ORIGIN_MOT, nodeId } };
}

/** The `flags` block on the folder. Survives a keeper renaming it. */
export function folderFlags(): Record<string, Record<string, string>> {
  return { [MODULE_ID]: { origin: ORIGIN_MOT, role: FOLDER_ROLE } };
}

/**
 * Who may read the letter, as Foundry's ownership object.
 *
 * `"all"` → `{default: OBSERVER}`; a named list → `{default: NONE, <id>: OBSERVER}`,
 * with the payload's Foundry user ids used directly, because they *are* Foundry
 * user ids — MoT read them off this module's own roster (protocol/roster.ts).
 *
 * OBSERVER rather than LIMITED because LIMITED shows a player the entry's *name*
 * and nothing else, and rather than OWNER because a handout is a letter, not a
 * page the recipient may rewrite.
 *
 * Note what is deliberately absent: any revocation of a previous press's grants.
 * Foundry merges an `ownership` update, so a player who was handed this page
 * last session keeps it — which is the whole point of writing a document rather
 * than opening a window. Only `default` is rewritten each time.
 */
export function handoutOwnership(targets: HandoutTargets, levels: OwnershipLevels): Record<string, number> {
  if (targets === "all") return { default: levels.OBSERVER };

  const ownership: Record<string, number> = { default: levels.NONE };
  for (const id of targets) ownership[id] = levels.OBSERVER;
  return ownership;
}

/**
 * The page's data, as both `createEmbeddedDocuments` and `page.update` take it.
 *
 * **Both `text.markdown` and `text.content` are written, and that is on
 * purpose.** `format: MARKDOWN` with the source in `text.markdown` is the honest
 * description of what this is, and it is what a keeper opening the page in
 * Foundry's markdown editor sees. But Foundry's markdown support is an *editor*:
 * the sheet converts markdown to HTML when a human saves the page, and the view
 * renders `text.content`. A page written straight through the document API with
 * markdown alone has never been through that editor, and would show a reader an
 * empty sheet. So the HTML is filled in here, exactly as the editor would have.
 *
 * With no converter reachable the fallback is escaped text with line breaks: the
 * words, unstyled, with `**bold**` visible as itself. Ugly, and much better than
 * a blank letter — the failure mode this whole paragraph exists to prevent.
 */
export function handoutPageData(
  name: string,
  content: HandoutContent,
  api: Pick<JournalApi, "formats" | "converter">,
): Record<string, unknown> {
  return {
    name,
    type: PAGE_TYPE,
    text: {
      markdown: content.markdown,
      content: handoutHtml(content.markdown, api.converter),
      format: api.formats.MARKDOWN,
    },
  };
}

/** The rendered half of a page. Exported for the test that pins the fallback. */
export function handoutHtml(markdown: string, converter: MarkdownConverter | null): string {
  if (converter) {
    try {
      const html = converter.makeHtml(markdown);
      if (typeof html === "string") return html;
    } catch {
      // A converter that refused this input. Fall through to the plain rendering
      // rather than dropping the letter.
    }
  }
  return escapeHtmlWithBreaks(markdown);
}

/** The `JournalEntry.create` argument, pages and all. */
export function handoutEntryData(
  plan: HandoutPlan,
  name: string,
  content: HandoutContent,
  api: JournalApi,
  folderId: string | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name,
    flags: handoutFlags(plan.nodeId),
    ownership: handoutOwnership(plan.targets, api.levels),
    pages: [handoutPageData(name, content, api)],
  };
  if (folderId !== null) data.folder = folderId;
  return data;
}

/** The `entry.update` argument for a letter that already exists. */
export function handoutEntryUpdate(
  plan: HandoutPlan,
  name: string,
  api: JournalApi,
  folderId: string | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name,
    // Re-stamped rather than left alone: an entry a keeper dragged out of the
    // folder, or whose flags a migration flattened, is repaired by the next
    // press instead of silently becoming a second letter.
    flags: handoutFlags(plan.nodeId),
    ownership: handoutOwnership(plan.targets, api.levels),
  };
  if (folderId !== null) data.folder = folderId;
  return data;
}

/** The `Folder.create` argument. */
export function handoutFolderData(): Record<string, unknown> {
  return { name: FOLDER_NAME, type: FOLDER_TYPE, flags: folderFlags() };
}

/**
 * The `Journal.show` options.
 *
 * `users` is omitted for `"all"`, which is Foundry's own spelling of "every
 * connected client", and passed verbatim for a named list. `force: true` rides
 * along in both cases as the belt to ownership's braces: the grant written a
 * moment earlier is what makes the document *exist* on the player's client, and
 * force is what stops a client whose permissions have not caught up yet from
 * quietly declining to open it.
 */
export function handoutShowOptions(targets: HandoutTargets): Record<string, unknown> {
  if (targets === "all") return { force: true };
  return { force: true, users: [...targets] };
}

// ---------------------------------------------------------- finding what's there

/** Everything in a Foundry world collection this command reads. */
export interface JournalWorld {
  /** `game.journal`. */
  entries(): unknown;
  /** `game.folders`. */
  folders(): unknown;
}

/**
 * Foundry's collections are Map subclasses, so spreading one yields `[id, doc]`
 * pairs; `.contents` is the documented array accessor. Same shape as
 * capture/documents.ts's `collectionValues`, kept local because this file has no
 * other reason to reach into the capture layer.
 */
function values<T>(collection: unknown): T[] {
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
function moduleFlags(doc: { flags?: Record<string, unknown> | null } | null | undefined): Record<string, unknown> | null {
  const scoped = doc?.flags?.[MODULE_ID];
  return scoped && typeof scoped === "object" ? (scoped as Record<string, unknown>) : null;
}

/**
 * The handouts folder: our stamp first, then the name.
 *
 * Stamp first so that a keeper who renamed the folder to "Letters" keeps getting
 * their handouts filed in it; name second so that a folder made by hand — or by
 * an older module version, before the stamp existed — is adopted rather than
 * duplicated.
 */
export function findHandoutFolder(collection: unknown): FolderLike | null {
  const folders = values<FolderLike>(collection).filter((folder) => folder?.type === FOLDER_TYPE);

  const stamped = folders.find((folder) => moduleFlags(folder)?.role === FOLDER_ROLE);
  if (stamped) return stamped;

  return folders.find((folder) => folder?.name === FOLDER_NAME) ?? null;
}

/** The entry this MoT page was written to before, if any. */
export function findHandoutEntry(collection: unknown, nodeId: string): JournalEntryLike | null {
  return values<JournalEntryLike>(collection).find((entry) => moduleFlags(entry)?.nodeId === nodeId) ?? null;
}

/** The page this module wrote — the entry's first text page. */
export function findTextPage(entry: JournalEntryLike | null | undefined): JournalPageLike | null {
  const pages = values<JournalPageLike>(entry?.pages);
  return pages.find((page) => page?.type === PAGE_TYPE) ?? pages[0] ?? null;
}

// ----------------------------------------------------------------- the write

/** What `writeHandout` did, for the log line and for the tests. */
export type HandoutOutcome = "created" | "updated";

/**
 * Writes the letter and shows it. The only impure function in the file, and
 * every object it hands Foundry came from a pure builder above.
 */
export async function writeHandout(
  plan: HandoutPlan,
  content: HandoutContent,
  api: JournalApi,
  world: JournalWorld,
  log?: CommandLog,
): Promise<HandoutOutcome> {
  const name = handoutTitle(plan, content);

  let folder = findHandoutFolder(world.folders());
  if (!folder) {
    folder = ((await api.Folder.create(handoutFolderData())) as FolderLike | null) ?? null;
    if (!folder) log?.debug?.("[masteroftales-bridge] could not create the handouts folder; filing at the root");
  }
  const folderId = typeof folder?.id === "string" ? folder.id : null;

  const existing = findHandoutEntry(world.entries(), plan.nodeId);

  if (!existing) {
    const entry = (await api.JournalEntry.create(
      handoutEntryData(plan, name, content, api, folderId),
    )) as JournalEntryLike | null;
    if (!entry) throw new Error("Foundry created no journal entry");

    await api.Journal.show(entry, handoutShowOptions(plan.targets));
    return "created";
  }

  // Update in place: same document, same id, same sidebar position — the letter
  // the players already have simply says the new thing.
  await existing.update(handoutEntryUpdate(plan, name, api, folderId));

  const page = findTextPage(existing);
  if (page) await page.update(handoutPageData(name, content, api));
  else await existing.createEmbeddedDocuments("JournalEntryPage", [handoutPageData(name, content, api)]);

  await api.Journal.show(existing, handoutShowOptions(plan.targets));
  return "updated";
}

// ----------------------------------------------------- the GM-side handler

/** The bridge GET's outcome, as `main.ts` reports it. Never a thrown error. */
export interface HandoutResponse {
  status: number;
  body: unknown;
}

export interface HandoutShowDeps {
  /**
   * The activation gate, read per command. Only the active GM runs any of this —
   * and on any other client it could not run at all: the token is client-scoped.
   */
  isActive(): boolean;
  /** `GET /api/v1/bridge/handouts/<nodeId>`, with the bearer token. */
  fetch(nodeId: string): Promise<HandoutResponse>;
  /** Resolves the Foundry classes. Called per command, not cached. */
  api(): JournalApi | null;
  /** `game.journal` and `game.folders`, read per command. */
  world(): JournalWorld;
  log?: CommandLog;
}

/**
 * The `handout.show` handler, as the dispatcher wires it.
 *
 * Returns synchronously — the dispatcher is synchronous, and a command that
 * takes a network round trip must not hold up the next frame off the socket.
 * Nothing here ever throws into the dispatcher, and nothing here ever leaves an
 * unhandled rejection.
 */
export function createHandoutShowHandler(deps: HandoutShowDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planHandoutShow(payload);
    if (!plan) {
      deps.log?.debug?.("[masteroftales-bridge] dropping a handout.show with nothing showable in it", payload);
      return;
    }

    void run(deps, plan).catch((error: unknown) => {
      deps.log?.warn?.("[masteroftales-bridge] could not show a handout in Foundry", error);
    });
  };
}

async function run(deps: HandoutShowDeps, plan: HandoutPlan): Promise<void> {
  let response: HandoutResponse;
  try {
    response = await deps.fetch(plan.nodeId);
  } catch (error) {
    // The server was unreachable for the length of one press. A missing letter,
    // never a dialog: the keeper is looking at MoT, and MoT is the half of this
    // that can tell them the connection is down.
    deps.log?.warn?.("[masteroftales-bridge] could not fetch a handout from Master of Tales", error);
    return;
  }

  if (response.status === 404) {
    // The page's grant was revoked between the press and the fetch — or the
    // server predates this command entirely and has no such endpoint. Both are a
    // logged no-op by design.
    deps.log?.warn?.(
      `[masteroftales-bridge] Master of Tales has no shared handout ${plan.nodeId} (404); nothing was shown`,
    );
    return;
  }

  if (response.status !== 200) {
    deps.log?.warn?.(
      `[masteroftales-bridge] Master of Tales refused a handout fetch (HTTP ${response.status}); nothing was shown`,
    );
    return;
  }

  const content = readHandoutContent(response.body);
  if (!content) {
    deps.log?.warn?.("[masteroftales-bridge] a handout arrived with no markdown in it; nothing was shown");
    return;
  }

  const api = deps.api();
  if (!api) {
    deps.log?.warn?.("[masteroftales-bridge] no Foundry journal classes available; dropping handout.show");
    return;
  }

  const outcome = await writeHandout(plan, content, api, deps.world(), deps.log);
  deps.log?.debug?.(`[masteroftales-bridge] handout ${plan.nodeId} ${outcome} and shown`);
}
