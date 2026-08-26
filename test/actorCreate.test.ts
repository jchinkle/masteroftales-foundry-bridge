import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { ActorCreationBody } from "../src/protocol/actors.js";
import { actorCreationBody } from "../src/protocol/actors.js";
import type { ActorImage, FilePickerApi } from "../src/commands/actorCreate.js";
import {
  actorCreateData,
  actorTypeNames,
  buildTokenFile,
  createActorCreateHandler,
  DATA_SOURCE,
  decodeBase64,
  defaultActorType,
  extensionFor,
  FALLBACK_ACTOR_NAME,
  FALLBACK_FILE_STEM,
  failureMessage,
  MAX_ACTOR_NAME_LENGTH,
  MAX_DATA_URL_LENGTH,
  MAX_KEY_LENGTH,
  parseImageDataUrl,
  planActorCreate,
  prepareTokenDirectory,
  readActorImage,
  REASON_BAD_IMAGE,
  REASON_CREATE_FAILED,
  REASON_NO_ACTOR_API,
  REASON_NO_FILE_API,
  REASON_UPLOAD_FAILED,
  resolveActorApi,
  resolveFilePicker,
  safeFileName,
  TOKEN_DIRECTORY,
  uniqueFileName,
  unreportedMessage,
  uploadedPath,
  uploadTokenImage,
} from "../src/commands/actorCreate.js";
import { createDispatcher } from "../src/commands/index.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { createLog, flushMicrotasks } from "./stubs.js";

/**
 * Eight bytes that are honestly a PNG header and honestly nothing else. Nothing
 * in the module inspects the pixels — the point of the fixture is that the bytes
 * that come out the far end are the bytes that went in.
 */
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

/** An `actor.create` payload as MoT broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "req-7f3a",
    name: "Ash-Hollow Bugbear",
    image: { dataUrl: PNG_DATA_URL, filename: "ash-hollow-bugbear.png" },
    ...overrides,
  };
}

/** A validated picture, for the tests that start below the planner. */
function image(overrides: Partial<ActorImage> = {}): ActorImage {
  return { mimeType: "image/png", base64: PNG_BASE64, filename: "bugbear.png", ...overrides };
}

// ------------------------------------------------------------------ the plan

describe("planActorCreate", () => {
  it("reads the ordinary case", () => {
    expect(planActorCreate(payload())).toEqual({
      key: "req-7f3a",
      name: "Ash-Hollow Bugbear",
      image: {
        status: "ready",
        image: { mimeType: "image/png", base64: PNG_BASE64, filename: "ash-hollow-bugbear.png" },
      },
    });
  });

  it("echoes the key verbatim, whatever it looks like — it is opaque", () => {
    // Deliberately shaped like nothing: the module must not care.
    const key = "mot::7:cafe/beef+1=";
    expect(planActorCreate(payload({ key }))?.key).toBe(key);
  });

  it("drops a payload with no key: an answer nobody can match is litter in a world", () => {
    expect(planActorCreate(payload({ key: undefined }))).toBeNull();
    expect(planActorCreate(payload({ key: "   " }))).toBeNull();
    expect(planActorCreate(payload({ key: 7 }))).toBeNull();
    expect(planActorCreate(payload({ key: "a".repeat(MAX_KEY_LENGTH + 1) }))).toBeNull();
    expect(planActorCreate(payload({ key: "with\na newline" }))).toBeNull();
  });

  it("drops anything that is not an object", () => {
    expect(planActorCreate(null)).toBeNull();
    expect(planActorCreate("actor.create")).toBeNull();
    expect(planActorCreate([payload()])).toBeNull();
  });

  it("falls a missing name back rather than refusing the creature", () => {
    expect(planActorCreate(payload({ name: undefined }))?.name).toBe(FALLBACK_ACTOR_NAME);
    expect(planActorCreate(payload({ name: "   " }))?.name).toBe(FALLBACK_ACTOR_NAME);
    expect(planActorCreate(payload({ name: 12 }))?.name).toBe(FALLBACK_ACTOR_NAME);
  });

  it("strips markup and caps the name — it is written onto a document, not rendered", () => {
    expect(planActorCreate(payload({ name: "<b>Bugbear</b>" }))?.name).toBe("Bugbear");
    expect(planActorCreate(payload({ name: "x".repeat(400) }))?.name?.length).toBe(MAX_ACTOR_NAME_LENGTH);
  });
});

