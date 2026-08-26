import { describe, expect, it, vi } from "vitest";
import {
  actorCatalogBody,
  collectActorCatalog,
  MAX_ACTOR_NAME_LENGTH,
  MAX_ACTOR_PATH_LENGTH,
  MAX_ACTOR_TYPE_LENGTH,
  MAX_CATALOG_ACTORS,
} from "../src/protocol/actors.js";
import { createActorsRequestHandler } from "../src/commands/encounters.js";
import { createDispatcher } from "../src/commands/index.js";
import type { BridgeInfo } from "../src/protocol/types.js";
import { createLog, FakeCollection, flushMicrotasks } from "./stubs.js";

/**
 * An actor as `game.actors` hands one over — a plain source object, which is
 * both the honest hard case and what several Foundry paths really produce.
 */
function actor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "a1", uuid: "Actor.a1", name: "Goblin", img: "icons/goblin.webp", type: "npc", ...overrides };
}

/** The identity block every batch and heartbeat already carries. */
function bridgeInfo(): BridgeInfo {
  return {
    world: "curse-of-strahd",
    foundry: "13.346",
    system: { id: "dnd5e", version: "5.0.2" },
    module: "0.6.0",
    users: [{ id: "gm1", name: "Jeremy", active: true, gm: true }],
  };
}

// -------------------------------------------------------------- the catalog

describe("collectActorCatalog", () => {
  it("reads the ordinary case", () => {
    expect(collectActorCatalog([actor()])).toEqual([
      { id: "a1", name: "Goblin", img: "icons/goblin.webp", type: "npc" },
    ]);
  });

  it("walks a Foundry collection, which is a Map subclass rather than an array", () => {
    // Spreading one yields `[id, doc]` pairs; `.contents` is the array accessor.
    const collection = new FakeCollection([
      { id: "a1", name: "Goblin" },
      { id: "a2", name: "Bugbear" },
    ]);
    expect(collectActorCatalog(collection).map((row) => row.name)).toEqual(["Goblin", "Bugbear"]);
  });

  it("falls a nameless actor back to its id, so a picker row still says something", () => {
    expect(collectActorCatalog([actor({ name: null })])[0]?.name).toBe("a1");
    expect(collectActorCatalog([actor({ name: "   " })])[0]?.name).toBe("a1");
    expect(collectActorCatalog([actor({ name: 7 })])[0]?.name).toBe("a1");
  });

  it("nulls an absent image and an absent type rather than inventing either", () => {
    expect(collectActorCatalog([actor({ img: null, type: undefined })])[0]).toEqual({
      id: "a1",
      name: "Goblin",
      img: null,
      type: null,
    });
  });

  it("drops an actor with no usable id — a row that cannot be pointed at is worse than none", () => {
    expect(collectActorCatalog([actor({ id: null }), actor({ id: "  " }), actor({ id: 7 })])).toEqual([]);
  });

  it("survives junk in the collection", () => {
    expect(collectActorCatalog([null, undefined, "goblin", 7, actor()])).toHaveLength(1);
  });

  it("is empty for anything that is not a collection at all", () => {
    for (const bad of [null, undefined, 7, "actors", {}]) {
      expect(collectActorCatalog(bad)).toEqual([]);
    }
  });

  it("truncates a long name — a shortened name is still true", () => {
    const row = collectActorCatalog([actor({ name: "G".repeat(400) })])[0];
    expect(row?.name).toHaveLength(MAX_ACTOR_NAME_LENGTH);
  });

  it("DROPS a long image path rather than truncating it into a different path", () => {
    // Truncation here would ask the browser for a file that does not exist and
    // draw a broken image where a portrait belongs. Absent over wrong.
    const long = `icons/${"a".repeat(MAX_ACTOR_PATH_LENGTH)}.webp`;
    expect(collectActorCatalog([actor({ img: long })])[0]?.img).toBeNull();
    expect(collectActorCatalog([actor({ type: "t".repeat(MAX_ACTOR_TYPE_LENGTH + 1) })])[0]?.type).toBeNull();
  });

  it("caps the catalog", () => {
    const actors = Array.from({ length: MAX_CATALOG_ACTORS + 40 }, (_, index) =>
      actor({ id: `a${index}`, name: `Actor ${index}` }),
    );
    const catalog = collectActorCatalog(actors);

    expect(catalog).toHaveLength(MAX_CATALOG_ACTORS);
    expect(catalog[0]?.id).toBe("a0");
    expect(catalog.at(-1)?.id).toBe(`a${MAX_CATALOG_ACTORS - 1}`);
  });

  it("carries no user, member or role id — the wire never does", () => {
    const row = collectActorCatalog([
      actor({ ownership: { gm1: 3, p1: 2 }, hasPlayerOwner: true, system: { attributes: { hp: { value: 7 } } } }),
    ])[0];
    expect(Object.keys(row ?? {}).sort()).toEqual(["id", "img", "name", "type"]);
  });
});

