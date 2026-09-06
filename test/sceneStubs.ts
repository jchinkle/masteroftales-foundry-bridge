import { ORIGIN_MOT } from "../src/capture/loopGuard.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { FakeCollection, FakeFolder, FakeJournalEntry } from "./stubs.js";

/**
 * `scene.upsert`'s world, and the two behaviours a naive fake would get wrong.
 *
 * **Embedded documents are collections, not arrays.** `scene.notes` and
 * `scene.drawings` are Map subclasses like every other Foundry collection, which
 * is exactly the trap `values()` in commands/scenes.ts exists to avoid.
 *
 * **`deleteEmbeddedDocuments` really deletes.** The whole of rule 3, this
 * module replaces what it owns and touches nothing else, is only evidence if a
 * second write over a world containing one of ours and one of the GM's leaves
 * the GM's alone. A stub that recorded the call without removing anything would
 * pass a test that proves nothing.
 *
 * Its own file rather than more of test/stubs.ts: the journal stubs there are
 * shared by three commands and this is one command's furniture.
 */

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}${(sequence += 1)}`;

/** The two kinds of embedded document this module ever writes. */
export type EmbeddedName = "Note" | "Drawing";

/** One bucket per embedded name, both always present. */
export type EmbeddedTable<T> = Record<EmbeddedName, T>;

/** Whether a string off a test is one of the two names this fake knows. */
function embeddedName(value: string): EmbeddedName {
  if (value !== "Note" && value !== "Drawing") throw new Error(`no such embedded document: ${value}`);
  return value;
}

export interface FakeEmbedded {
  id: string;
  flags: Record<string, unknown>;
  [key: string]: unknown;
}

/** A `Scene`, with the two embedded collections this module writes into. */
export class FakeScene {
  name: string | null = null;
  flags: Record<string, unknown> = {};

  /** Every `update`, exactly as it arrived. */
  readonly updates: Record<string, unknown>[] = [];
  /** Every `createEmbeddedDocuments` argument list, by embedded name. */
  readonly created: EmbeddedTable<Record<string, unknown>[]> = { Note: [], Drawing: [] };
  /** Every `deleteEmbeddedDocuments` id list, by embedded name. */
  readonly deleted: EmbeddedTable<string[]> = { Note: [], Drawing: [] };
  /** What is actually on the scene right now. */
  embedded: EmbeddedTable<FakeEmbedded[]> = { Note: [], Drawing: [] };

  /**
   * Whether anything ever activated this scene. Must stay false: pulling the
   * whole table onto a new map because somebody pressed a button in a browser
   * tab is the one thing this command promises never to do.
   */
  activated = false;

  constructor(
    readonly id: string,
    data: Record<string, unknown> = {},
  ) {
    this.apply(data);
  }

  get notes(): FakeCollection<FakeEmbedded> {
    return new FakeCollection(this.embedded.Note);
  }

  get drawings(): FakeCollection<FakeEmbedded> {
    return new FakeCollection(this.embedded.Drawing);
  }

  update(data: Record<string, unknown>): Promise<unknown> {
    this.updates.push(data);
    if (data.active === true) this.activated = true;
    this.apply(data);
    return Promise.resolve(this);
  }

  createEmbeddedDocuments(name: string, data: Record<string, unknown>[]): Promise<unknown> {
    const kind = embeddedName(name);

    this.created[kind].push(...data);
    const documents = data.map(
      (entry) => ({ ...entry, id: nextId(kind.toLowerCase()) }) as unknown as FakeEmbedded,
    );
    this.embedded[kind].push(...documents);
    return Promise.resolve(documents);
  }

  deleteEmbeddedDocuments(name: string, ids: string[]): Promise<unknown> {
    const kind = embeddedName(name);

    this.deleted[kind].push(...ids);
    this.embedded[kind] = this.embedded[kind].filter((doc) => !ids.includes(doc.id));
    return Promise.resolve(ids);
  }

  /** Something the GM put there, or a leftover from an earlier send. */
  addEmbedded(name: string, doc: { id: string; flags?: Record<string, unknown> }): void {
    this.embedded[embeddedName(name)].push({ flags: {}, ...doc } as FakeEmbedded);
  }

  private apply(data: Record<string, unknown>): void {
    if (typeof data.name === "string") this.name = data.name;
    // Merged, never replaced, Foundry's own update semantics.
    if (data.flags && typeof data.flags === "object") Object.assign(this.flags, data.flags);
  }
}

export interface FakeSceneWorldOptions {
  scenes?: FakeScene[];
  entries?: FakeJournalEntry[];
  folders?: FakeFolder[];
  /** Make `Scene.create` resolve to null, the way a refused create does. */
  createReturnsNull?: boolean;
}

export interface FakeSceneWorld {
  /** A v13/v14 scope: the classes live under `foundry.documents…`. */
  v13Scope: Record<string, unknown>;
  /** A v12-era scope: bare globals only. */
  legacyScope: Record<string, unknown>;
  /** `game.scenes`, `game.journal` and `game.folders`, as the handler reads them. */
  world: { scenes(): unknown; entries(): unknown; folders(): unknown };
  scenes: FakeCollection<FakeScene>;
  entries: FakeCollection<FakeJournalEntry>;
  folders: FakeCollection<FakeFolder>;
  createdScenes: Record<string, unknown>[];
  createdEntries: Record<string, unknown>[];
  createdFolders: Record<string, unknown>[];
  /**
   * Anything that reached the **deprecated bare globals** on the v13 scope. Must
   * stay empty: on v13 both spellings exist, and reaching for the global first
   * is the mistake this bucket is here to catch.
   */
  decoyed: string[];
}

export function createSceneWorld(options: FakeSceneWorldOptions = {}): FakeSceneWorld {
  const scenes = new FakeCollection<FakeScene>(options.scenes ?? []);
  const entries = new FakeCollection<FakeJournalEntry>(options.entries ?? []);
  const folders = new FakeCollection<FakeFolder>(options.folders ?? []);
  const createdScenes: Record<string, unknown>[] = [];
  const createdEntries: Record<string, unknown>[] = [];
  const createdFolders: Record<string, unknown>[] = [];
  const decoyed: string[] = [];

  function Scene(): void {
    /* never constructed */
  }
  Scene.create = (data: Record<string, unknown>): Promise<unknown> => {
    createdScenes.push(data);
    if (options.createReturnsNull) return Promise.resolve(null);
    const scene = new FakeScene(nextId("scene"), data);
    scenes.push(scene);
    return Promise.resolve(scene);
  };

  function JournalEntry(): void {
    /* never constructed */
  }
  JournalEntry.create = (data: Record<string, unknown>): Promise<unknown> => {
    createdEntries.push(data);
    const entry = new FakeJournalEntry(nextId("entry"), data);
    entries.push(entry);
    return Promise.resolve(entry);
  };

  function Folder(): void {
    /* never constructed */
  }
  Folder.create = (data: Record<string, unknown>): Promise<unknown> => {
    createdFolders.push(data);
    const folder = new FakeFolder(nextId("folder"), data);
    folders.push(folder);
    return Promise.resolve(folder);
  };

  const decoy = (name: string, method: string): Record<string, unknown> => {
    const stub = (): void => undefined;
    (stub as unknown as Record<string, unknown>)[method] = (): Promise<unknown> => {
      decoyed.push(name);
      return Promise.resolve(null);
    };
    return stub as unknown as Record<string, unknown>;
  };

  const CONST = {
    GRID_TYPES: { GRIDLESS: 0, SQUARE: 1, HEXODDR: 2 },
    DOCUMENT_OWNERSHIP_LEVELS: { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
    JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1, MARKDOWN: 2 },
  };

  return {
    scenes,
    entries,
    folders,
    createdScenes,
    createdEntries,
    createdFolders,
    decoyed,
    world: { scenes: () => scenes, entries: () => entries, folders: () => folders },
    v13Scope: {
      foundry: { documents: { Scene, JournalEntry, Folder }, CONST },
      // The deprecated aliases a real v13 also carries. Resolution must never
      // reach these.
      Scene: decoy("Scene", "create"),
      JournalEntry: decoy("JournalEntry", "create"),
      Folder: decoy("Folder", "create"),
      CONST,
    },
    legacyScope: { Scene, JournalEntry, Folder, CONST },
  };
}

/** A stamped scene, for the tests that start below the writer. */
export function stampedScene(id: string, mapId: string): FakeScene {
  return new FakeScene(id, { flags: { [MODULE_ID]: { origin: ORIGIN_MOT, mapId } } });
}
