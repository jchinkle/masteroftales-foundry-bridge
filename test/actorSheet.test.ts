import { describe, expect, it, vi } from "vitest";
import { selectAdapter } from "../src/adapters/index.js";
import {
  createActorSheetHandler,
  failureMessage,
  MAX_HANDLE_LENGTH,
  planActorSheetRequest,
  REASON_NO_ACTOR,
  REASON_REPORT_FAILED,
  REASON_TOO_LARGE,
} from "../src/commands/actorSheet.js";
import { createDispatcher } from "../src/commands/index.js";
import type { ActorSheetBody, ActorSheetFailure } from "../src/protocol/actorSheet.js";
import {
  actorSheetBody,
  actorSheetFailure,
  collectSheetItems,
  MAX_REASON_LENGTH,
  MAX_SHEET_BYTES,
  MAX_SHEET_ITEMS,
  readSheetSource,
  sheetBodyBytes,
  trimSheetBody,
} from "../src/protocol/actorSheet.js";
import { createLog, flushMicrotasks } from "./stubs.js";

/**
 * `actor.sheet.request` — one creature's sheet, on its way to a statblock in
 * Master of Tales (#81 stage 2).
 *
 * Every creature here is invented for the test; nothing is copied from a
 * published bestiary.
 */

const DND5E_ITEM_TYPES = selectAdapter("dnd5e").sheetItemTypes();

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: "9f2c4a1b", actorId: "aBcD1234", ...overrides };
}

/** A dnd5e-shaped actor, cut down to the parts a statblock reads. */
function marshGoblin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Marsh Goblin Scout",
    system: {
      abilities: { str: { value: 8 }, dex: { value: 14 } },
      attributes: { hp: { value: 7, max: 7, formula: "2d6" } },
    },
    items: [
      { _id: "i1", name: "Scimitar", type: "weapon", sort: 100_000, system: { damage: {} } },
      { _id: "i2", name: "Nimble Escape", type: "feat", sort: 200_000, system: {} },
      { _id: "i3", name: "Rations", type: "consumable", sort: 300_000, system: {} },
    ],
    ...overrides,
  };
}

// ------------------------------------------------------------------ the plan