describe("readActorImage", () => {
  it("reads an absent picture as none, which creates an art-less actor", () => {
    expect(readActorImage(null)).toEqual({ status: "none" });
    expect(readActorImage(undefined)).toEqual({ status: "none" });
  });

  it("refuses a picture that is not the shape both ends agreed on", () => {
    expect(readActorImage(PNG_DATA_URL).status).toBe("refused");
    expect(readActorImage([{ dataUrl: PNG_DATA_URL }]).status).toBe("refused");
    expect(readActorImage({}).status).toBe("refused");
  });

  it("names the picture from the mime type when MoT suggested nothing", () => {
    const result = readActorImage({ dataUrl: PNG_DATA_URL });
    expect(result).toEqual({
      status: "ready",
      image: { mimeType: "image/png", base64: PNG_BASE64, filename: `${FALLBACK_FILE_STEM}.png` },
    });
  });
});

// -------------------------------------------------------------- the data URL

describe("parseImageDataUrl", () => {
  it("reads a base64 image data URL", () => {
    expect(parseImageDataUrl(PNG_DATA_URL)).toEqual({ mimeType: "image/png", base64: PNG_BASE64 });
  });

  it("accepts any image content type, and lower-cases it", () => {
    expect(parseImageDataUrl(`DATA:IMAGE/WEBP;BASE64,${PNG_BASE64}`)?.mimeType).toBe("image/webp");
    expect(parseImageDataUrl(`data:image/svg+xml;base64,${PNG_BASE64}`)?.mimeType).toBe("image/svg+xml");
  });

  it("carries media-type parameters without tripping over them", () => {
    expect(parseImageDataUrl(`data:image/png;charset=utf-8;base64,${PNG_BASE64}`)?.mimeType).toBe("image/png");
  });

  it("REFUSES every scheme that is not a base64 image data URL", () => {
    // The wall the whole file is built around: everything past this point turns
    // the string into bytes inside the keeper's own world directory.
    expect(parseImageDataUrl("javascript:alert(1)")).toBeNull();
    expect(parseImageDataUrl("https://masteroftales.com/tokens/bugbear.png")).toBeNull();
    expect(parseImageDataUrl("worlds/barovia/tokens/ireena.png")).toBeNull();
    expect(parseImageDataUrl(`data:text/html;base64,${PNG_BASE64}`)).toBeNull();
    expect(parseImageDataUrl(`data:application/octet-stream;base64,${PNG_BASE64}`)).toBeNull();
    expect(parseImageDataUrl("data:image/png,%89PNG")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64")).toBeNull();
  });

  it("refuses a payload that is not base64 at all", () => {
    expect(parseImageDataUrl("data:image/png;base64,not base64!!")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,abcde")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("tolerates the line breaks a wrapped base64 payload arrives with", () => {
    const wrapped = `data:image/png;base64,${PNG_BASE64.slice(0, 4)}\n  ${PNG_BASE64.slice(4)}`;
    expect(parseImageDataUrl(wrapped)?.base64).toBe(PNG_BASE64);
  });

  it("refuses anything that is not a string, and anything past the cap", () => {
    expect(parseImageDataUrl(null)).toBeNull();
    expect(parseImageDataUrl({ dataUrl: PNG_DATA_URL })).toBeNull();
    expect(parseImageDataUrl(`data:image/png;base64,${"A".repeat(MAX_DATA_URL_LENGTH)}`)).toBeNull();
  });
});

// --------------------------------------------------------------- the filename

describe("safeFileName", () => {
  it("keeps an ordinary basename", () => {
    expect(safeFileName("bugbear.png", "image/png")).toBe("bugbear.png");
  });

  it("STRIPS directory components — a filename off a wire may not name a path", () => {
    expect(safeFileName("../../worlds/barovia/bugbear.png", "image/png")).toBe("bugbear.png");
    expect(safeFileName("C:\\Users\\gm\\bugbear.png", "image/png")).toBe("bugbear.png");
    expect(safeFileName("..", "image/png")).toBe("token.png");
    expect(safeFileName("/etc/passwd", "image/png")).toBe("passwd.png");
  });

  it("takes the extension from the bytes rather than the suggestion", () => {
    // A PNG named .jpg is a file that lies to every tool that later opens it.
    expect(safeFileName("bugbear.jpg", "image/png")).toBe("bugbear.png");
    expect(safeFileName("bugbear", "image/jpeg")).toBe("bugbear.jpg");
    expect(safeFileName("bugbear.png", "image/webp")).toBe("bugbear.webp");
  });

  it("reduces anything outside [A-Za-z0-9._-] to a dash", () => {
    expect(safeFileName("Ash Hollow Bugbear!.png", "image/png")).toBe("Ash-Hollow-Bugbear.png");
    expect(safeFileName("bug/bear;rm -rf.png", "image/png")).toBe("bear-rm-rf.png");
  });

  it("never starts with a dot and never sanitises away to nothing", () => {
    expect(safeFileName(".htaccess", "image/png")).toBe("htaccess.png");
    expect(safeFileName("...", "image/png")).toBe("token.png");
    expect(safeFileName("", "image/png")).toBe("token.png");
    expect(safeFileName(null, "image/png")).toBe("token.png");
    expect(safeFileName("!!!", "image/png")).toBe("token.png");
  });

  it("caps the stem", () => {
    expect(safeFileName(`${"b".repeat(400)}.png`, "image/png")).toBe(`${"b".repeat(60)}.png`);
  });

  it("keeps an inner dot, which is a legal part of a name", () => {
    expect(safeFileName("ash.hollow.bugbear.png", "image/png")).toBe("ash.hollow.bugbear.png");
  });
});

describe("extensionFor", () => {
  it("spells the well-travelled types", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("IMAGE/PNG")).toBe("png");
    expect(extensionFor("image/svg+xml")).toBe("svg");
  });

  it("derives an extension for a type it has never heard of", () => {
    expect(extensionFor("image/x-tga")).toBe("xtga");
    expect(extensionFor("image/")).toBe("png");
  });
});

