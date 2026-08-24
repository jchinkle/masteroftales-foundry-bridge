import { describe, expect, it } from "vitest";
import type { HandoutContent, HandoutPlan, HandoutResponse, JournalApi } from "../src/commands/handouts.js";
import {
  createHandoutShowHandler,
  FALLBACK_NAME,
  findHandoutEntry,
  findHandoutFolder,
  findTextPage,
  FOLDER_NAME,
  FOLDER_TYPE,
  handoutEntryData,
  handoutFlags,
  handoutFolderData,
  handoutHtml,
  handoutOwnership,
  handoutPageData,
  handoutShowOptions,
  handoutTitle,
  MAX_HANDOUT_NAME_LENGTH,
  planHandoutShow,
  readHandoutContent,
  resolveJournalApi,
  resolveMarkdownConverter,
  writeHandout,
} from "../src/commands/handouts.js";
import { createDispatcher } from "../src/commands/index.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { handoutPath } from "../src/settings.js";
import type { FakeJournal, FakeJournalOptions } from "./stubs.js";
import {
  createJournal,
  createLog,
  FakeFolder,
  FakeJournalEntry,
  flushMicrotasks,
} from "./stubs.js";

/** A `handout.show` payload as MoT broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { nodeId: "node-42", title: "The Burgomaster's letter", targets: "all", ...overrides };
}

function plan(overrides: Partial<HandoutPlan> = {}): HandoutPlan {
  return { nodeId: "node-42", title: "The Burgomaster's letter", targets: "all", ...overrides };
}

function content(overrides: Partial<HandoutContent> = {}): HandoutContent {
  return { title: "The Burgomaster's letter", markdown: "My **dear** friend,", ...overrides };
}

/** The API as the handler resolves it, from a stub scope. */
function apiOf(journal: FakeJournal): JournalApi {
  const api = resolveJournalApi(journal.v13Scope);
  if (!api) throw new Error("the stub scope did not resolve");
  return api;
}

// --------------------------------------------------------------------- plan

describe("planHandoutShow", () => {
  it("normalises the ordinary case", () => {
    expect(planHandoutShow(payload())).toEqual({
      nodeId: "node-42",
      title: "The Burgomaster's letter",
      targets: "all",
    });
  });

  it("keeps a target list, deduped and trimmed", () => {
    expect(planHandoutShow(payload({ targets: [" p1 ", "p2", "p1", "", 7] }))?.targets).toEqual(["p1", "p2"]);
  });

  it("drops a payload with no usable node id", () => {
    for (const nodeId of [undefined, null, "", "   ", 7, {}]) {
      expect(planHandoutShow(payload({ nodeId }))).toBeNull();
    }
  });

  it("refuses a node id that is not one path segment", () => {
    // It is interpolated into a URL path. `encodeURIComponent` is the second
    // line of defence; this is the first.
    for (const nodeId of ["a/b", "..\\..\\etc", "node 42", "node\n42", ".", ".."]) {
      expect(planHandoutShow(payload({ nodeId }))).toBeNull();
    }
    // …while the shapes MoT actually mints all survive.
    for (const nodeId of ["42", "node-42", "01J9X2K.CD_3", "Page:42"]) {
      expect(planHandoutShow(payload({ nodeId }))?.nodeId).toBe(nodeId);
    }
  });

  it("drops a payload that targets nobody, rather than defaulting to everybody", () => {
    // Worse here than for a picture: the wrong answer grants the whole table
    // permanent read access to a page the keeper never handed over.
    expect(planHandoutShow(payload({ targets: [] }))).toBeNull();
    expect(planHandoutShow(payload({ targets: undefined }))).toBeNull();
    expect(planHandoutShow(payload({ targets: "everyone" }))).toBeNull();
  });

  it("strips markup out of a title and caps it, and survives having none", () => {
    expect(planHandoutShow(payload({ title: "<b>A letter</b>" }))?.title).toBe("A letter");
    expect(planHandoutShow(payload({ title: "T".repeat(400) }))?.title?.length).toBe(MAX_HANDOUT_NAME_LENGTH);
    expect(planHandoutShow(payload({ title: "  " }))?.title).toBeNull();
    expect(planHandoutShow(payload({ title: 12 }))?.title).toBeNull();
  });

  it("drops anything that is not an object", () => {
    for (const bad of [null, undefined, "handout", 7, [], [payload()]]) {
      expect(planHandoutShow(bad)).toBeNull();
    }
  });
});