describe("planActorSheetRequest", () => {
  it("reads the ordinary case", () => {
    expect(planActorSheetRequest(payload())).toEqual({ requestId: "9f2c4a1b", actorId: "aBcD1234" });
  });

  it("echoes the request id verbatim, whatever it looks like — it is opaque", () => {
    const shaped = planActorSheetRequest(payload({ requestId: "  not-a-uuid::7  " }));
    expect(shaped?.requestId).toBe("not-a-uuid::7");
  });

  it("drops a request missing either id — both are load-bearing", () => {
    expect(planActorSheetRequest(payload({ requestId: undefined }))).toBeNull();
    expect(planActorSheetRequest(payload({ actorId: "" }))).toBeNull();
  });

  it("drops a handle with a control character in it — this string goes back on the wire", () => {
    expect(planActorSheetRequest(payload({ requestId: "9f2c\n4a1b" }))).toBeNull();
  });

  it("drops a handle longer than the cap", () => {
    expect(planActorSheetRequest(payload({ actorId: "a".repeat(MAX_HANDLE_LENGTH + 1) }))).toBeNull();
  });

  it("drops anything that is not an object", () => {
    for (const value of [null, undefined, "aBcD1234", 7, [payload()]]) {
      expect(planActorSheetRequest(value)).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ the body

describe("readSheetSource", () => {
  it("prefers the live data model, because a statblock is made of derived numbers", () => {
    const actor = {
      name: "Marsh Goblin Scout",
      // What a keeper typed lives in the source; what a statblock reads —
      // the derived armour class — lives only on the prepared model.
      system: { attributes: { ac: { calc: "natural", flat: 15, value: 15 } } },
      items: [],
      toObject: () => ({ system: { attributes: { ac: { calc: "natural", flat: 15 } } } }),
    };

    expect(readSheetSource(actor)?.system).toEqual({
      attributes: { ac: { calc: "natural", flat: 15, value: 15 } },
    });
  });

  it("falls back to source data for a model that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = { attributes: {} };
    cyclic.self = cyclic;

    const actor = {
      name: "Ouroboros",
      system: cyclic,
      toObject: () => ({ system: { attributes: { hp: { value: 7 } } } }),
    };

    expect(readSheetSource(actor)?.system).toEqual({ attributes: { hp: { value: 7 } } });
  });

  it("hands back copies, never the world's own objects", () => {
    const actor = marshGoblin();
    const read = readSheetSource(actor);

    read!.system.abilities = "edited";
    expect((actor.system as Record<string, unknown>).abilities).not.toBe("edited");
  });

  it("is an empty sheet rather than a throw when nothing can be read at all", () => {
    expect(readSheetSource({})).toEqual({ name: null, system: {}, items: undefined });
  });

  it("is null for anything that is not an object", () => {
    expect(readSheetSource(null)).toBeNull();
    expect(readSheetSource("aBcD1234")).toBeNull();
  });
});

describe("collectSheetItems", () => {
  it("keeps only the types the adapter shortlisted, with the four fields that travel", () => {
    const items = collectSheetItems(marshGoblin().items, DND5E_ITEM_TYPES);

    expect(items.map((item) => item.name)).toEqual(["Scimitar", "Nimble Escape"]);
    expect(items[0]).toEqual({
      name: "Scimitar",
      type: "weapon",
      sort: 100_000,
      system: { damage: {} },
    });
  });

  it("keeps everything when the adapter shortlists nothing — a system we do not know", () => {
    const items = collectSheetItems(marshGoblin().items, selectAdapter("swade").sheetItemTypes());
    expect(items).toHaveLength(3);
  });

  it("falls back to the id for an item with no usable name", () => {
    const items = collectSheetItems([{ _id: "i9", name: "   ", type: "feat" }], DND5E_ITEM_TYPES);
    expect(items[0]?.name).toBe("i9");
  });

  it("caps the count, so a feature list cannot arrive as a sheet", () => {
    const many = Array.from({ length: MAX_SHEET_ITEMS + 40 }, (_unused, index) => ({
      _id: `s${index}`,
      name: `Feature ${index}`,
      type: "feat",
      system: {},
    }));

    expect(collectSheetItems(many, DND5E_ITEM_TYPES)).toHaveLength(MAX_SHEET_ITEMS);
  });
});

describe("actorSheetBody", () => {
  const context = {
    requestId: "9f2c4a1b",
    actorId: "aBcD1234",
    systemId: "dnd5e",
    itemTypes: DND5E_ITEM_TYPES,
  };

  it("is the pinned wire shape", () => {
    expect(actorSheetBody(readSheetSource(marshGoblin())!, context)).toEqual({
      requestId: "9f2c4a1b",
      actorId: "aBcD1234",
      name: "Marsh Goblin Scout",
      foundrySystemId: "dnd5e",
      system: {
        abilities: { str: { value: 8 }, dex: { value: 14 } },
        attributes: { hp: { value: 7, max: 7, formula: "2d6" } },
      },
      items: [
        { name: "Scimitar", type: "weapon", sort: 100_000, system: { damage: {} } },
        { name: "Nimble Escape", type: "feat", sort: 200_000, system: {} },
      ],
      truncated: false,
    });
  });

  it("carries no user, member or role id — the wall the whole bridge wire keeps", () => {
    const body = actorSheetBody(
      readSheetSource({ ...marshGoblin(), ownership: { default: 0, "user-1": 3 } })!,
      context,
    );

    expect(Object.keys(body).sort()).toEqual([
      "actorId",
      "foundrySystemId",
      "items",
      "name",
      "requestId",
      "system",
      "truncated",
    ]);
  });

  it("falls back to the actor id for a creature with no name", () => {
    expect(actorSheetBody({ name: null, system: {}, items: [] }, context).name).toBe("aBcD1234");
  });

  it("never hands back a live reference into the world's own documents", () => {
    const actor = marshGoblin();
    const body = actorSheetBody(readSheetSource(actor)!, context);

    body.items[0]!.system.damage = "edited";
    const original = (actor.items as Record<string, unknown>[])[0]!;
    expect((original.system as Record<string, unknown>).damage).not.toBe("edited");
  });
});

describe("actorSheetFailure", () => {
  it("is the pinned refusal shape — three fields, and no empty sheet beside them", () => {
    expect(actorSheetFailure("9f2c4a1b", "aBcD1234", "  that creature is not in this world.  ")).toEqual({
      requestId: "9f2c4a1b",
      actorId: "aBcD1234",
      error: "that creature is not in this world.",
    });
  });

  it("caps a reason, which is one clause and is shown to a person", () => {
    const long = actorSheetFailure("r", "a", "why ".repeat(200));
    expect(long.error.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
  });
});

describe("sheetBodyBytes", () => {
  it("measures what actually goes on the wire, in bytes rather than characters", () => {
    const body = actorSheetBody(readSheetSource({ name: "Sé", system: {}, items: [] })!, {
      requestId: "r",
      actorId: "a",
      systemId: "dnd5e",
      itemTypes: DND5E_ITEM_TYPES,
    });

    expect(sheetBodyBytes(body)).toBe(new TextEncoder().encode(JSON.stringify(body)).length);
  });
});

describe("trimSheetBody", () => {
  function heavy(count: number, descriptionLength: number): ActorSheetBody {
    return {
      requestId: "9f2c4a1b",
      actorId: "aBcD1234",
      name: "Ash-Hollow Bugbear",
      foundrySystemId: "dnd5e",
      system: {},
      items: Array.from({ length: count }, (_unused, index) => ({
        name: `Feature ${index}`,
        type: "feat",
        sort: index,
        system: { description: { value: "x".repeat(descriptionLength), chat: "" } },
      })),
      truncated: false,
    };
  }

  it("leaves a body inside the budget exactly as it was", () => {
    const body = trimSheetBody(heavy(3, 100));

    expect(body.truncated).toBe(false);
    expect(body.items[0]?.system.description).toEqual({ value: "x".repeat(100), chat: "" });
  });

  it("blanks descriptions before it drops items, and flags the loss", () => {
    const body = trimSheetBody(heavy(40, 20_000));

    expect(body.truncated).toBe(true);
    // Every entry is still there with its name and its structure: the prose is
    // the cheap half, and a keeper can retype a sentence far more easily than
    // they can retype a creature.
    expect(body.items).toHaveLength(40);
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(MAX_SHEET_BYTES);
  });

  it("drops whole items only when blanking was not enough", () => {
    const body = trimSheetBody({
      ...heavy(2, 0),
      items: Array.from({ length: 40 }, (_unused, index) => ({
        name: `Feature ${index}`,
        type: "feat",
        sort: index,
        // No description to blank: structured data all the way down.
        system: { parts: Array.from({ length: 900 }, () => "1d6 + @mod") },
      })),
    });

    expect(body.truncated).toBe(true);
    expect(body.items.length).toBeLessThan(40);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(MAX_SHEET_BYTES);
  });
});

// ----------------------------------------------------------------- the handler

describe("createActorSheetHandler", () => {
  function deps(overrides: Record<string, unknown> = {}) {
    return {
      isActive: () => true,
      lookupActor: vi.fn(() => marshGoblin()),
      systemId: () => "dnd5e",
      itemTypes: () => DND5E_ITEM_TYPES,
      report: vi.fn((_body: ActorSheetBody | ActorSheetFailure) => Promise.resolve()),
      notify: vi.fn(),
      log: createLog(),
      ...overrides,
    };
  }

  it("reports the sheet for the actor MoT named", async () => {
    const wired = deps();
    createActorSheetHandler(wired)(payload());
    await flushMicrotasks();

    expect(wired.lookupActor).toHaveBeenCalledWith("aBcD1234");
    expect(wired.report).toHaveBeenCalledTimes(1);
    expect(wired.report.mock.calls[0]?.[0]).toMatchObject({
      requestId: "9f2c4a1b",
      actorId: "aBcD1234",
      name: "Marsh Goblin Scout",
      foundrySystemId: "dnd5e",
    });
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it("does nothing at all on a client that is not the active GM", async () => {
    const wired = deps({ isActive: () => false });
    createActorSheetHandler(wired)(payload());
    await flushMicrotasks();

    expect(wired.lookupActor).not.toHaveBeenCalled();
    expect(wired.report).not.toHaveBeenCalled();
  });

  /**
   * The keeper is watching a dialog in Master of Tales, not this console. A
   * toast alone would leave that dialog spinning for twelve seconds and then
   * shrugging, so the reason travels home as well.
   */
  it("posts a refusal home, and toasts, when the creature has gone", async () => {
    const wired = deps({ lookupActor: vi.fn(() => null) });
    createActorSheetHandler(wired)(payload());
    await flushMicrotasks();

    expect(wired.notify).toHaveBeenCalledWith("error", failureMessage(REASON_NO_ACTOR));
    expect(wired.report).toHaveBeenCalledTimes(1);
    expect(wired.report.mock.calls[0]?.[0]).toEqual({
      requestId: "9f2c4a1b",
      actorId: "aBcD1234",
      error: REASON_NO_ACTOR,
    });
  });

  /**
   * The trimmer takes descriptions and then whole items; a `system` object
   * alone over the cap is the one sheet it cannot save. Posting it anyway would
   * be a server refusal MoT could only report as a timeout.
   */
  it("posts a refusal rather than a body it knows is oversized", async () => {
    const huge = {
      name: "The Thing In The Well",
      system: { lore: "x".repeat(MAX_SHEET_BYTES + 1_000) },
      items: [],
    };
    const wired = deps({ lookupActor: vi.fn(() => huge) });

    createActorSheetHandler(wired)(payload());
    await flushMicrotasks();

    expect(wired.report).toHaveBeenCalledTimes(1);
    expect(wired.report.mock.calls[0]?.[0]).toEqual({
      requestId: "9f2c4a1b",
      actorId: "aBcD1234",
      error: REASON_TOO_LARGE,
    });
    expect(wired.notify).toHaveBeenCalledWith("error", failureMessage(REASON_TOO_LARGE));
  });

  /**
   * The refusal is best-effort: the toast has already happened, and MoT's own
   * timeout is the fallback it always was. This path reports trouble and must
   * not be able to become it.
   */
  it("does not throw when even the refusal cannot get through", async () => {
    const wired = deps({
      lookupActor: vi.fn(() => null),
      report: vi.fn((_body: ActorSheetBody | ActorSheetFailure) => Promise.reject(new Error("offline"))),
    });

    createActorSheetHandler(wired)(payload());
    await flushMicrotasks();

    expect(wired.notify).toHaveBeenCalledTimes(1);
  });

  it("says so on screen when Master of Tales refuses the sheet", async () => {
    const wired = deps({
      report: vi.fn((_body: ActorSheetBody | ActorSheetFailure) => Promise.reject(new Error("HTTP 404"))),
    });
    createActorSheetHandler(wired)(payload());
    await flushMicrotasks();

    expect(wired.notify).toHaveBeenCalledWith("error", failureMessage(REASON_REPORT_FAILED));
  });

  it("drops a request with no ids quietly — nobody at this table asked for it", async () => {
    const wired = deps();
    createActorSheetHandler(wired)({ actorId: "aBcD1234" });
    await flushMicrotasks();

    expect(wired.report).not.toHaveBeenCalled();
    expect(wired.notify).not.toHaveBeenCalled();
  });
});

describe("the dispatcher", () => {
  it("routes actor.sheet.request to the handler", () => {
    const onActorSheetRequest = vi.fn();
    const dispatch = createDispatcher({ onSession: vi.fn(), onActorSheetRequest });

    dispatch({ v: 1, type: "actor.sheet.request", id: "c1", ts: "", payload: payload() });

    expect(onActorSheetRequest).toHaveBeenCalledWith(payload());
  });

  it("ignores it on a client with no handler wired — rule 1, unchanged", () => {
    const log = createLog();
    const dispatch = createDispatcher({ onSession: vi.fn(), log });

    expect(() =>
      dispatch({ v: 1, type: "actor.sheet.request", id: "c1", ts: "", payload: payload() }),
    ).not.toThrow();
  });
});