describe("uniqueFileName", () => {
  it("keeps the name when nothing has it", () => {
    expect(uniqueFileName("bugbear.png", [])).toBe("bugbear.png");
    expect(uniqueFileName("bugbear.png", ["masteroftales-tokens/goblin.png"])).toBe("bugbear.png");
  });

  it("NEVER overwrites — Foundry's own upload would, silently", () => {
    const taken = ["masteroftales-tokens/bugbear.png"];
    expect(uniqueFileName("bugbear.png", taken)).toBe("bugbear-1.png");
    expect(uniqueFileName("bugbear.png", [...taken, "masteroftales-tokens/bugbear-1.png"])).toBe("bugbear-2.png");
  });

  it("compares case-insensitively, because some filesystems do", () => {
    expect(uniqueFileName("bugbear.png", ["masteroftales-tokens/BugBear.PNG"])).toBe("bugbear-1.png");
  });

  it("ignores anything in the listing that is not a path", () => {
    expect(uniqueFileName("bugbear.png", [null, 7, ""] as unknown as string[])).toBe("bugbear.png");
  });
});

// ------------------------------------------------------------- the actor type

describe("actorTypeNames / defaultActorType", () => {
  it("reads an array, an object, and neither", () => {
    expect(actorTypeNames(["base", "character", "npc"])).toEqual(["character", "npc"]);
    expect(actorTypeNames({ base: {}, character: {}, npc: {} })).toEqual(["character", "npc"]);
    expect(actorTypeNames(null)).toEqual([]);
    expect(actorTypeNames("npc")).toEqual([]);
  });

  it("prefers npc, which is what a creature from MoT is", () => {
    expect(defaultActorType(["base", "character", "npc", "vehicle"])).toBe("npc");
    expect(defaultActorType({ character: {}, npc: {} })).toBe("npc");
  });

  it("falls back to the system's first type when it has no npc", () => {
    expect(defaultActorType(["base", "minion", "hero"])).toBe("minion");
  });

  it("falls back to npc when the world could not be read at all", () => {
    // Better than refusing to try: a create Foundry rejects is a notification the
    // keeper can act on.
    expect(defaultActorType(undefined)).toBe("npc");
    expect(defaultActorType(["base"])).toBe("npc");
  });
});

