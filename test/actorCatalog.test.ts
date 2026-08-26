import { describe, expect, it, vi } from "vitest";
import {
  absoluteAssetUrl,
  actorCatalogBody,
  collectActorCatalog,
  MAX_ACTOR_NAME_LENGTH,
  MAX_ACTOR_PATH_LENGTH,
  MAX_ACTOR_TYPE_LENGTH,
  MAX_CATALOG_ACTORS,
  resolveAssetBase,
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

/**
 * Where this pretend Foundry lives, and therefore where its pictures do.
 *
 * Every catalog call passes one, because the wire's `img` is an absolute URL
 * now: the browser that renders it is pointed at masteroftales.com and would
 * resolve `icons/goblin.webp` against *that* host — the bug this argument
 * exists to fix.
 */
const BASE = "https://foundry.example/";

/** The same install behind a reverse proxy at a route prefix. */
const ROUTED = "https://home.example/foundry/";

/** The absolutized portrait `actor()` has, spelled once. */
const GOBLIN_IMG = "https://foundry.example/icons/goblin.webp";

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
  it("reads the ordinary case, with the portrait made absolute", () => {
    expect(collectActorCatalog([actor()], BASE)).toEqual([
      { id: "a1", name: "Goblin", img: GOBLIN_IMG, type: "npc" },
    ]);
  });

  it("walks a Foundry collection, which is a Map subclass rather than an array", () => {
    // Spreading one yields `[id, doc]` pairs; `.contents` is the array accessor.
    const collection = new FakeCollection([
      { id: "a1", name: "Goblin" },
      { id: "a2", name: "Bugbear" },
    ]);
    expect(collectActorCatalog(collection, BASE).map((row) => row.name)).toEqual(["Goblin", "Bugbear"]);
  });

  it("falls a nameless actor back to its id, so a picker row still says something", () => {
    expect(collectActorCatalog([actor({ name: null })], BASE)[0]?.name).toBe("a1");
    expect(collectActorCatalog([actor({ name: "   " })], BASE)[0]?.name).toBe("a1");
    expect(collectActorCatalog([actor({ name: 7 })], BASE)[0]?.name).toBe("a1");
  });

  it("nulls an absent image and an absent type rather than inventing either", () => {
    expect(collectActorCatalog([actor({ img: null, type: undefined })], BASE)[0]).toEqual({
      id: "a1",
      name: "Goblin",
      img: null,
      type: null,
    });
  });

  it("drops an actor with no usable id — a row that cannot be pointed at is worse than none", () => {
    expect(collectActorCatalog([actor({ id: null }), actor({ id: "  " }), actor({ id: 7 })], BASE)).toEqual([]);
  });

  it("survives junk in the collection", () => {
    expect(collectActorCatalog([null, undefined, "goblin", 7, actor()], BASE)).toHaveLength(1);
  });

  it("is empty for anything that is not a collection at all", () => {
    for (const bad of [null, undefined, 7, "actors", {}]) {
      expect(collectActorCatalog(bad, BASE)).toEqual([]);
    }
  });

  it("truncates a long name — a shortened name is still true", () => {
    const row = collectActorCatalog([actor({ name: "G".repeat(400) })], BASE)[0];
    expect(row?.name).toHaveLength(MAX_ACTOR_NAME_LENGTH);
  });

  it("DROPS a long image path rather than truncating it into a different path", () => {
    // Truncation here would ask the browser for a file that does not exist and
    // draw a broken image where a portrait belongs. Absent over wrong. The cap
    // is against the *reported* URL, so the origin counts towards it.
    const long = `icons/${"a".repeat(MAX_ACTOR_PATH_LENGTH)}.webp`;
    expect(collectActorCatalog([actor({ img: long })], BASE)[0]?.img).toBeNull();
    expect(collectActorCatalog([actor({ type: "t".repeat(MAX_ACTOR_TYPE_LENGTH + 1) })], BASE)[0]?.type).toBeNull();
  });

  it("keeps a path that only the origin would have pushed over the old 500-character cap", () => {
    // The reason the cap moved: this is a portrait 0.6.0 sent and a naive
    // absolutizing would have started dropping.
    const path = `icons/${"a".repeat(480)}.webp`;
    expect(collectActorCatalog([actor({ img: path })], BASE)[0]?.img).toBe(`${BASE}${path}`);
  });

  it("resolves against the route prefix, because a proxied Foundry serves its art under one", () => {
    expect(collectActorCatalog([actor()], ROUTED)[0]?.img).toBe("https://home.example/foundry/icons/goblin.webp");
  });

  it("reports no portrait at all on a client that could not say where it lives", () => {
    // A relative path here is not a worse URL — it is one that resolves against
    // masteroftales.com and draws a broken square. Absent over wrong.
    expect(collectActorCatalog([actor()], null)[0]?.img).toBeNull();
  });

  it("passes an already-absolute portrait through untouched", () => {
    const url = "https://cdn.example/portraits/goblin.webp";
    expect(collectActorCatalog([actor({ img: url })], BASE)[0]?.img).toBe(url);
  });

  it("caps the catalog", () => {
    const actors = Array.from({ length: MAX_CATALOG_ACTORS + 40 }, (_, index) =>
      actor({ id: `a${index}`, name: `Actor ${index}` }),
    );
    const catalog = collectActorCatalog(actors, BASE);

    expect(catalog).toHaveLength(MAX_CATALOG_ACTORS);
    expect(catalog[0]?.id).toBe("a0");
    expect(catalog.at(-1)?.id).toBe(`a${MAX_CATALOG_ACTORS - 1}`);
  });

  it("carries no user, member or role id — the wire never does", () => {
    const row = collectActorCatalog(
      [actor({ ownership: { gm1: 3, p1: 2 }, hasPlayerOwner: true, system: { attributes: { hp: { value: 7 } } } })],
      BASE,
    )[0];
    expect(Object.keys(row ?? {}).sort()).toEqual(["id", "img", "name", "type"]);
  });
});