describe("readHandoutContent", () => {
  it("reads the fetched body", () => {
    expect(readHandoutContent({ title: "A letter", markdown: "# Hello" })).toEqual({
      title: "A letter",
      markdown: "# Hello",
    });
  });

  it("accepts an empty letter — a page whose body is not written yet is still a page", () => {
    expect(readHandoutContent({ title: "A letter", markdown: "" })?.markdown).toBe("");
  });

  it("refuses a body with no markdown in it at all", () => {
    for (const bad of [null, undefined, "text", 7, [], {}, { markdown: 12 }]) {
      expect(readHandoutContent(bad)).toBeNull();
    }
  });
});

describe("handoutTitle", () => {
  it("prefers the server's title — it is the fresher of the two", () => {
    expect(handoutTitle(plan({ title: "Stale" }), content({ title: "Fresh" }))).toBe("Fresh");
  });

  it("falls back to the command's title, and then to a name at all", () => {
    expect(handoutTitle(plan({ title: "From the command" }), content({ title: null }))).toBe("From the command");
    expect(handoutTitle(plan({ title: null }), content({ title: null }))).toBe(FALLBACK_NAME);
  });
});

describe("handoutPath", () => {
  it("names one handout by node id", () => {
    expect(handoutPath("node-42")).toBe("/api/v1/bridge/handouts/node-42");
    expect(handoutPath("a b/c")).toBe("/api/v1/bridge/handouts/a%20b%2Fc");
  });
});

// ------------------------------------------------------------ version glue

describe("resolveJournalApi", () => {
  it("prefers the v13+ namespaces over the deprecated bare globals", async () => {
    const journal = createJournal();
    const api = apiOf(journal);

    await writeHandout(plan(), content(), api, journal.world);

    // The bare globals on that scope are decoys. Reaching one would mean the
    // module found the deprecated alias first — the exact mistake
    // resolveImagePopout's ordering exists to prevent, on new classes.
    expect(journal.decoyed).toEqual([]);
    expect(journal.shown).toHaveLength(1);
  });

  it("falls back to bare globals on a scope that has only those", async () => {
    const journal = createJournal();
    const api = resolveJournalApi(journal.legacyScope);
    expect(api).not.toBeNull();

    await writeHandout(plan(), content(), api!, journal.world);
    expect(journal.createdEntries).toHaveLength(1);
  });

  it("is null in anything that is not a Foundry", () => {
    expect(resolveJournalApi({})).toBeNull();
    expect(resolveJournalApi(null)).toBeNull();
    expect(resolveJournalApi({ Journal: "nope", JournalEntry: "nope", Folder: "nope" })).toBeNull();
    // A Journal with no `show` on it is not the class we are looking for.
    expect(resolveJournalApi({ Journal: () => undefined, JournalEntry: () => undefined, Folder: () => undefined })).toBeNull();
  });

  it("reads the format and ownership constants out of CONST, and stands its ground without them", () => {
    const journal = createJournal();
    expect(apiOf(journal).formats.MARKDOWN).toBe(2);
    expect(apiOf(journal).levels.OBSERVER).toBe(2);

    const noConst = resolveJournalApi({ ...journal.legacyScope, CONST: undefined });
    expect(noConst?.formats).toEqual({ HTML: 1, MARKDOWN: 2 });
    expect(noConst?.levels).toEqual({ NONE: 0, OBSERVER: 2 });
  });
});