describe("actorCreateData", () => {
  it("points BOTH the portrait and the prototype token at the uploaded file", () => {
    expect(actorCreateData("Bugbear", "npc", "masteroftales-tokens/bugbear.png")).toEqual({
      name: "Bugbear",
      type: "npc",
      img: "masteroftales-tokens/bugbear.png",
      prototypeToken: { texture: { src: "masteroftales-tokens/bugbear.png" } },
      flags: { [MODULE_ID]: { origin: "mot" } },
    });
  });

  it("writes neither field with no picture, so Foundry's own placeholder stands", () => {
    const data = actorCreateData("Bugbear", "npc", null);
    expect(data).toEqual({ name: "Bugbear", type: "npc", flags: { [MODULE_ID]: { origin: "mot" } } });
    expect("img" in data).toBe(false);
    expect("prototypeToken" in data).toBe(false);
  });
});

// ------------------------------------------------------------ resolving foundry

describe("resolveFilePicker", () => {
  const picker = Object.assign(function FilePicker() {}, { upload: () => undefined });
  const legacy = Object.assign(function FilePicker() {}, { upload: () => undefined });

  it("prefers the v13 namespace over the deprecated bare global", () => {
    const scope = { foundry: { applications: { apps: { FilePicker: picker } } }, FilePicker: legacy };
    expect(resolveFilePicker(scope)).toBe(picker);
  });

  it("falls back to the bare global", () => {
    expect(resolveFilePicker({ FilePicker: legacy })).toBe(legacy);
  });

  it("answers null for a client that has neither, or one with no upload on it", () => {
    expect(resolveFilePicker({})).toBeNull();
    expect(resolveFilePicker(null)).toBeNull();
    expect(resolveFilePicker({ FilePicker: function FilePicker() {} })).toBeNull();
  });
});

describe("resolveActorApi", () => {
  const namespaced = Object.assign(function Actor() {}, { create: () => undefined });
  const legacy = Object.assign(function Actor() {}, { create: () => undefined });

  it("prefers the v13 namespace over the deprecated bare global", () => {
    const scope = { foundry: { documents: { Actor: namespaced } }, Actor: legacy };
    expect(resolveActorApi(scope)?.Actor).toBe(namespaced);
  });

  it("falls back to the bare global, and refuses a class with no create", () => {
    expect(resolveActorApi({ Actor: legacy })?.Actor).toBe(legacy);
    expect(resolveActorApi({ Actor: function Actor() {} })).toBeNull();
    expect(resolveActorApi(undefined)).toBeNull();
  });
});

// --------------------------------------------------------------- the bytes

