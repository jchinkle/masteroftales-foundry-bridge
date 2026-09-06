import { describe, expect, it } from "vitest";
import type { ScenePlan, SceneApi, SceneBackgroundResponse } from "../src/commands/scenes.js";
import {
  createSceneUpsertHandler,
  DEFAULT_GRIDLESS_SIZE,
  findPinEntry,
  findScene,
  gridOffset,
  noteData,
  ownedEmbeddedIds,
  pinEntryData,
  pinOwnership,
  pinPageData,
  planSceneUpsert,
  polylineDrawingData,
  resolveSceneApi,
  SCENE_DIRECTORY,
  scenePath,
  sceneCanvasData,
  sceneFlags,
  textDrawingData,
  uploadBackground,
  writeScene,
} from "../src/commands/scenes.js";
import { createDispatcher } from "../src/commands/index.js";
import { ORIGIN_MOT } from "../src/capture/loopGuard.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { sceneBackgroundPath } from "../src/settings.js";
import { createLog, fakePicker, FakeFolder, flushMicrotasks, PNG_BYTES } from "./stubs.js";
import type { FakeSceneWorld } from "./sceneStubs.js";
import { createSceneWorld, FakeScene } from "./sceneStubs.js";

/** A `scene.upsert` payload as MoT broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mapId: "map-42",
    title: "The Village of Barovia",
    width: 4096,
    height: 3072,
    grid: { size: 100, originX: 12, originY: 40, distance: 5, units: "ft" },
    notes: [
      {
        pinId: "pin-1",
        label: "The tavern",
        x: 1204.5,
        y: 880,
        text: "Sour wine, worse company.",
        target: "The Blood on the Vine",
        gmOnly: false,
      },
    ],
    texts: [
      { labelId: "label-1", text: "SVALICH WOODS", x: 200, y: 340, size: 96, color: "#f4e4c1", rotation: -12 },
    ],
    drawings: [
      {
        drawingId: "line-1",
        name: "The Old Svalich Road",
        kind: "road",
        points: [
          { x: 10, y: 20 },
          { x: 110, y: 220 },
        ],
        color: "#c9a227",
        width: 6,
        opacity: 1,
        dash: "dashed",
      },
    ],
    ...overrides,
  };
}

function plan(overrides: Partial<ScenePlan> = {}): ScenePlan {
  const planned = planSceneUpsert(payload());
  if (!planned) throw new Error("the fixture payload did not plan");
  return { ...planned, ...overrides };
}

function apiOf(world: FakeSceneWorld): SceneApi {
  const api = resolveSceneApi(world.v13Scope);
  if (!api) throw new Error("the stub scope did not resolve");
  return api;
}

// --------------------------------------------------------------------- plan

describe("planSceneUpsert", () => {
  it("normalises the ordinary case", () => {
    const planned = planSceneUpsert(payload());

    expect(planned?.mapId).toBe("map-42");
    expect(planned?.title).toBe("The Village of Barovia");
    expect(planned?.width).toBe(4096);
    expect(planned?.height).toBe(3072);
    expect(planned?.grid).toEqual({ size: 100, originX: 12, originY: 40, distance: 5, units: "ft" });
    expect(planned?.notes).toHaveLength(1);
    expect(planned?.texts).toHaveLength(1);
    expect(planned?.drawings).toHaveLength(1);
  });

  it("drops a payload with no usable map id", () => {
    for (const mapId of [undefined, null, "", "   ", 7, {}, "../../worlds", "a/b"]) {
      expect(planSceneUpsert(payload({ mapId }))).toBeNull();
    }
  });

  // The map id becomes a filename inside the keeper's own data directory. A
  // separator getting through here would be a write outside the one folder this
  // module owns.
  it("refuses a map id that is not one path segment", () => {
    for (const mapId of ["..", ".", "a\\b", "a b", "a\nb"]) {
      expect(planSceneUpsert(payload({ mapId }))).toBeNull();
    }
  });

  it("drops a payload with no canvas to draw on", () => {
    for (const size of [{ width: 0 }, { height: 0 }, { width: "wide" }, { height: null }]) {
      expect(planSceneUpsert(payload(size))).toBeNull();
    }
  });

  it("names an unnamed map rather than creating a nameless scene", () => {
    expect(planSceneUpsert(payload({ title: "   " }))?.title).toBe("Map");
  });

  // A gridless scene is a working scene. A scene with a grid built out of
  // guesses is one where a token that should move one square moves somewhere
  // near one square.
  it("takes no grid at all rather than half a grid", () => {
    for (const grid of [null, undefined, {}, { size: 100 }, { size: 0, originX: 0, originY: 0 }, "square"]) {
      expect(planSceneUpsert(payload({ grid }))?.grid).toBeNull();
    }
  });

  it("fills in a distance and units a payload forgot, rather than measuring in zeroes", () => {
    expect(planSceneUpsert(payload({ grid: { size: 70, originX: 0, originY: 0 } }))?.grid).toEqual({
      size: 70,
      originX: 0,
      originY: 0,
      distance: 5,
      units: "ft",
    });
  });

  // Strictly `true`: the direction to be wrong in is the one where a keeper's
  // pin stays the keeper's.
  it("only treats an exact true as a keeper's pin", () => {
    const notes = (gmOnly: unknown) =>
      planSceneUpsert(payload({ notes: [{ pinId: "p", label: "l", x: 1, y: 2, gmOnly }] }))?.notes[0];

    expect(notes(true)?.gmOnly).toBe(true);
    expect(notes(1)?.gmOnly).toBe(false);
    expect(notes("true")?.gmOnly).toBe(false);
    expect(notes(undefined)?.gmOnly).toBe(false);
  });

  it("drops a note with nowhere to be, and keeps the rest", () => {
    const planned = planSceneUpsert(
      payload({
        notes: [
          { pinId: "p1", label: "here", x: 1, y: 2 },
          { pinId: "p2", label: "nowhere" },
          { label: "nameless", x: 3, y: 4 },
        ],
      }),
    );

    expect(planned?.notes.map((note) => note.pinId)).toEqual(["p1"]);
  });

  it("refuses a line of one point, because one point is not a line", () => {
    const planned = planSceneUpsert(
      payload({ drawings: [{ drawingId: "d", points: [{ x: 1, y: 2 }] }] }),
    );

    expect(planned?.drawings).toEqual([]);
  });

  it("keeps a bad colour out of the document rather than passing it on", () => {
    const planned = planSceneUpsert(
      payload({
        texts: [{ labelId: "l", text: "X", x: 1, y: 2, size: 20, color: "puce", rotation: 0 }],
      }),
    );

    expect(planned?.texts[0]?.color).toBeNull();
  });
});

// --------------------------------------------------------------------- grid

describe("gridOffset", () => {
  // Foundry's grid is anchored to the scene rectangle and cannot be moved, so
  // the picture is what shifts, by the smallest amount that lines the two up,
  // and never more than one square.
  it("shifts the picture back to the nearest intersection", () => {
    expect(gridOffset(0, 100)).toBe(0);
    expect(gridOffset(12, 100)).toBe(-12);
    expect(gridOffset(140, 100)).toBe(-40);
    expect(gridOffset(300, 100)).toBe(0);
  });

  it("never shifts by more than one square", () => {
    for (const origin of [1, 37, 99, 1001, 99_999]) {
      expect(Math.abs(gridOffset(origin, 70))).toBeLessThan(70);
    }
  });

  it("shrugs at nonsense rather than producing a NaN offset", () => {
    expect(gridOffset(Number.NaN, 100)).toBe(0);
    expect(gridOffset(10, 0)).toBe(0);
  });
});

describe("sceneCanvasData", () => {
  it("points the scene at a local file and lays a square over it", () => {
    const world = createSceneWorld();
    const data = sceneCanvasData(plan(), "masteroftales-scenes/map-42.png", apiOf(world));

    expect(data.name).toBe("The Village of Barovia");
    expect(data.width).toBe(4096);
    expect(data.height).toBe(3072);
    expect(data.background).toEqual({
      src: "masteroftales-scenes/map-42.png",
      offsetX: -12,
      offsetY: -40,
    });
    expect(data.grid).toEqual({ type: 1, size: 100, distance: 5, units: "ft" });
    expect(data.flags).toEqual({ [MODULE_ID]: { origin: ORIGIN_MOT, mapId: "map-42" } });
  });

  // A gridless scene still carries a size: it is what the ruler is built on, and
  // Foundry refuses a scene whose grid size is nothing.
  it("goes gridless with a size Foundry will accept", () => {
    const world = createSceneWorld();
    const data = sceneCanvasData(plan({ grid: null }), "masteroftales-scenes/map-42.png", apiOf(world));

    expect(data.grid).toEqual({ type: 0, size: DEFAULT_GRIDLESS_SIZE });
    expect(data.background).toEqual({
      src: "masteroftales-scenes/map-42.png",
      offsetX: 0,
      offsetY: 0,
    });
  });
});

// ---------------------------------------------------------------- documents

describe("noteData and the entry behind it", () => {
  it("puts the pin's label under the marker and stamps the note as ours", () => {
    const data = noteData(plan(), plan().notes[0]!, "entry-7");

    expect(data).toMatchObject({ entryId: "entry-7", x: 1204.5, y: 880, text: "The tavern", global: true });
    expect(data.flags).toEqual({
      [MODULE_ID]: { origin: ORIGIN_MOT, mapId: "map-42", pinId: "pin-1" },
    });
  });

  // A Foundry Note's visibility *is* its entry's permission. This is the whole
  // of "a keeper-only pin is a GM-only note".
  it("writes a keeper's pin so that only the GM may read it", () => {
    expect(pinOwnership(true, { NONE: 0, OBSERVER: 2 })).toEqual({ default: 0 });
    expect(pinOwnership(false, { NONE: 0, OBSERVER: 2 })).toEqual({ default: 2 });
  });

  it("writes the page behind a pin with its target named and its words below", () => {
    const world = createSceneWorld();
    const page = pinPageData(plan().notes[0]!, apiOf(world));

    expect(page.name).toBe("The tavern");
    expect((page.text as { markdown: string }).markdown).toBe(
      "**The Blood on the Vine**\n\nSour wine, worse company.",
    );
    expect((page.text as { content: string }).content).toBe(
      "<p><strong>The Blood on the Vine</strong></p><p>Sour wine, worse company.</p>",
    );
  });

  it("escapes what a keeper wrote rather than rendering it as markup", () => {
    const world = createSceneWorld();
    const note = { ...plan().notes[0]!, target: null, text: "<script>alert(1)</script>" };

    expect((pinPageData(note, apiOf(world)).text as { content: string }).content).toContain("&lt;script&gt;");
  });

  it("files a pin's entry in the Master of Tales folder when there is one", () => {
    const world = createSceneWorld();
    const data = pinEntryData(plan(), plan().notes[0]!, apiOf(world), "folder-1");

    expect(data.folder).toBe("folder-1");
    expect(data.ownership).toEqual({ default: 2 });
  });
});

describe("the drawings", () => {
  it("turns a polyline into a Foundry polygon relative to its own corner", () => {
    const data = polylineDrawingData(plan(), plan().drawings[0]!);

    expect(data.x).toBe(10);
    expect(data.y).toBe(20);
    expect(data.shape).toEqual({ type: "p", width: 100, height: 200, points: [0, 0, 100, 200] });
    expect(data).toMatchObject({ strokeColor: "#c9a227", strokeWidth: 6, strokeAlpha: 1, fillType: 0 });
  });

  // Foundry has no dash pattern on a drawing, so the line arrives solid, and
  // the word survives in the flags rather than being lost at the wire.
  it("stamps the dash it cannot draw", () => {
    const flags = polylineDrawingData(plan(), plan().drawings[0]!).flags as Record<
      string,
      Record<string, string>
    >;

    expect(flags[MODULE_ID]).toEqual({
      origin: ORIGIN_MOT,
      mapId: "map-42",
      drawingId: "line-1",
      role: "line",
      dash: "dashed",
      kind: "road",
    });
  });

  it("turns a map label into text on a box big enough to hold it", () => {
    const data = textDrawingData(plan(), plan().texts[0]!);

    expect(data).toMatchObject({
      text: "SVALICH WOODS",
      fontSize: 96,
      textColor: "#f4e4c1",
      rotation: -12,
      strokeWidth: 0,
      fillType: 0,
    });
    const shape = data.shape as { type: string; width: number; height: number };
    expect(shape.type).toBe("r");
    expect(shape.width).toBeGreaterThan(96);
    expect(shape.height).toBeGreaterThan(96);
  });
});

// ------------------------------------------------------------- the background

describe("the background file", () => {
  it("names the file after the map and the bytes' own type", () => {
    expect(scenePath("map-42", "image/webp")).toBe("masteroftales-scenes/map-42.webp");
    // `.jpg` rather than `.jpeg`: the spelling table in commands/tokenImages.ts
    // is shared, so both commands write one extension per content type.
    expect(scenePath("map-42", "image/jpeg;charset=utf-8")).toBe("masteroftales-scenes/map-42.jpg");
    expect(scenePath("map-42", null)).toBe("masteroftales-scenes/map-42.png");
  });

  // The opposite of `uploadTokenImage`'s uniquing, and on purpose: one map sent
  // twice is one picture, and a `map-42-1.png` trail is litter that never stops
  // growing.
  it("overwrites the same file on a second send rather than uniquing", async () => {
    const picker = fakePicker({ files: ["masteroftales-scenes/map-42.png"] });

    const path = await uploadBackground(picker.api, "map-42", {
      bytes: PNG_BYTES,
      contentType: "image/png",
    });

    expect(path).toBe("masteroftales-scenes/map-42.png");
    expect(picker.uploads).toHaveLength(1);
    expect(picker.uploads[0]?.path).toBe(SCENE_DIRECTORY);
    expect((picker.uploads[0]?.file as File).name).toBe("map-42.png");
    // This module reports its own failures, once, in its own voice.
    expect(picker.uploads[0]?.options).toEqual({ notify: false });
  });

  it("answers null when Foundry refuses the write, so nothing is built on it", async () => {
    const picker = fakePicker({ uploadRejects: true });
    const log = createLog();

    expect(
      await uploadBackground(picker.api, "map-42", { bytes: PNG_BYTES, contentType: "image/png" }, globalThis, log),
    ).toBeNull();
    expect(log.lines.warn.join(" ")).toContain("refused the map background upload");
  });
});

// ------------------------------------------------------------------ the write

describe("writeScene", () => {
  const backgroundPath = "masteroftales-scenes/map-42.png";

  it("creates a scene, its notes, its entries and its drawings", async () => {
    const world = createSceneWorld();

    const outcome = await writeScene(plan(), backgroundPath, apiOf(world), world.world);

    expect(outcome).toBe("created");
    expect(world.createdScenes).toHaveLength(1);

    const scene = world.scenes.contents[0]!;
    expect(scene.created.Note).toHaveLength(1);
    // One polyline and one label, both drawings on the far side.
    expect(scene.created.Drawing).toHaveLength(2);
    expect(world.createdEntries).toHaveLength(1);
    // Nothing was activated, and nothing asked to be.
    expect(scene.activated).toBe(false);
  });

  it("updates the same scene on a second send rather than making another", async () => {
    const world = createSceneWorld();

    await writeScene(plan(), backgroundPath, apiOf(world), world.world);
    const outcome = await writeScene(plan(), backgroundPath, apiOf(world), world.world);

    expect(outcome).toBe("updated");
    expect(world.createdScenes).toHaveLength(1);
    expect(world.scenes.contents).toHaveLength(1);
    expect(world.scenes.contents[0]!.updates).toHaveLength(1);
  });

  it("finds the scene by its flag, whatever the keeper renamed it to", async () => {
    const world = createSceneWorld();
    await writeScene(plan(), backgroundPath, apiOf(world), world.world);

    world.scenes.contents[0]!.name = "Barovia (my version)";

    expect(findScene(world.scenes, "map-42")?.name).toBe("Barovia (my version)");
    expect(findScene(world.scenes, "map-99")).toBeNull();
  });

  // Rule 3, and the reason the flags exist at all.
  it("replaces only the notes and drawings it wrote, and leaves the GM's alone", async () => {
    const world = createSceneWorld();
    await writeScene(plan(), backgroundPath, apiOf(world), world.world);

    const scene = world.scenes.contents[0]!;
    scene.addEmbedded("Note", { id: "gm-note", flags: {} });
    scene.addEmbedded("Drawing", { id: "gm-wall", flags: {} });

    await writeScene(plan(), backgroundPath, apiOf(world), world.world);

    const remaining = scene.embedded.Note.map((doc) => doc.id);
    expect(remaining).toContain("gm-note");
    expect(scene.embedded.Drawing.map((doc) => doc.id)).toContain("gm-wall");
    // Exactly one of ours, not two: the first send's note was deleted first.
    expect(scene.embedded.Note.filter((doc) => doc.id !== "gm-note")).toHaveLength(1);
  });

  it("knows which embedded documents are its own", () => {
    const scene = new FakeScene("scene-1", { flags: sceneFlags("map-42") });
    scene.addEmbedded("Note", { id: "ours", flags: { [MODULE_ID]: { origin: ORIGIN_MOT, mapId: "map-42" } } });
    scene.addEmbedded("Note", {
      id: "another-map",
      flags: { [MODULE_ID]: { origin: ORIGIN_MOT, mapId: "map-99" } },
    });
    scene.addEmbedded("Note", { id: "theirs", flags: {} });

    expect(ownedEmbeddedIds(scene.notes, "map-42")).toEqual(["ours"]);
  });

  it("updates a pin's entry in place rather than writing a second one", async () => {
    const world = createSceneWorld();
    await writeScene(plan(), backgroundPath, apiOf(world), world.world);

    const changed = plan();
    changed.notes[0]!.label = "The tavern, burned";

    await writeScene(changed, backgroundPath, apiOf(world), world.world);

    expect(world.entries.contents).toHaveLength(1);
    expect(findPinEntry(world.entries, "map-42", "pin-1")?.name).toBe("The tavern, burned");
  });

  it("writes a keeper's pin at an ownership no player can read", async () => {
    const world = createSceneWorld();
    const secret = plan();
    secret.notes[0]!.gmOnly = true;

    await writeScene(secret, backgroundPath, apiOf(world), world.world);

    expect(world.entries.contents[0]!.ownership).toEqual({ default: 0 });
  });

  it("makes the Master of Tales folder when the world has none, and adopts it when it has", async () => {
    const world = createSceneWorld();
    await writeScene(plan(), backgroundPath, apiOf(world), world.world);
    expect(world.createdFolders).toHaveLength(1);

    await writeScene(plan(), backgroundPath, apiOf(world), world.world);
    expect(world.createdFolders).toHaveLength(1);
  });

  it("uses a folder somebody made by hand rather than a second one beside it", async () => {
    const world = createSceneWorld({
      folders: [new FakeFolder("hand-made", { name: "Master of Tales", type: "JournalEntry" })],
    });

    await writeScene(plan(), backgroundPath, apiOf(world), world.world);

    expect(world.createdFolders).toHaveLength(0);
    expect(world.createdEntries[0]?.folder).toBe("hand-made");
  });
});

// ------------------------------------------------------------- the resolution

describe("resolveSceneApi", () => {
  it("prefers the namespaced classes over the deprecated globals", () => {
    const world = createSceneWorld();

    expect(resolveSceneApi(world.v13Scope)).not.toBeNull();
    expect(world.decoyed).toEqual([]);
  });

  it("still works on a Foundry with only the bare globals", () => {
    const world = createSceneWorld();

    expect(resolveSceneApi(world.legacyScope)).not.toBeNull();
  });

  it("answers null for a scope with no Foundry in it", () => {
    expect(resolveSceneApi(null)).toBeNull();
    expect(resolveSceneApi({})).toBeNull();
  });
});

// ---------------------------------------------------------------- the handler

describe("createSceneUpsertHandler", () => {
  interface Harness {
    world: FakeSceneWorld;
    picker: ReturnType<typeof fakePicker>;
    notices: Array<{ level: string; message: string }>;
    fetched: string[];
    handler: (payload: unknown) => void;
    log: ReturnType<typeof createLog>;
  }

  function harness(
    options: { active?: boolean; response?: SceneBackgroundResponse; throws?: boolean } = {},
  ): Harness {
    const world = createSceneWorld();
    const picker = fakePicker();
    const notices: Array<{ level: string; message: string }> = [];
    const fetched: string[] = [];
    const log = createLog();

    const handler = createSceneUpsertHandler({
      isActive: () => options.active !== false,
      fetchBackground: (mapId) => {
        fetched.push(mapId);
        if (options.throws) return Promise.reject(new Error("network down"));
        return Promise.resolve(
          options.response ?? { status: 200, bytes: PNG_BYTES, contentType: "image/png" },
        );
      },
      api: () => resolveSceneApi(world.v13Scope),
      files: () => picker.api,
      world: () => world.world,
      notify: (level, message) => notices.push({ level, message }),
      log,
    });

    return { world, picker, notices, fetched, handler, log };
  }

  it("builds the scene and says which it did", async () => {
    const table = harness();

    table.handler(payload());
    await flushMicrotasks(40);

    expect(table.fetched).toEqual(["map-42"]);
    expect(table.world.createdScenes).toHaveLength(1);
    expect(table.notices).toEqual([
      {
        level: "info",
        message: 'Scene "The Village of Barovia" created from Master of Tales. Activate it when the party is ready.',
      },
    ]);
  });

  it("says updated the second time", async () => {
    const table = harness();

    table.handler(payload());
    await flushMicrotasks(40);
    table.handler(payload());
    await flushMicrotasks(40);

    expect(table.notices[1]?.message).toBe('Scene "The Village of Barovia" updated from Master of Tales.');
  });

  // One client owns this, exactly as it owns every other write: two GMs on one
  // world would otherwise each build the scene.
  it("does nothing on a client that is not the active GM", async () => {
    const table = harness({ active: false });

    table.handler(payload());
    await flushMicrotasks(40);

    expect(table.fetched).toEqual([]);
    expect(table.world.createdScenes).toEqual([]);
  });

  it("drops a payload with nothing playable in it, calmly", async () => {
    const table = harness();

    table.handler({ mapId: "" });
    await flushMicrotasks(40);

    expect(table.fetched).toEqual([]);
    expect(table.notices).toEqual([]);
  });

  it("says so on the keeper's screen when the server could not be reached", async () => {
    const table = harness({ throws: true });

    table.handler(payload());
    await flushMicrotasks(40);

    expect(table.notices[0]?.level).toBe("warn");
    expect(table.notices[0]?.message).toContain("could not be reached");
    expect(table.world.createdScenes).toEqual([]);
  });

  // The grant is checked again at fetch time, so a 404 here is a real answer
  // rather than a broken module.
  it("builds nothing when the background comes back refused", async () => {
    const table = harness({ response: { status: 404, bytes: null, contentType: null } });

    table.handler(payload());
    await flushMicrotasks(40);

    expect(table.world.createdScenes).toEqual([]);
    expect(table.notices[0]?.message).toContain("background could not be fetched");
  });

  it("is reachable through the dispatcher by its protocol type", () => {
    const seen: unknown[] = [];
    const dispatch = createDispatcher({
      onSession: () => undefined,
      onSceneUpsert: (body) => seen.push(body),
    });

    dispatch({ v: 1, type: "scene.upsert", ts: "2026-09-06T00:00:00Z", payload: payload() });

    expect(seen).toHaveLength(1);
  });
});

describe("sceneBackgroundPath", () => {
  it("addresses the bridge's own door, by map id", () => {
    expect(sceneBackgroundPath("map-42")).toBe("/api/v1/bridge/maps/map-42/background");
  });

  it("encodes an id that should never have arrived", () => {
    expect(sceneBackgroundPath("a b")).toBe("/api/v1/bridge/maps/a%20b/background");
  });
});
