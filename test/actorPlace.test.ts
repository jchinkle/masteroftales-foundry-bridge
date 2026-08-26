import { describe, expect, it, vi } from "vitest";
import type { CanvasLike, PlaceableActor } from "../src/commands/actorPlace.js";
import {
  createActorPlaceHandler,
  DEFAULT_GRID_SIZE,
  FALLBACK_PLACED_NAME,
  failureMessage,
  gridSize,
  MAX_ACTOR_ID_LENGTH,
  MAX_PLACED_NAME_LENGTH,
  placedTokenData,
  placementScene,
  planActorPlace,
  prototypeTokenData,
  REASON_NO_ACTOR,
  REASON_NO_SCENE,
  REASON_NO_VIEW,
  REASON_PLACE_FAILED,
  resolveCanvas,
  tokenFootprint,
  tokenPosition,
  viewCenter,
} from "../src/commands/actorPlace.js";
import { createDispatcher } from "../src/commands/index.js";
import {
  REASON_BAD_IMAGE,
  REASON_NO_FILE_API,
  REASON_UPLOAD_FAILED,
} from "../src/commands/tokenImages.js";
import { MODULE_ID } from "../src/protocol/version.js";
import type { PickerOptions } from "./stubs.js";
import { createLog, fakePicker, flushMicrotasks, PNG_BASE64, PNG_DATA_URL } from "./stubs.js";

/**
 * `actor.place` — one token, for a creature this world already has, onto the map
 * the keeper is looking at.
 *
 * Two of these tests are the feature rather than a corner of it: the one that
 * proves the token is placed on `canvas.scene` (and not on the players' active
 * scene), and the one that proves a picked variant dresses the *token* while the
 * actor's own art is left exactly as the keeper set it.
 */