describe("resolveMarkdownConverter", () => {
  it("finds Foundry's own converter off the markdown sheet", () => {
    expect(resolveMarkdownConverter(createJournal().v13Scope)?.makeHtml("**a**")).toContain("<strong>a</strong>");
    expect(resolveMarkdownConverter(createJournal().legacyScope)).not.toBeNull();
  });

  it("is null when the sheet classes moved", () => {
    expect(resolveMarkdownConverter(createJournal({ converter: false }).v13Scope)).toBeNull();
    expect(resolveMarkdownConverter({})).toBeNull();
    expect(resolveMarkdownConverter(null)).toBeNull();
  });
});

// --------------------------------------------------------------- the plans

describe("handoutOwnership", () => {
  const levels = { NONE: 0, OBSERVER: 2 };

  it("gives the whole table observer on `all`", () => {
    expect(handoutOwnership("all", levels)).toEqual({ default: 2 });
  });

  it("names exactly the targeted users, and nobody else by default", () => {
    expect(handoutOwnership(["p1", "p2"], levels)).toEqual({ default: 0, p1: 2, p2: 2 });
  });
});

describe("handoutPageData", () => {
  it("writes the markdown source AND the rendered HTML, in markdown format", () => {
    // Both halves, deliberately: `format: MARKDOWN` with the source is what this
    // page *is*, and the HTML is what a reader is actually shown — Foundry's
    // markdown support is an editor, and a page written straight through the
    // document API has never been through it.
    const api = apiOf(createJournal());
    expect(handoutPageData("A letter", content(), api)).toEqual({
      name: "A letter",
      type: "text",
      text: {
        markdown: "My **dear** friend,",
        content: "<p>My <strong>dear</strong> friend,</p>",
        format: 2,
      },
    });
  });

  it("falls back to escaped text when no converter is reachable — the words, unstyled", () => {
    const api = apiOf(createJournal({ converter: false }));
    const data = handoutPageData("A letter", content({ markdown: "line one\nline <two>" }), api);
    expect((data.text as { content: string }).content).toBe("line one<br>line &lt;two&gt;");
  });

  it("keeps the letter rather than dropping it when the converter throws", () => {
    expect(
      handoutHtml("**a**", {
        makeHtml: () => {
          throw new Error("showdown said no");
        },
      }),
    ).toBe("**a**");
  });
});

describe("handoutShowOptions", () => {
  it("names no users for `all` — Foundry's own spelling of every connected client", () => {
    expect(handoutShowOptions("all")).toEqual({ force: true });
  });

  it("passes the Foundry user ids straight through for a named list", () => {
    expect(handoutShowOptions(["p1", "p2"])).toEqual({ force: true, users: ["p1", "p2"] });
  });
});

describe("handoutFlags", () => {
  it("is the id map and the loop guard in one stamp", () => {
    expect(handoutFlags("node-42")).toEqual({ [MODULE_ID]: { origin: "mot", nodeId: "node-42" } });
  });
});

// -------------------------------------------------------------- the folder

describe("findHandoutFolder", () => {
  const stamped = (id: string, name: string): FakeFolder =>
    new FakeFolder(id, { name, type: FOLDER_TYPE, flags: { [MODULE_ID]: { origin: "mot", role: "handouts" } } });

  it("finds its own folder by the stamp, even after the keeper renamed it", () => {
    const folder = stamped("f1", "Letters from Barovia");
    expect(findHandoutFolder([folder])?.id).toBe("f1");
  });

  it("adopts a folder made by hand under the right name", () => {
    const byHand = new FakeFolder("f2", { name: FOLDER_NAME, type: FOLDER_TYPE });
    expect(findHandoutFolder([byHand])?.id).toBe("f2");
  });

  it("ignores a same-named folder of another document type", () => {
    const scenes = new FakeFolder("f3", { name: FOLDER_NAME, type: "Scene" });
    expect(findHandoutFolder([scenes])).toBeNull();
  });

  it("is null in an empty world", () => {
    expect(findHandoutFolder([])).toBeNull();
    expect(findHandoutFolder(null)).toBeNull();
  });
});