describe("actorCatalogBody", () => {
  it("builds the POST body as a value", () => {
    expect(actorCatalogBody([actor()], bridgeInfo())).toEqual({
      bridge: bridgeInfo(),
      actors: [{ id: "a1", name: "Goblin", img: "icons/goblin.webp", type: "npc" }],
    });
  });

  it("still names the world when there is not an actor in it", () => {
    expect(actorCatalogBody([], bridgeInfo())).toEqual({ bridge: bridgeInfo(), actors: [] });
  });
});

// -------------------------------------------------------------- the handler

interface HandlerOptions {
  isActive?: boolean;
  actors?: unknown;
  postRejects?: boolean;
  bridgeInfoThrows?: boolean;
}

function handler(options: HandlerOptions = {}) {
  const log = createLog();
  const posted: unknown[] = [];

  const handle = createActorsRequestHandler({
    isActive: () => options.isActive !== false,
    actors: () => options.actors ?? [actor()],
    bridgeInfo: () => {
      if (options.bridgeInfoThrows) throw new Error("game is gone");
      return bridgeInfo();
    },
    post: (body) => {
      posted.push(body);
      return options.postRejects ? Promise.reject(new Error("network is down")) : Promise.resolve(undefined);
    },
    log,
  });

  return { handle, posted, log };
}

describe("createActorsRequestHandler", () => {
  it("posts the catalog", async () => {
    const table = handler();
    table.handle({});
    await flushMicrotasks();

    expect(table.posted).toEqual([
      { bridge: bridgeInfo(), actors: [{ id: "a1", name: "Goblin", img: "icons/goblin.webp", type: "npc" }] },
    ]);
    expect(table.log.lines.warn).toEqual([]);
  });

  it("ignores the payload entirely — it is a doorbell, not an argument list", async () => {
    const table = handler();
    for (const payload of [undefined, null, {}, { search: "gob" }, "nonsense", 7, []]) {
      table.handle(payload);
    }
    await flushMicrotasks();

    expect(table.posted).toHaveLength(7);
    expect(new Set(table.posted.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it("does nothing at all on a client that is not the active GM", async () => {
    // Two GMs each posting five hundred rows for one request would be two writes
    // of the same list — and only one browser holds the token anyway.
    const table = handler({ isActive: false });
    table.handle({});
    await flushMicrotasks();

    expect(table.posted).toEqual([]);
  });

  it("warns rather than throwing when the POST fails", async () => {
    const table = handler({ postRejects: true });
    expect(() => table.handle({})).not.toThrow();
    await flushMicrotasks();

    expect(table.log.lines.warn).toHaveLength(1);
    expect(table.log.lines.warn.join(" ")).toMatch(/could not send the actor catalog/);
  });

  it("drops calmly on a client mid-teardown, where `game` has gone", async () => {
    const table = handler({ bridgeInfoThrows: true });
    table.handle({});
    await flushMicrotasks();

    expect(table.posted).toEqual([]);
    expect(table.log.lines.debug).toHaveLength(1);
  });
});

// ------------------------------------------------------------ the dispatcher

describe("actors.request through the dispatcher", () => {
  it("routes to the handler", async () => {
    const table = handler();
    const dispatch = createDispatcher({ onSession: vi.fn(), onActorsRequest: table.handle });

    dispatch({ v: 1, type: "actors.request", ts: "2026-08-25T20:00:00.000Z", payload: {} });
    await flushMicrotasks();

    expect(table.posted).toHaveLength(1);
  });

  it("treats actors.request with no handler wired as an unknown type rather than a fault", () => {
    // Rule 1, unchanged: a module a version ahead of the server loses a feature,
    // not the connection.
    const log = createLog();
    const dispatch = createDispatcher({ onSession: vi.fn(), log });

    dispatch({ v: 1, type: "actors.request", ts: "2026-08-25T20:00:00.000Z", payload: {} });

    expect(log.lines.debug).toEqual(['[masteroftales-bridge] no renderer wired for "actors.request"']);
  });
});