/** An `actor.place` payload as MoT broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actorId: "Aq81xkP2mNvR3sTu",
    name: "Ash-Hollow Bugbear",
    image: { dataUrl: PNG_DATA_URL, filename: "ash-hollow-bugbear.png" },
    ...overrides,
  };
}

// ------------------------------------------------------------------ the plan

describe("planActorPlace", () => {
  it("reads the ordinary case", () => {
    expect(planActorPlace(payload())).toEqual({
      actorId: "Aq81xkP2mNvR3sTu",
      name: "Ash-Hollow Bugbear",
      image: {
        status: "ready",
        image: { mimeType: "image/png", base64: PNG_BASE64, filename: "ash-hollow-bugbear.png" },
      },
    });
  });

  it("drops a payload with no actorId: there is nothing to place and nobody waiting", () => {
    expect(planActorPlace(payload({ actorId: undefined }))).toBeNull();
    expect(planActorPlace(payload({ actorId: "   " }))).toBeNull();
    expect(planActorPlace(payload({ actorId: 7 }))).toBeNull();
    expect(planActorPlace(payload({ actorId: "a".repeat(MAX_ACTOR_ID_LENGTH + 1) }))).toBeNull();
    expect(planActorPlace(payload({ actorId: "with\na newline" }))).toBeNull();
  });

  it("drops anything that is not an object", () => {
    expect(planActorPlace(null)).toBeNull();
    expect(planActorPlace("actor.place")).toBeNull();
    expect(planActorPlace([payload()])).toBeNull();
  });

  it("keeps a nameless payload — this world knows what the creature is called", () => {
    expect(planActorPlace(payload({ name: undefined }))?.name).toBeNull();
    expect(planActorPlace(payload({ name: "   " }))?.name).toBeNull();
    expect(planActorPlace(payload({ name: 12 }))?.name).toBeNull();
  });

  it("strips markup and caps the name — it is written into a toast, not rendered", () => {
    expect(planActorPlace(payload({ name: "<b>Bugbear</b>" }))?.name).toBe("Bugbear");
    expect(planActorPlace(payload({ name: "x".repeat(400) }))?.name?.length).toBe(MAX_PLACED_NAME_LENGTH);
  });

  it("plans a picture it will not decode as refused rather than as absent", () => {
    expect(planActorPlace(payload({ image: null }))?.image).toEqual({ status: "none" });
    expect(planActorPlace(payload({ image: { dataUrl: "javascript:alert(1)" } }))?.image.status).toBe("refused");
  });
});

// --------------------------------------------------------- the prototype token

describe("prototypeTokenData", () => {
  it("prefers toObject(), which is what a real PrototypeToken answers with", () => {
    const actor: PlaceableActor = {
      id: "a1",
      prototypeToken: {
        width: 2,
        toObject: () => ({ width: 2, height: 2, texture: { src: "systems/dnd5e/bugbear.webp" } }),
      },
    };
    expect(prototypeTokenData(actor)).toEqual({
      width: 2,
      height: 2,
      texture: { src: "systems/dnd5e/bugbear.webp" },
    });
  });

  it("copies rather than aliases, so nothing here can write to the actor's prototype", () => {
    const proto = { width: 2, texture: { src: "a.png" } };
    const data = prototypeTokenData({ id: "a1", prototypeToken: proto });
    data.width = 9;
    expect(proto.width).toBe(2);
  });

  it("reads a plain object, which is what several Foundry paths hand back", () => {
    expect(prototypeTokenData({ id: "a1", prototypeToken: { height: 3 } })).toEqual({ height: 3 });
  });

  it("falls back to the raw object when toObject throws, and to nothing at all when there is none", () => {
    const throws = {
      height: 3,
      toObject: () => {
        throw new Error("this document is being torn down");
      },
    };
    expect(prototypeTokenData({ id: "a1", prototypeToken: throws }).height).toBe(3);
    expect(prototypeTokenData({ id: "a1" })).toEqual({});
    expect(prototypeTokenData(null)).toEqual({});
    expect(prototypeTokenData({ id: "a1", prototypeToken: "bugbear.png" })).toEqual({});
    expect(prototypeTokenData({ id: "a1", prototypeToken: [1, 2] })).toEqual({});
  });
});

// ------------------------------------------------------------------- the map

describe("resolveCanvas", () => {
  it("picks the bare global, which is the only spelling Foundry has for it", () => {
    const canvas = { ready: true };
    expect(resolveCanvas({ canvas })).toBe(canvas);
  });

  it("answers null on a client with no canvas drawn yet", () => {
    expect(resolveCanvas({ canvas: null })).toBeNull();
    expect(resolveCanvas({})).toBeNull();
    expect(resolveCanvas(null)).toBeNull();
    expect(resolveCanvas("canvas")).toBeNull();
  });
});

describe("placementScene", () => {
  const scene = { id: "scene1", createEmbeddedDocuments: () => Promise.resolve([]) };

  it("is the scene THIS screen is showing", () => {
    expect(placementScene({ ready: true, scene })).toBe(scene);
    // `ready` absent is not `ready` false: a stub, and several boot paths.
    expect(placementScene({ scene })).toBe(scene);
  });

  it("refuses a canvas between scenes, or with nothing on it", () => {
    expect(placementScene({ ready: false, scene })).toBeNull();
    expect(placementScene({ ready: true, scene: null })).toBeNull();
    expect(placementScene({ ready: true })).toBeNull();
    expect(placementScene(null)).toBeNull();
  });

  it("refuses a scene document that cannot take an embedded token", () => {
    expect(placementScene({ ready: true, scene: { id: "scene1" } })).toBeNull();
  });
});

describe("gridSize", () => {
  it("asks the scene document first — it is the world's saved answer", () => {
    expect(gridSize({ grid: { size: 50 } }, { grid: { size: 140 } })).toBe(140);
  });

  it("falls back to the rendered grid, then to Foundry's own default", () => {
    expect(gridSize({ grid: { size: 50 } }, { grid: null })).toBe(50);
    expect(gridSize({}, {})).toBe(DEFAULT_GRID_SIZE);
    expect(gridSize(null, null)).toBe(DEFAULT_GRID_SIZE);
  });

  it("refuses a size that is not a positive number", () => {
    expect(gridSize({ grid: { size: 0 } }, { grid: { size: -1 } })).toBe(DEFAULT_GRID_SIZE);
    expect(gridSize({ grid: { size: Number.NaN } }, { grid: { size: "100" } })).toBe(DEFAULT_GRID_SIZE);
  });
});

describe("viewCenter", () => {
  it("is the stage pivot: exactly the point the keeper is looking at", () => {
    expect(viewCenter({ stage: { pivot: { x: 1420, y: 880 } } })).toEqual({ x: 1420, y: 880 });
  });

  it("falls back to the middle of the scene rectangle", () => {
    const canvas: CanvasLike = {
      stage: { pivot: null },
      dimensions: { sceneX: 100, sceneY: 200, sceneWidth: 1000, sceneHeight: 800 },
    };
    expect(viewCenter(canvas)).toEqual({ x: 600, y: 600 });
  });

  it("answers null rather than guessing an origin", () => {
    // A token placed at a guessed point is a token off the edge of the screen,
    // which is the silent failure this command must not have.
    expect(viewCenter({ stage: { pivot: { x: 10 } } })).toBeNull();
    expect(viewCenter({ dimensions: { sceneX: 0, sceneY: 0 } })).toBeNull();
    expect(viewCenter({})).toBeNull();
    expect(viewCenter(null)).toBeNull();
  });
});

describe("tokenFootprint / tokenPosition", () => {
  it("is one square for anything the prototype does not say", () => {
    expect(tokenFootprint({})).toEqual({ width: 1, height: 1 });
    expect(tokenFootprint({ width: 0, height: -2 })).toEqual({ width: 1, height: 1 });
    expect(tokenFootprint({ width: 2, height: 3 })).toEqual({ width: 2, height: 3 });
  });

  it("centres the creature on the view, corner-first as Foundry positions tokens", () => {
    expect(tokenPosition({ x: 1000, y: 1000 }, { width: 1, height: 1 }, 100)).toEqual({ x: 950, y: 950 });
    // A two-by-two ogre is offset by a whole square, not half of one.
    expect(tokenPosition({ x: 1000, y: 1000 }, { width: 2, height: 2 }, 100)).toEqual({ x: 900, y: 900 });
    expect(tokenPosition({ x: 1000, y: 1000 }, { width: 1, height: 3 }, 140)).toEqual({ x: 930, y: 790 });
  });

  it("rounds to whole pixels", () => {
    expect(tokenPosition({ x: 105.4, y: 105.4 }, { width: 1, height: 1 }, 75)).toEqual({ x: 68, y: 68 });
  });
});

// ------------------------------------------------------------- the token data

describe("placedTokenData", () => {
  const actor: PlaceableActor = { id: "Aq81xkP2mNvR3sTu", name: "Ash-Hollow Bugbear" };
  const proto = {
    name: "Bugbear",
    width: 2,
    height: 2,
    disposition: -1,
    actorLink: false,
    texture: { src: "systems/dnd5e/bugbear.webp", scaleX: 1.2 },
  };

  it("is the prototype, plus where it stands and who it is", () => {
    expect(placedTokenData(actor, { ...proto }, { x: 900, y: 900 }, null, null)).toEqual({
      ...proto,
      actorId: "Aq81xkP2mNvR3sTu",
      x: 900,
      y: 900,
    });
  });

  it("dresses THIS token in the picked variant, keeping the rest of the texture block", () => {
    const data = placedTokenData(actor, { ...proto }, { x: 0, y: 0 }, "masteroftales-tokens/variant.png", null);
    expect(data.texture).toEqual({ src: "masteroftales-tokens/variant.png", scaleX: 1.2 });
    // And the prototype it was built from is untouched.
    expect(proto.texture.src).toBe("systems/dnd5e/bugbear.webp");
  });

  it("drops an _id off the prototype, which would fail the whole create", () => {
    const data = placedTokenData(actor, { ...proto, _id: "notfree" }, { x: 0, y: 0 }, null, null);
    expect("_id" in data).toBe(false);
  });

  it("writes actorId last, so a stale one on the prototype cannot win", () => {
    const data = placedTokenData(actor, { actorId: "somebodyelse" }, { x: 0, y: 0 }, null, null);
    expect(data.actorId).toBe("Aq81xkP2mNvR3sTu");
  });

  it("names the token only when the prototype did not, and prefers this world's name", () => {
    expect(placedTokenData(actor, {}, { x: 0, y: 0 }, null, "What MoT calls it").name).toBe("Ash-Hollow Bugbear");
    expect(placedTokenData({ id: "a1" }, {}, { x: 0, y: 0 }, null, "What MoT calls it").name).toBe(
      "What MoT calls it",
    );
    expect("name" in placedTokenData({ id: "a1" }, {}, { x: 0, y: 0 }, null, null)).toBe(false);
    expect(placedTokenData(actor, { ...proto }, { x: 0, y: 0 }, null, "What MoT calls it").name).toBe("Bugbear");
  });

  it("carries NO origin flag — the token is a thing the table watched appear", () => {
    // The flag is an echo brake, and there is no echo here. A stamped token would
    // have its hit points and conditions dropped by capture for the rest of the
    // night, which is the opposite of what a monster on the map is for.
    const data = placedTokenData(actor, { ...proto }, { x: 0, y: 0 }, "masteroftales-tokens/variant.png", null);
    expect(data.flags).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(MODULE_ID);
  });
});

// --------------------------------------------------------------- the handler

interface HandlerOptions {
  isActive?: boolean;
  actor?: PlaceableActor | null;
  lookupThrows?: boolean;
  noCanvas?: boolean;
  noScene?: boolean;
  noPivot?: boolean;
  noFiles?: boolean;
  createRejects?: boolean;
  picker?: PickerOptions;
}

function table(options: HandlerOptions = {}) {
  const log = createLog();
  const picker = fakePicker(options.picker);
  const notices: Array<{ level: string; message: string }> = [];
  const placed: Array<{ embeddedName: string; data: Record<string, unknown>[] }> = [];

  const actor: PlaceableActor | null =
    options.actor === undefined
      ? {
          id: "Aq81xkP2mNvR3sTu",
          name: "Bugbear of the Ash Hollow",
          prototypeToken: {
            toObject: () => ({
              name: "Bugbear",
              width: 1,
              height: 1,
              texture: { src: "systems/dnd5e/bugbear.webp" },
            }),
          },
        }
      : options.actor;

  const scene = {
    id: "scene-kitchen",
    name: "The Kitchens",
    grid: { size: 100 },
    createEmbeddedDocuments: (embeddedName: string, data: Record<string, unknown>[]) => {
      if (options.createRejects) return Promise.reject(new Error("this scene is locked"));
      placed.push({ embeddedName, data });
      return Promise.resolve(data);
    },
  };

  const canvas: CanvasLike = {
    ready: true,
    scene: options.noScene ? null : scene,
    stage: options.noPivot ? { pivot: null } : { pivot: { x: 1000, y: 1000 } },
    grid: { size: 100 },
  };

  const handle = createActorPlaceHandler({
    isActive: () => options.isActive !== false,
    lookupActor: () => {
      if (options.lookupThrows) throw new Error("game.actors is not there yet");
      return actor;
    },
    canvas: () => (options.noCanvas ? null : canvas),
    files: () => (options.noFiles ? null : picker.api),
    notify: (level, message) => void notices.push({ level, message }),
    log,
  });

  return { handle, log, picker, notices, placed, actor, scene };
}

describe("createActorPlaceHandler", () => {
  it("uploads the picture and puts ONE token on the scene this screen is showing", async () => {
    const test = table();
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.picker.uploads[0]?.file.name).toBe("ash-hollow-bugbear.png");
    expect(test.placed).toHaveLength(1);
    expect(test.placed[0]?.embeddedName).toBe("Token");
    expect(test.placed[0]?.data).toEqual([
      {
        name: "Bugbear",
        width: 1,
        height: 1,
        texture: { src: "masteroftales-tokens/ash-hollow-bugbear.png" },
        actorId: "Aq81xkP2mNvR3sTu",
        x: 950,
        y: 950,
      },
    ]);
    expect(test.notices).toEqual([]);
    expect(test.log.lines.warn).toEqual([]);
  });

  it("leaves the ACTOR's own art exactly as the keeper set it", async () => {
    const test = table();
    test.handle(payload());
    await flushMicrotasks(20);

    const proto = (test.actor?.prototypeToken as { toObject(): Record<string, unknown> }).toObject();
    expect((proto.texture as { src: string }).src).toBe("systems/dnd5e/bugbear.webp");
  });

  it("places the prototype's own art when MoT sent no picture, and touches no file at all", async () => {
    const test = table();
    test.handle(payload({ image: null }));
    await flushMicrotasks(20);

    expect(test.picker.uploads).toEqual([]);
    expect(test.picker.browsed).toBe(0);
    expect(test.placed[0]?.data[0]?.texture).toEqual({ src: "systems/dnd5e/bugbear.webp" });
    expect(test.notices).toEqual([]);
  });

  it("says so and places nothing when this world does not have that creature", async () => {
    const test = table({ actor: null });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.placed).toEqual([]);
    expect(test.picker.uploads).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Ash-Hollow Bugbear", REASON_NO_ACTOR) },
    ]);
    expect(test.log.lines.warn).toHaveLength(1);
  });

  it("treats an actor with no id, and a lookup that throws, as a creature it does not have", async () => {
    const noId = table({ actor: { name: "Bugbear" } });
    noId.handle(payload());
    const throws = table({ lookupThrows: true });
    throws.handle(payload());
    await flushMicrotasks(20);

    expect(noId.placed).toEqual([]);
    expect(throws.placed).toEqual([]);
    expect(throws.notices[0]?.message).toBe(failureMessage("Ash-Hollow Bugbear", REASON_NO_ACTOR));
  });

  it("names the creature this world's way once it has found it", async () => {
    const test = table({ createRejects: true });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Bugbear of the Ash Hollow", REASON_PLACE_FAILED) },
    ]);
  });

  it("says so and places nothing when there is no scene up on this screen", async () => {
    const noCanvas = table({ noCanvas: true });
    noCanvas.handle(payload());
    const noScene = table({ noScene: true });
    noScene.handle(payload());
    await flushMicrotasks(20);

    for (const test of [noCanvas, noScene]) {
      expect(test.placed).toEqual([]);
      // Nothing was uploaded either: the scene is checked before a byte is written.
      expect(test.picker.uploads).toEqual([]);
      expect(test.notices).toEqual([
        { level: "error", message: failureMessage("Bugbear of the Ash Hollow", REASON_NO_SCENE) },
      ]);
    }
  });

  it("says so rather than placing a token somewhere off the keeper's screen", async () => {
    const test = table({ noPivot: true });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.placed).toEqual([]);
    expect(test.picker.uploads).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Bugbear of the Ash Hollow", REASON_NO_VIEW) },
    ]);
  });

  it("refuses the WHOLE command over a picture it will not decode", async () => {
    // The keeper picked a variant. Placing the default art instead would leave
    // them to notice the difference themselves.
    const test = table();
    test.handle(payload({ image: { dataUrl: "https://masteroftales.com/tokens/bugbear.png" } }));
    await flushMicrotasks(20);

    expect(test.placed).toEqual([]);
    expect(test.picker.uploads).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Ash-Hollow Bugbear", REASON_BAD_IMAGE) },
    ]);
    expect(test.log.lines.warn).toHaveLength(1);
  });

  it("places NOTHING when the upload fails, and says so on screen", async () => {
    const test = table({ picker: { uploadRejects: true } });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.placed).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Bugbear of the Ash Hollow", REASON_UPLOAD_FAILED) },
    ]);
  });

  it("names the missing Foundry class rather than failing silently", async () => {
    const test = table({ noFiles: true });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.placed).toEqual([]);
    expect(test.notices).toEqual([
      { level: "error", message: failureMessage("Bugbear of the Ash Hollow", REASON_NO_FILE_API) },
    ]);
  });

  it("does NOTHING on a client that is not the active GM", async () => {
    const test = table({ isActive: false });
    test.handle(payload());
    await flushMicrotasks(20);

    expect(test.picker.uploads).toEqual([]);
    expect(test.placed).toEqual([]);
    expect(test.notices).toEqual([]);
  });

  it("drops a payload with no actorId quietly — nobody at this table asked for it", async () => {
    const test = table();
    test.handle({ name: "Bugbear" });
    await flushMicrotasks(20);

    expect(test.placed).toEqual([]);
    expect(test.notices).toEqual([]);
    expect(test.log.lines.debug).toHaveLength(1);
  });

  it("never throws into the dispatcher, whatever the payload is", async () => {
    const test = table();
    expect(() => test.handle(null)).not.toThrow();
    expect(() => test.handle("actor.place")).not.toThrow();
    expect(() => test.handle({ actorId: "a1", image: { dataUrl: 7 } })).not.toThrow();
    await flushMicrotasks(20);
  });

  it("survives a Foundry whose notification bar is the thing that is broken", async () => {
    const log = createLog();
    const handle = createActorPlaceHandler({
      isActive: () => true,
      lookupActor: () => null,
      canvas: () => null,
      files: () => null,
      notify: () => {
        throw new Error("ui is not ready");
      },
      log,
    });

    expect(() => handle(payload())).not.toThrow();
    await flushMicrotasks(20);

    expect(log.lines.debug.some((line) => line.includes("could not show a notification"))).toBe(true);
  });

  it("falls back to a name when neither MoT nor this world had one", async () => {
    const test = table({ actor: null });
    test.handle(payload({ name: undefined }));
    await flushMicrotasks(20);

    expect(test.notices[0]?.message).toBe(failureMessage(FALLBACK_PLACED_NAME, REASON_NO_ACTOR));
  });
});

// ------------------------------------------------------------ the dispatcher

describe("the dispatcher's newest type", () => {
  it("routes actor.place to its handler, payload and all", () => {
    const onActorPlace = vi.fn();
    const dispatch = createDispatcher({ onSession: vi.fn(), onActorPlace });

    dispatch({ v: 1, type: "actor.place", ts: "x", payload: payload() });

    expect(onActorPlace).toHaveBeenCalledWith(payload());
  });

  it("treats it as unknown when nothing is wired — which is what 0.7.0 does with it", () => {
    // Rule 1 of the protocol, and the whole reason a module a version behind the
    // server loses a feature rather than a connection.
    const log = createLog();
    const dispatch = createDispatcher({ onSession: vi.fn(), log });

    dispatch({ v: 1, type: "actor.place", ts: "x", payload: payload() });

    expect(log.lines.warn).toEqual([]);
    expect(log.lines.debug).toHaveLength(1);
  });

  it("does not start a fight: nothing on this path touches encounter.deploy's handler", () => {
    const onEncounterDeploy = vi.fn();
    const onActorPlace = vi.fn();
    const dispatch = createDispatcher({ onSession: vi.fn(), onActorPlace, onEncounterDeploy });

    dispatch({ v: 1, type: "actor.place", ts: "x", payload: payload() });

    expect(onEncounterDeploy).not.toHaveBeenCalled();
  });
});