describe("findHandoutEntry", () => {
  it("finds the letter written for this MoT page and no other", () => {
    const mine = new FakeJournalEntry("e1", { flags: handoutFlags("node-42") });
    const theirs = new FakeJournalEntry("e2", { flags: handoutFlags("node-9") });
    const handWritten = new FakeJournalEntry("e3", { name: "Session notes" });

    expect(findHandoutEntry([theirs, mine, handWritten], "node-42")?.id).toBe("e1");
    expect(findHandoutEntry([theirs, handWritten], "node-42")).toBeNull();
  });
});

// --------------------------------------------------------------- the write

describe("writeHandout — the first press", () => {
  async function press(options: FakeJournalOptions = {}, override: Partial<HandoutPlan> = {}) {
    const journal = createJournal(options);
    const outcome = await writeHandout(plan(override), content(), apiOf(journal), journal.world);
    return { journal, outcome };
  }

  it("creates the folder, the entry and its page, and shows it", async () => {
    const { journal, outcome } = await press();

    expect(outcome).toBe("created");
    expect(journal.createdFolders).toEqual([handoutFolderData()]);

    const created = journal.createdEntries[0]!;
    expect(created.name).toBe("The Burgomaster's letter");
    expect(created.flags).toEqual({ [MODULE_ID]: { origin: "mot", nodeId: "node-42" } });
    expect(created.ownership).toEqual({ default: 2 });
    expect(created.folder).toBe("folder1");
    expect(created.pages).toEqual([
      {
        name: "The Burgomaster's letter",
        type: "text",
        text: {
          markdown: "My **dear** friend,",
          content: "<p>My <strong>dear</strong> friend,</p>",
          format: 2,
        },
      },
    ]);

    expect(journal.shown).toHaveLength(1);
    expect(journal.shown[0]?.options).toEqual({ force: true });
    expect((journal.shown[0]?.doc as FakeJournalEntry).id).toBe("entry2");
  });

  it("reuses a folder that is already there rather than making a second one", async () => {
    const existing = new FakeFolder("f1", { name: FOLDER_NAME, type: FOLDER_TYPE });
    const { journal } = await press({ folders: [existing] });

    expect(journal.createdFolders).toEqual([]);
    expect(journal.createdEntries[0]?.folder).toBe("f1");
  });

  it("grants observer to exactly the named targets and shows it to exactly them", async () => {
    const { journal } = await press({}, { targets: ["p1", "p3"] });

    expect(journal.createdEntries[0]?.ownership).toEqual({ default: 0, p1: 2, p3: 2 });
    expect(journal.shown[0]?.options).toEqual({ force: true, users: ["p1", "p3"] });
  });

  it("names the entry after the fetched page when MoT's command carried no title", async () => {
    const journal = createJournal();
    await writeHandout(plan({ title: null }), content({ title: "A letter" }), apiOf(journal), journal.world);
    expect(journal.createdEntries[0]?.name).toBe("A letter");
  });

  it("throws rather than showing nothing when Foundry refuses the create", async () => {
    const journal = createJournal({ createReturnsNull: true });
    await expect(writeHandout(plan(), content(), apiOf(journal), journal.world)).rejects.toThrow();
    expect(journal.shown).toEqual([]);
  });
});