describe("decodeBase64 / buildTokenFile", () => {
  it("decodes to the bytes that went in", () => {
    expect([...(decodeBase64(PNG_BASE64) ?? [])]).toEqual([...PNG_BYTES]);
  });

  it("answers null rather than throwing for a payload atob refuses", () => {
    expect(decodeBase64("@@@ not base64 @@@")).toBeNull();
  });

  it("answers null on a client with no atob", () => {
    expect(decodeBase64(PNG_BASE64, {})).toBeNull();
  });

  it("builds a File carrying the name and the content type", async () => {
    const file = buildTokenFile(image()) as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("bugbear.png");
    expect(file.type).toBe("image/png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...PNG_BYTES]);
  });

  it("answers null on a client with no File constructor", () => {
    expect(buildTokenFile(image(), {})).toBeNull();
  });
});

// -------------------------------------------------------------- the upload

interface PickerOptions {
  /** The directory listing, or null for a `browse` that throws (no such folder). */
  files?: string[] | null;
  createDirectoryRejects?: unknown;
  uploadRejects?: boolean;
  uploadResult?: unknown;
  omitBrowse?: boolean;
}

interface PickerTable {
  api: FilePickerApi;
  uploads: Array<{ source: string; path: string; file: File; options: unknown }>;
  created: string[];
  browsed: number;
}

/**
 * A FilePicker with no Foundry behind it. Small on purpose — the moment a stub is
 * complicated enough to have bugs, the tests it supports stop being evidence.
 */
function fakePicker(options: PickerOptions = {}): PickerTable {
  const table: PickerTable = { api: {} as FilePickerApi, uploads: [], created: [], browsed: 0 };
  let files = options.files === undefined ? [] : options.files;

  const api: FilePickerApi = {
    upload: (source, path, file, _body, uploadOptions) => {
      if (options.uploadRejects) return Promise.reject(new Error("the data directory is read-only"));
      table.uploads.push({ source, path, file: file as File, options: uploadOptions });
      if (options.uploadResult !== undefined) return Promise.resolve(options.uploadResult);
      return Promise.resolve({ status: "success", path: `${path}/${(file as File).name}` });
    },
    createDirectory: (_source, target) => {
      if (options.createDirectoryRejects) return Promise.reject(options.createDirectoryRejects);
      table.created.push(target);
      files = files ?? [];
      return Promise.resolve({ path: target });
    },
  };

  if (!options.omitBrowse) {
    api.browse = (_source, target) => {
      table.browsed += 1;
      if (files === null) return Promise.reject(new Error(`ENOENT: no such directory ${target}`));
      return Promise.resolve({ target, dirs: [], files });
    };
  }

  table.api = api;
  return table;
}

describe("prepareTokenDirectory", () => {
  it("lists what is already there", async () => {
    const picker = fakePicker({ files: ["masteroftales-tokens/goblin.png"] });
    await expect(prepareTokenDirectory(picker.api)).resolves.toEqual(["masteroftales-tokens/goblin.png"]);
    expect(picker.created).toEqual([]);
  });

  it("creates the directory when it is not there yet, then lists it", async () => {
    const picker = fakePicker({ files: null });
    await expect(prepareTokenDirectory(picker.api)).resolves.toEqual([]);
    expect(picker.created).toEqual([TOKEN_DIRECTORY]);
  });

  it("TOLERATES a directory that already exists — another client may have just made it", async () => {
    const log = createLog();
    const picker = fakePicker({ files: null, createDirectoryRejects: new Error("EEXIST: file already exists") });
    await expect(prepareTokenDirectory(picker.api, log)).resolves.toEqual([]);
    expect(log.lines.warn).toEqual([]);
  });

  it("shrugs at a Foundry with no browse at all", async () => {
    const picker = fakePicker({ omitBrowse: true });
    await expect(prepareTokenDirectory(picker.api)).resolves.toEqual([]);
  });
});

describe("uploadedPath", () => {
  it("reads Foundry's own success answer", () => {
    expect(uploadedPath({ status: "success", path: "masteroftales-tokens/bugbear.png" }, "fallback")).toBe(
      "masteroftales-tokens/bugbear.png",
    );
  });

  it("reads `false` as the failure it is — Foundry returns it rather than throwing", () => {
    expect(uploadedPath(false, "fallback")).toBeNull();
    expect(uploadedPath(null, "fallback")).toBeNull();
    expect(uploadedPath(undefined, "fallback")).toBeNull();
    expect(uploadedPath({ status: "error", message: "no" }, "fallback")).toBeNull();
  });

  it("falls back to the composed path for an answer it does not recognise", () => {
    expect(uploadedPath({ status: "success" }, "fallback")).toBe("fallback");
    expect(uploadedPath(true, "fallback")).toBe("fallback");
  });
});

describe("uploadTokenImage", () => {
  it("uploads into the module's own directory, with Foundry's own toast suppressed", async () => {
    const picker = fakePicker();
    const path = await uploadTokenImage(picker.api, image());

    expect(path).toBe("masteroftales-tokens/bugbear.png");
    expect(picker.uploads).toHaveLength(1);
    expect(picker.uploads[0]?.source).toBe(DATA_SOURCE);
    expect(picker.uploads[0]?.path).toBe(TOKEN_DIRECTORY);
    expect(picker.uploads[0]?.file.name).toBe("bugbear.png");
    // This module reports its own failures, in its own voice, once.
    expect(picker.uploads[0]?.options).toEqual({ notify: false });
  });

  it("uniques the name rather than replacing a picture already there", async () => {
    const picker = fakePicker({ files: ["masteroftales-tokens/bugbear.png"] });
    const path = await uploadTokenImage(picker.api, image());

    expect(path).toBe("masteroftales-tokens/bugbear-1.png");
    expect(picker.uploads[0]?.file.name).toBe("bugbear-1.png");
  });

  it("answers null when Foundry refuses the upload, by throwing or by saying false", async () => {
    const log = createLog();
    await expect(uploadTokenImage(fakePicker({ uploadRejects: true }).api, image(), log)).resolves.toBeNull();
    await expect(uploadTokenImage(fakePicker({ uploadResult: false }).api, image())).resolves.toBeNull();
    expect(log.lines.warn).toHaveLength(1);
  });

  it("answers null without uploading when the bytes will not decode", async () => {
    const picker = fakePicker();
    const log = createLog();
    await expect(uploadTokenImage(picker.api, image({ base64: "not base64" }), log)).resolves.toBeNull();
    expect(picker.uploads).toEqual([]);
    expect(log.lines.warn).toHaveLength(1);
  });
});

// ------------------------------------------------------------- the handler

interface HandlerOptions {
  isActive?: boolean;
  noFiles?: boolean;
  noActors?: boolean;
  createRejects?: boolean;
  createReturns?: unknown;
  reportRejects?: boolean;
  actorTypes?: unknown;
  picker?: PickerOptions;
}

function table(options: HandlerOptions = {}) {
  const log = createLog();
  const picker = fakePicker(options.picker);
  const notices: Array<{ level: string; message: string }> = [];
  const reported: ActorCreationBody[] = [];
  const created: Record<string, unknown>[] = [];

  const handle = createActorCreateHandler({
    isActive: () => options.isActive !== false,
    files: () => (options.noFiles ? null : picker.api),
    actors: () =>
      options.noActors
        ? null
        : {
            Actor: {
              create: (data: Record<string, unknown>) => {
                created.push(data);
                if (options.createRejects) return Promise.reject(new Error("the system refused that type"));
                if (options.createReturns !== undefined) return Promise.resolve(options.createReturns);
                return Promise.resolve({ id: "Aq81xkP2mNvR3sTu", name: data.name });
              },
            },
          },
    actorTypes: () => options.actorTypes ?? ["base", "character", "npc"],
    report: (body) => {
      reported.push(body);
      return options.reportRejects ? Promise.reject(new Error("network is down")) : Promise.resolve(undefined);
    },
    notify: (level, message) => void notices.push({ level, message }),
    log,
  });

  return { handle, log, picker, notices, reported, created };
}

describe("createActorCreateHandler", () => {
  it("uploads the picture, creates the actor, and reports the id home", async () => {
    const test = table();
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.picker.uploads[0]?.file.name).toBe("ash-hollow-bugbear.png");
    expect(test.created).toEqual([
      {
        name: "Ash-Hollow Bugbear",
        type: "npc",
        img: "masteroftales-tokens/ash-hollow-bugbear.png",
        prototypeToken: { texture: { src: "masteroftales-tokens/ash-hollow-bugbear.png" } },
        flags: { [MODULE_ID]: { origin: "mot" } },
      },
    ]);
    // The key back verbatim, Foundry's id, Foundry's name — and nothing else.
    expect(test.reported).toEqual([
      { key: "req-7f3a", actorId: "Aq81xkP2mNvR3sTu", name: "Ash-Hollow Bugbear" },
    ]);
    expect(test.notices).toEqual([]);
    expect(test.log.lines.warn).toEqual([]);
  });

  it("reports the name Foundry ended up with, not the one MoT asked for", async () => {
    const test = table({ createReturns: { id: "a1", name: "Ash-Hollow Bugbear (2)" } });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.reported[0]?.name).toBe("Ash-Hollow Bugbear (2)");
  });

  it("creates an art-less actor when MoT sent no picture, and touches no file at all", async () => {
    const test = table();
    test.handle(payload({ image: null }));
    await flushMicrotasks(20);

    expect(test.picker.uploads).toEqual([]);
    expect(test.picker.browsed).toBe(0);
    expect(test.created).toEqual([
      { name: "Ash-Hollow Bugbear", type: "npc", flags: { [MODULE_ID]: { origin: "mot" } } },
    ]);
    expect(test.reported).toHaveLength(1);
    expect(test.notices).toEqual([]);
  });

  it("does NOTHING on a client that is not the active GM", async () => {
    const test = table({ isActive: false });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.picker.uploads).toEqual([]);
    expect(test.created).toEqual([]);
    expect(test.reported).toEqual([]);
    expect(test.notices).toEqual([]);
  });

  it("drops a payload with no key quietly — nobody at this table asked for it", async () => {
    const test = table();
    test.handle({ name: "Bugbear" });
    await flushMicrotasks(20);

    expect(test.created).toEqual([]);
    expect(test.notices).toEqual([]);
    expect(test.log.lines.debug).toHaveLength(1);
  });

  it("creates NOTHING and reports NOTHING when the upload fails, and says so on screen", async () => {
    const test = table({ picker: { uploadRejects: true } });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.created).toEqual([]);
    expect(test.reported).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Ash-Hollow Bugbear", REASON_UPLOAD_FAILED) },
    ]);
    expect(test.log.lines.warn).toHaveLength(1);
  });

  it("refuses a dataUrl that is not an image, before anything is written anywhere", async () => {
    const test = table();
    test.handle(payload({ image: { dataUrl: "javascript:alert(1)", filename: "bugbear.png" } }));
    await flushMicrotasks(20);

    expect(test.picker.uploads).toEqual([]);
    expect(test.created).toEqual([]);
    expect(test.reported).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Ash-Hollow Bugbear", REASON_BAD_IMAGE) },
    ]);
    expect(test.log.lines.warn).toHaveLength(1);
  });

  it("reports nothing when Foundry refuses the create", async () => {
    const test = table({ createRejects: true });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.reported).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Ash-Hollow Bugbear", REASON_CREATE_FAILED) },
    ]);
  });

  it("reports nothing when the create resolved to a document with no id", async () => {
    const test = table({ createReturns: null });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.reported).toEqual([]);
    expect(test.notices[0]?.message).toBe(failureMessage("Ash-Hollow Bugbear", REASON_CREATE_FAILED));
  });

  it("says so when the actor is real but the answer never reached MoT", async () => {
    const test = table({ reportRejects: true });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.created).toHaveLength(1);
    expect(test.notices).toEqual([{ level: "warn", message: unreportedMessage("Ash-Hollow Bugbear") }]);
    expect(test.log.lines.warn).toHaveLength(1);
  });

  it("names the missing Foundry class rather than failing silently", async () => {
    const noActors = table({ noActors: true });
    noActors.handle(payload());
    const noFiles = table({ noFiles: true });
    noFiles.handle(payload());
    await flushMicrotasks(20);

    expect(noActors.notices[0]?.message).toBe(failureMessage("Ash-Hollow Bugbear", REASON_NO_ACTOR_API));
    expect(noFiles.notices[0]?.message).toBe(failureMessage("Ash-Hollow Bugbear", REASON_NO_FILE_API));
    // The Actor class is checked before a byte is written: no half-done upload.
    expect(noActors.picker.uploads).toEqual([]);
  });

  it("never throws into the dispatcher, whatever the payload is", async () => {
    const test = table();
    expect(() => test.handle(null)).not.toThrow();
    expect(() => test.handle("actor.create")).not.toThrow();
    expect(() => test.handle({ key: "k", image: { dataUrl: 7 } })).not.toThrow();
    await flushMicrotasks(20);
  });

  it("survives a Foundry whose notification bar is the thing that is broken", async () => {
    // The path that reports trouble must not be able to become the trouble.
    const log = createLog();
    const handle = createActorCreateHandler({
      isActive: () => true,
      files: () => null,
      actors: () => null,
      actorTypes: () => ["npc"],
      report: () => Promise.resolve(undefined),
      notify: () => {
        throw new Error("ui is not ready");
      },
      log,
    });

    expect(() => handle(payload())).not.toThrow();
    await flushMicrotasks(20);

    expect(log.lines.debug.some((line) => line.includes("could not show a notification"))).toBe(true);
  });

  it("uses the system's first actor type on a world with no npc", async () => {
    const test = table({ actorTypes: ["base", "minion"] });
    test.handle(payload({ image: null }));
    await flushMicrotasks(20);

    expect(test.created[0]?.type).toBe("minion");
  });
});