// ------------------------------------------------------------- the addresses

describe("absoluteAssetUrl", () => {
  it("resolves a Foundry world path against this client's own address", () => {
    expect(absoluteAssetUrl("worlds/barovia/tokens/ireena.png", BASE)).toBe(
      "https://foundry.example/worlds/barovia/tokens/ireena.png",
    );
  });

  it("carries the route prefix, which a bare origin would drop on the floor", () => {
    expect(absoluteAssetUrl("icons/goblin.webp", ROUTED)).toBe("https://home.example/foundry/icons/goblin.webp");
  });

  it("resolves a leading-slash path against the origin, prefix and all", () => {
    // Foundry writes these too, and they are absolute *paths*, not URLs.
    expect(absoluteAssetUrl("/icons/goblin.webp", ROUTED)).toBe("https://home.example/icons/goblin.webp");
  });

  it("percent-encodes a space rather than shipping a URL with one in it", () => {
    expect(absoluteAssetUrl("tokens/old man.webp", BASE)).toBe("https://foundry.example/tokens/old%20man.webp");
  });

  it("passes anything already carrying a scheme through untouched", () => {
    for (const url of [
      "https://cdn.example/goblin.webp",
      "http://192.168.1.9:30000/icons/goblin.webp",
      "data:image/png;base64,iVBORw0KGgo=",
    ]) {
      expect(absoluteAssetUrl(url, BASE)).toBe(url);
    }
  });

  it("keeps null null", () => {
    expect(absoluteAssetUrl(null, BASE)).toBeNull();
    expect(absoluteAssetUrl(null, null)).toBeNull();
  });

  it("returns null for a relative path when this client has no address", () => {
    expect(absoluteAssetUrl("icons/goblin.webp", null)).toBeNull();
  });

  it("refuses control characters, which `URL` strips before the scheme is ever checked", () => {
    expect(absoluteAssetUrl("icons/gob\nlin.webp", BASE)).toBeNull();
    expect(absoluteAssetUrl("java\tscript:alert(1)", BASE)).toBeNull();
  });
});

describe("resolveAssetBase", () => {
  it("asks Foundry's own router, which is the thing that knows about route prefixes", () => {
    const scope = {
      location: { origin: "https://home.example", href: "https://home.example/foundry/game" },
      foundry: { utils: { getRoute: (path: string) => `/foundry${path}` } },
    };
    expect(resolveAssetBase(scope)).toBe("https://home.example/foundry/");
  });

  it("is the bare origin on an install with no prefix", () => {
    const scope = {
      location: { origin: "https://foundry.example", href: "https://foundry.example/game" },
      foundry: { utils: { getRoute: (path: string) => path } },
    };
    expect(resolveAssetBase(scope)).toBe("https://foundry.example/");
  });

  it("falls back to the ROUTE_PREFIX global when the helper is not there", () => {
    expect(
      resolveAssetBase({ location: { origin: "https://home.example" }, ROUTE_PREFIX: "foundry" }),
    ).toBe("https://home.example/foundry/");
    expect(resolveAssetBase({ location: { origin: "https://home.example" } })).toBe("https://home.example/");
  });

  it("falls back to the ROUTE_PREFIX global when the helper throws", () => {
    const scope = {
      location: { origin: "https://home.example" },
      foundry: {
        utils: {
          getRoute: () => {
            throw new Error("not this client");
          },
        },
      },
      ROUTE_PREFIX: "vtt",
    };
    expect(resolveAssetBase(scope)).toBe("https://home.example/vtt/");
  });

  it("reads the origin off `href` on a client that has only that", () => {
    expect(resolveAssetBase({ location: { href: "https://home.example:30000/game?x=1" } })).toBe(
      "https://home.example:30000/",
    );
  });

  it("is null when there is no usable location — a harness, or a client mid-teardown", () => {
    for (const scope of [null, undefined, 7, "window", {}, { location: null }, { location: { origin: "  " } }]) {
      expect(resolveAssetBase(scope)).toBeNull();
    }
  });
});

describe("actorCatalogBody", () => {
  it("builds the POST body as a value", () => {
    expect(actorCatalogBody([actor()], bridgeInfo(), BASE)).toEqual({
      bridge: bridgeInfo(),
      actors: [{ id: "a1", name: "Goblin", img: GOBLIN_IMG, type: "npc" }],
    });
  });

  it("still names the world when there is not an actor in it", () => {
    expect(actorCatalogBody([], bridgeInfo(), BASE)).toEqual({ bridge: bridgeInfo(), actors: [] });
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
    assetBase: () => BASE,
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
      { bridge: bridgeInfo(), actors: [{ id: "a1", name: "Goblin", img: GOBLIN_IMG, type: "npc" }] },
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