describe("writeHandout — the second press", () => {
  /** The world as the first press left it. */
  async function pressTwice(second: Partial<HandoutPlan> = {}, nextContent = content({ markdown: "Come at once." })) {
    const journal = createJournal();
    await writeHandout(plan(), content(), apiOf(journal), journal.world);
    const outcome = await writeHandout(plan(second), nextContent, apiOf(journal), journal.world);
    return { journal, outcome, entry: journal.entries.contents[0]! };
  }

  it("updates the same letter in place rather than writing a second one", async () => {
    const { journal, outcome } = await pressTwice();

    expect(outcome).toBe("updated");
    expect(journal.createdEntries).toHaveLength(1);
    expect(journal.entries.size).toBe(1);
    expect(journal.createdFolders).toHaveLength(1);
  });

  it("rewrites the page's name, markdown and rendered HTML", async () => {
    const { entry } = await pressTwice({}, content({ title: "A second letter", markdown: "Come **at once**." }));

    expect(entry.name).toBe("A second letter");
    const page = entry.pages.contents[0]!;
    expect(page.name).toBe("A second letter");
    expect(page.text).toEqual({
      markdown: "Come **at once**.",
      content: "<p>Come <strong>at once</strong>.</p>",
      format: 2,
    });
    // One page, still — the update is an update, not an append.
    expect(entry.pages.size).toBe(1);
  });

  it("refreshes ownership, because the keeper may have picked different people", async () => {
    const { entry } = await pressTwice({ targets: ["p2"] });
    expect(entry.ownership.default).toBe(0);
    expect(entry.ownership.p2).toBe(2);
  });

  it("leaves a player who was handed the letter last time still holding it", async () => {
    // Foundry merges an ownership update, and this is the whole reason the
    // feature writes a document instead of opening a window.
    const journal = createJournal();
    await writeHandout(plan({ targets: ["p1"] }), content(), apiOf(journal), journal.world);
    await writeHandout(plan({ targets: ["p2"] }), content(), apiOf(journal), journal.world);

    const entry = journal.entries.contents[0]!;
    expect(entry.ownership.p1).toBe(2);
    expect(entry.ownership.p2).toBe(2);
  });

  it("shows the same document again", async () => {
    const { journal, entry } = await pressTwice();
    expect(journal.shown).toHaveLength(2);
    expect(journal.shown[1]?.doc).toBe(entry);
  });

  it("re-creates the page a keeper deleted, rather than showing an empty letter", async () => {
    const journal = createJournal();
    await writeHandout(plan(), content(), apiOf(journal), journal.world);

    const entry = journal.entries.contents[0]!;
    entry.pages.clear();
    expect(findTextPage(entry)).toBeNull();

    await writeHandout(plan(), content({ markdown: "Still here." }), apiOf(journal), journal.world);
    expect(entry.pages.contents[0]?.text.markdown).toBe("Still here.");
  });

  it("re-files an entry the keeper dragged out of the folder", async () => {
    const { entry } = await pressTwice();
    expect(entry.updates[0]?.folder).toBe("folder1");
    expect(entry.updates[0]?.flags).toEqual({ [MODULE_ID]: { origin: "mot", nodeId: "node-42" } });
  });
});

describe("handoutEntryData", () => {
  it("omits `folder` entirely when there is none, rather than filing at null", () => {
    const api = apiOf(createJournal());
    expect(Object.keys(handoutEntryData(plan(), "A letter", content(), api, null))).not.toContain("folder");
  });
});

// -------------------------------------------------------------- the handler

interface HandlerOptions extends FakeJournalOptions {
  isActive?: boolean;
  /** The bridge GET's answer. */
  response?: HandoutResponse;
  /** Make the fetch itself reject, the way an unreachable server does. */
  fetchThrows?: boolean;
  /** Model a client with no journal classes at all. */
  noApi?: boolean;
}

function handler(options: HandlerOptions = {}) {
  const journal = createJournal(options);
  const log = createLog();
  const fetched: string[] = [];

  const handle = createHandoutShowHandler({
    isActive: () => options.isActive !== false,
    fetch: (nodeId) => {
      fetched.push(nodeId);
      if (options.fetchThrows) return Promise.reject(new Error("network is down"));
      return Promise.resolve(options.response ?? { status: 200, body: content() });
    },
    api: () => (options.noApi ? null : resolveJournalApi(journal.v13Scope)),
    world: () => journal.world,
    log,
  });

  return { handle, journal, log, fetched };
}

/** The handler is fire-and-forget by design; the write is several awaits deep. */
async function settle(): Promise<void> {
  await flushMicrotasks(50);
}