// ------------------------------------------------------------- the wire home

describe("actorCreationBody", () => {
  it("is the key, the Foundry id and the Foundry name — and nothing else", () => {
    const body = actorCreationBody("req-7f3a", "Aq81xkP2mNvR3sTu", "Ash-Hollow Bugbear");
    expect(body).toEqual({ key: "req-7f3a", actorId: "Aq81xkP2mNvR3sTu", name: "Ash-Hollow Bugbear" });
    // No user id, no member id, no role, no MoT record id. The wall the whole
    // bridge wire keeps, in both directions.
    expect(Object.keys(body).sort()).toEqual(["actorId", "key", "name"]);
  });
});

// ------------------------------------------------------------ the dispatcher

describe("the dispatcher's newest type", () => {
  it("routes actor.create to its handler, payload and all", () => {
    const onActorCreate = vi.fn();
    const dispatch = createDispatcher({ onSession: vi.fn(), onActorCreate });

    dispatch({ v: 1, type: "actor.create", ts: "x", payload: payload() });

    expect(onActorCreate).toHaveBeenCalledWith(payload());
  });

  it("treats it as unknown when nothing is wired — which is what 0.6.1 does with it", () => {
    const log = createLog();
    const dispatch = createDispatcher({ onSession: vi.fn(), log });

    dispatch({ v: 1, type: "actor.create", ts: "x", payload: payload() });

    expect(log.lines.warn).toEqual([]);
    expect(log.lines.debug).toHaveLength(1);
  });
});
