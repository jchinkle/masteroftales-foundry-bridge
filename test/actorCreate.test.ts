import { describe, expect, it, vi } from "vitest";
import {
  actorCreateData,
  actorTypeNames,
  createActorCreateHandler,
  defaultActorType,
  FALLBACK_ACTOR_NAME,
  failureMessage,
  MAX_ACTOR_NAME_LENGTH,
  MAX_KEY_LENGTH,
  planActorCreate,
  REASON_CREATE_FAILED,
  REASON_NO_ACTOR_API,
  resolveActorApi,
  unreportedMessage,
} from "../src/commands/actorCreate.js";
import { createDispatcher } from "../src/commands/index.js";
import {
  REASON_BAD_IMAGE,
  REASON_NO_FILE_API,
  REASON_UPLOAD_FAILED,
} from "../src/commands/tokenImages.js";
import type { ActorCreationBody } from "../src/protocol/actors.js";
import { actorCreationBody } from "../src/protocol/actors.js";
import type { PickerOptions } from "./stubs.js";
import { createLog, fakePicker, flushMicrotasks, PNG_BASE64, PNG_DATA_URL } from "./stubs.js";

/**
 * `actor.create`, minus the picture pipeline it shares with `actor.place` — that
 * lives in test/tokenImages.test.ts. What is tested here is the actor: the plan,
 * the type the creature is created as, the `Actor.create` argument, and the
 * handler's promise that a failure creates nothing and reports nothing.
 */

/** An `actor.create` payload as MoT broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "req-7f3a",
    name: "Ash-Hollow Bugbear",
    image: { dataUrl: PNG_DATA_URL, filename: "ash-hollow-bugbear.png" },
    ...overrides,
  };
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
    });
  });

  it("writes neither field with no picture, so Foundry's own placeholder stands", () => {
    const data = actorCreateData("Bugbear", "npc", null);
    expect(data).toEqual({ name: "Bugbear", type: "npc" });
    expect("img" in data).toBe(false);
    expect("prototypeToken" in data).toBe(false);
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
      { name: "Ash-Hollow Bugbear", type: "npc" },
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