describe("createHandoutShowHandler", () => {
  it("fetches the page and writes the letter", async () => {
    const table = handler();
    table.handle(payload());
    await settle();

    expect(table.fetched).toEqual(["node-42"]);
    expect(table.journal.createdEntries).toHaveLength(1);
    expect(table.journal.shown).toHaveLength(1);
    expect(table.log.lines.warn).toEqual([]);
  });

  it("does nothing at all on a client that is not the active GM", async () => {
    // Nor could it: the bridge token is client-scoped and lives in exactly one
    // browser, so the fetch this command starts with is the GM's alone.
    const table = handler({ isActive: false });
    table.handle(payload());
    await settle();

    expect(table.fetched).toEqual([]);
    expect(table.journal.createdEntries).toEqual([]);
  });

  it("treats a 404 as a logged no-op — the grant was revoked between the press and the fetch", async () => {
    const table = handler({ response: { status: 404, body: null } });
    table.handle(payload());
    await settle();

    expect(table.journal.createdEntries).toEqual([]);
    expect(table.journal.createdFolders).toEqual([]);
    expect(table.log.lines.warn.join(" ")).toMatch(/no shared handout node-42/);
  });

  it("treats an unreachable server as a logged no-op", async () => {
    const table = handler({ fetchThrows: true });
    table.handle(payload());
    await settle();

    expect(table.journal.createdEntries).toEqual([]);
    expect(table.log.lines.warn).toHaveLength(1);
  });

  it("says so and stops on any other refusal", async () => {
    const table = handler({ response: { status: 500, body: null } });
    table.handle(payload());
    await settle();

    expect(table.journal.createdEntries).toEqual([]);
    expect(table.log.lines.warn.join(" ")).toMatch(/HTTP 500/);
  });

  it("stops on a body with no markdown in it", async () => {
    const table = handler({ response: { status: 200, body: { title: "A letter" } } });
    table.handle(payload());
    await settle();

    expect(table.journal.createdEntries).toEqual([]);
    expect(table.log.lines.warn).toHaveLength(1);
  });

  it("drops a malformed command calmly, without fetching anything", async () => {
    const table = handler();
    table.handle(payload({ nodeId: "" }));
    table.handle(null);
    await settle();

    expect(table.fetched).toEqual([]);
    expect(table.log.lines.debug).toHaveLength(2);
  });

  it("drops calmly on a client with no journal classes", async () => {
    const table = handler({ noApi: true });
    table.handle(payload());
    await settle();

    expect(table.journal.createdEntries).toEqual([]);
    expect(table.log.lines.warn).toHaveLength(1);
  });

  it("keeps a Foundry that refused the show off the dispatcher's back", async () => {
    const table = handler({ showRejects: true });
    expect(() => table.handle(payload())).not.toThrow();
    await settle();

    expect(table.log.lines.warn).toHaveLength(1);
  });
});

// ------------------------------------------------------------ the dispatcher

describe("handout.show through the dispatcher", () => {
  it("routes the payload to the handler", async () => {
    const table = handler();
    const dispatch = createDispatcher({ onSession: () => undefined, onHandoutShow: table.handle });

    dispatch({
      v: 1,
      type: "handout.show",
      ts: "2026-08-23T20:00:00.000Z",
      payload: payload({ targets: ["p1"] }),
    });
    await settle();

    expect(table.journal.shown[0]?.options).toEqual({ force: true, users: ["p1"] });
  });

  it("treats handout.show with no handler wired as an unknown type rather than a fault", () => {
    // Rule 1, unchanged: a module a version ahead of the server loses a feature,
    // not the connection.
    const log = createLog();
    const dispatch = createDispatcher({ onSession: () => undefined, log });

    dispatch({ v: 1, type: "handout.show", ts: "2026-08-23T20:00:00.000Z", payload: payload() });

    expect(log.lines.debug).toEqual(['[masteroftales-bridge] no renderer wired for "handout.show"']);
  });
});
