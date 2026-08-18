import { describe, expect, it } from "vitest";
import { dnd5eAdapter } from "../src/adapters/dnd5e.js";
import { buildCurrencyEvent, buildItemEvent, lootIsPrivate, registerItemCapture } from "../src/capture/items.js";
import { bridgeOriginFlags } from "../src/capture/loopGuard.js";
import type { Envelope } from "../src/protocol/types.js";
import {
  actorDocument,
  createHooks,
  documentContext,
  itemDocument,
  nullAdapter,
  playerActor,
  STUB_MTIME,
  tokenDocument,
} from "./stubs.js";

/** A player character: somebody at the table owns them, so their loot is public. */
const THARIVOL = playerActor({ uuid: "Actor.thar", name: "Tharivol" });

/** The villain. Nobody at the table owns him, so his pockets are the GM's. */
const STRAHD = actorDocument({ uuid: "Actor.strahd", name: "Strahd" });

describe("lootIsPrivate", () => {
  it("is false only for an actor a player actually owns", () => {
    expect(lootIsPrivate(playerActor())).toBe(false);
  });

  it("is true for a GM-controlled actor", () => {
    expect(lootIsPrivate(actorDocument({ hasPlayerOwner: false }))).toBe(true);
  });

  it("errs private for every shape of `I do not know`", () => {
    expect(lootIsPrivate(actorDocument({ hasPlayerOwner: null }))).toBe(true);
    expect(lootIsPrivate(null)).toBe(true);
    expect(lootIsPrivate(undefined)).toBe(true);
    expect(lootIsPrivate({} as FoundryDocument)).toBe(true);
  });

  it("refuses a truthy non-boolean — only a real `true` opens the log", () => {
    expect(lootIsPrivate({ hasPlayerOwner: 1 } as unknown as FoundryDocument)).toBe(true);
    expect(lootIsPrivate({ hasPlayerOwner: "yes" } as unknown as FoundryDocument)).toBe(true);
  });

  it("composes with the hidden-token rule — either condition alone is enough", () => {
    // A player-owned character on a hidden token: the party's polymorphed
    // scout, whose pickups the table has still not seen.
    const hiddenPC = playerActor({ token: tokenDocument({ hidden: true }) });
    expect(lootIsPrivate(hiddenPC)).toBe(true);

    const visiblePC = playerActor({ token: tokenDocument({ hidden: false }) });
    expect(lootIsPrivate(visiblePC)).toBe(false);
  });
});

describe("buildItemEvent", () => {
  const potion = itemDocument({
    uuid: "Actor.thar.Item.i1",
    name: "Potion of Healing",
    system: { quantity: 3, rarity: "common" },
    parent: THARIVOL,
  });

  it("emits item.granted with everything the log needs", () => {
    expect(buildItemEvent(potion, "granted", documentContext())).toEqual({
      v: 1,
      type: "item.granted",
      id: "fvtt:item:Actor.thar.Item.i1:granted",
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        actorUuid: "Actor.thar",
        actorName: "Tharivol",
        itemUuid: "Actor.thar.Item.i1",
        itemName: "Potion of Healing",
        quantity: 3,
        rarity: "common",
        private: false,
      },
    });
  });

  it("emits item.removed with its own key, so a grant and a loss never collide", () => {
    const granted = buildItemEvent(potion, "granted", documentContext());
    const removed = buildItemEvent(potion, "removed", documentContext());

    expect(removed?.type).toBe("item.removed");
    expect(removed?.id).toBe("fvtt:item:Actor.thar.Item.i1:removed");
    expect(removed?.id).not.toBe(granted?.id);
  });

  it("reports null quantity and rarity on a system that keeps neither", () => {
    const sword = itemDocument({ uuid: "Actor.thar.Item.i2", name: "Longsword", system: {}, parent: THARIVOL });
    expect(buildItemEvent(sword, "granted", documentContext())?.payload).toMatchObject({
      quantity: null,
      rarity: null,
    });
  });

  it("refuses a non-numeric quantity and a blank rarity rather than passing them through", () => {
    const odd = itemDocument({
      uuid: "Actor.thar.Item.i3",
      system: { quantity: "several", rarity: "   " },
      parent: THARIVOL,
    });
    expect(buildItemEvent(odd, "granted", documentContext())?.payload).toMatchObject({
      quantity: null,
      rarity: null,
    });
  });

  it("accepts a quantity of zero — that is a real number, not a missing one", () => {
    const empty = itemDocument({ uuid: "Actor.thar.Item.i4", system: { quantity: 0 }, parent: THARIVOL });
    expect(buildItemEvent(empty, "granted", documentContext())?.payload.quantity).toBe(0);
  });

  it("ignores a world item with no owner — that is the GM's prep, not loot", () => {
    expect(buildItemEvent(itemDocument({ parent: null }), "granted", documentContext())).toBeNull();
  });

  it("ignores an item inside another item", () => {
    const inside = itemDocument({ uuid: "Item.a.Item.b", parent: itemDocument() });
    expect(buildItemEvent(inside, "granted", documentContext())).toBeNull();
  });

  it("skips an item with no uuid, and MoT's own echo", () => {
    expect(buildItemEvent(itemDocument({ uuid: null }), "granted", documentContext())).toBeNull();

    const echo = itemDocument({ uuid: "Actor.a.Item.b", flags: bridgeOriginFlags() });
    expect(buildItemEvent(echo, "granted", documentContext())).toBeNull();
    expect(buildItemEvent(null, "granted", documentContext())).toBeNull();
  });

  it("keeps an NPC's loot private — the players do not get to read the villain's pockets", () => {
    // Found at a real table: an item granted to a GM-controlled NPC landed in
    // the shared log and told everyone what Strahd was carrying.
    const dagger = itemDocument({ uuid: "Actor.strahd.Item.i9", name: "Sunsword", parent: STRAHD });
    expect(buildItemEvent(dagger, "granted", documentContext())?.payload.private).toBe(true);
  });

  it("keeps an NPC's losses private too — a removal leaks the same inventory", () => {
    const dagger = itemDocument({ uuid: "Actor.strahd.Item.i9", parent: STRAHD });
    expect(buildItemEvent(dagger, "removed", documentContext())?.payload.private).toBe(true);
  });

  it("leaves a player character's loot public — that is the table's shared story", () => {
    const potion = itemDocument({ uuid: "Actor.thar.Item.i1", parent: THARIVOL });
    expect(buildItemEvent(potion, "granted", documentContext())?.payload.private).toBe(false);
  });

  it("treats a missing hasPlayerOwner as private — the only safe direction to be wrong in", () => {
    // It is a *getter* on the Actor class, so a plain source object or a
    // half-torn-down document simply does not have it. Guessing public here
    // publishes an inventory nobody can un-publish.
    const noGetter: FoundryDocument = {
      id: "a1",
      uuid: "Actor.mystery",
      name: "Something",
      documentName: "Actor",
    };
    const item = itemDocument({ uuid: "Actor.mystery.Item.i1", parent: noGetter });

    expect(buildItemEvent(item, "granted", documentContext())?.payload.private).toBe(true);
  });

  it("does not try to infer a transfer — a hand-off is a delete and a create", () => {
    // The two documents share no id and nothing links them, so reporting both
    // honestly beats inventing a relationship the module cannot observe.
    const context = documentContext();
    const fromRogue = itemDocument({ uuid: "Actor.rogue.Item.x", parent: THARIVOL });
    const toCleric = itemDocument({ uuid: "Actor.cleric.Item.y", parent: THARIVOL });

    expect(buildItemEvent(fromRogue, "removed", context)?.type).toBe("item.removed");
    expect(buildItemEvent(toCleric, "granted", context)?.type).toBe("item.granted");
  });
});

describe("buildCurrencyEvent", () => {
  function dnd5eContext(overrides = {}) {
    return documentContext({ adapter: dnd5eAdapter, ...overrides });
  }

  function purse(currency: Record<string, number>) {
    return playerActor({ uuid: "Actor.thar", name: "Tharivol", system: { currency } });
  }

  it("emits nothing at all on a system with no adapter — core has no currency concept", () => {
    const actor = purse({ gp: 25 });
    const context = documentContext({ adapter: nullAdapter() });

    expect(buildCurrencyEvent(actor, { system: { currency: { gp: 25 } } }, context)).toBeNull();
  });

  it("emits from/to maps of only the denominations that moved", () => {
    const context = dnd5eContext();
    context.prior.remember("currency:Actor.thar", { gp: 10, sp: 4, cp: 88 });

    const envelope = buildCurrencyEvent(
      purse({ gp: 25, sp: 4, cp: 88 }),
      { system: { currency: { gp: 25 } } },
      context,
    );

    expect(envelope).toEqual({
      v: 1,
      type: "currency.changed",
      id: `fvtt:currency:Actor.thar:${STUB_MTIME}`,
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        actorUuid: "Actor.thar",
        actorName: "Tharivol",
        from: { gp: 10 },
        to: { gp: 25 },
        private: false,
      },
    });
  });

  it("keeps an NPC's purse private — the same rule, for the same reason", () => {
    const context = dnd5eContext();
    const strahd = actorDocument({ uuid: "Actor.strahd", name: "Strahd", system: { currency: { gp: 900 } } });

    const envelope = buildCurrencyEvent(strahd, { system: { currency: { gp: 900 } } }, context);
    expect(envelope?.payload.private).toBe(true);
  });

  it("reports `from: null` on the first purse change it ever sees", () => {
    const envelope = buildCurrencyEvent(purse({ gp: 25 }), { system: { currency: { gp: 25 } } }, dnd5eContext());
    expect(envelope?.payload).toMatchObject({ from: null, to: { gp: 25 } });
  });

  it("remembers the whole purse, so the next change has a `from`", () => {
    const context = dnd5eContext();
    buildCurrencyEvent(purse({ gp: 25, sp: 4 }), { system: { currency: { gp: 25 } } }, context);

    const second = buildCurrencyEvent(purse({ gp: 5, sp: 4 }), { system: { currency: { gp: 5 } } }, context);
    expect(second?.payload.from).toEqual({ gp: 25 });
  });

  it("reports several denominations moving at once", () => {
    const context = dnd5eContext();
    context.prior.remember("currency:Actor.thar", { gp: 10, sp: 0 });

    const envelope = buildCurrencyEvent(
      purse({ gp: 8, sp: 15 }),
      { system: { currency: { gp: 8, sp: 15 } } },
      context,
    );

    expect(envelope?.payload).toMatchObject({ from: { gp: 10, sp: 0 }, to: { gp: 8, sp: 15 } });
  });

  it("suppresses a purse written back unchanged — a sheet save is not a transaction", () => {
    const context = dnd5eContext();
    context.prior.remember("currency:Actor.thar", { gp: 25 });

    expect(buildCurrencyEvent(purse({ gp: 25 }), { system: { currency: { gp: 25 } } }, context)).toBeNull();
  });

  it("emits nothing for an actor update that never touched the purse", () => {
    const context = dnd5eContext();
    expect(buildCurrencyEvent(purse({ gp: 25 }), { system: { attributes: { hp: { value: 3 } } } }, context)).toBeNull();
    expect(buildCurrencyEvent(purse({ gp: 25 }), { name: "Renamed" }, context)).toBeNull();
    expect(buildCurrencyEvent(purse({ gp: 25 }), null, context)).toBeNull();
  });

  it("skips an actor with no uuid, and MoT's own echo", () => {
    const context = dnd5eContext();
    const change = { system: { currency: { gp: 25 } } };

    const noUuid = actorDocument({ uuid: null, system: { currency: { gp: 25 } } });
    expect(buildCurrencyEvent(noUuid, change, context)).toBeNull();

    const echo = actorDocument({ uuid: "Actor.a", system: { currency: { gp: 25 } }, flags: bridgeOriginFlags() });
    expect(buildCurrencyEvent(echo, change, context)).toBeNull();
    expect(buildCurrencyEvent(null, change, context)).toBeNull();
  });

  it("survives a remembered purse that is no longer the shape we stored", () => {
    const context = dnd5eContext();
    context.prior.remember("currency:Actor.thar", "not a purse");

    const envelope = buildCurrencyEvent(purse({ gp: 25 }), { system: { currency: { gp: 25 } } }, context);
    expect(envelope?.payload.from).toBeNull();
  });

  it("distinguishes an empty `from` (a purse we knew) from null (one we never saw)", () => {
    const context = dnd5eContext();
    context.prior.remember("currency:Actor.thar", { sp: 4 });

    const envelope = buildCurrencyEvent(purse({ gp: 25, sp: 4 }), { system: { currency: { gp: 25 } } }, context);
    expect(envelope?.payload.from).toEqual({});
  });
});

describe("registerItemCapture", () => {
  function harness(active = true, adapter = nullAdapter()) {
    const hooks = createHooks();
    const emitted: Envelope[] = [];
    const context = documentContext({ adapter });

    registerItemCapture({
      hooks,
      isActive: () => active,
      context: () => context,
      emit: (envelope) => void emitted.push(envelope),
    });
    return { hooks, emitted, context };
  }

  it("registers the two item hooks plus updateActor for coin", () => {
    const { hooks } = harness();
    expect([...hooks.handlers.keys()].sort()).toEqual(["createItem", "deleteItem", "updateActor"]);
  });

  it("emits item.granted on createItem and item.removed on deleteItem", () => {
    const { hooks, emitted } = harness();
    const potion = itemDocument({ uuid: "Actor.a.Item.i1", parent: THARIVOL });

    hooks.emit("createItem", potion);
    hooks.emit("deleteItem", potion);

    expect(emitted.map((event) => event.type)).toEqual(["item.granted", "item.removed"]);
  });

  it("emits currency.changed from updateActor when the adapter recognises coin", () => {
    const { hooks, emitted } = harness(true, dnd5eAdapter);
    hooks.emit(
      "updateActor",
      actorDocument({ uuid: "Actor.thar", system: { currency: { gp: 25 } } }),
      { system: { currency: { gp: 25 } } },
    );

    expect(emitted[0]?.type).toBe("currency.changed");
  });

  it("emits nothing at all when the activation gate is closed", () => {
    const { hooks, emitted } = harness(false, dnd5eAdapter);
    hooks.emit("createItem", itemDocument({ parent: THARIVOL }));
    hooks.emit("deleteItem", itemDocument({ parent: THARIVOL }));
    hooks.emit("updateActor", actorDocument({ system: { currency: { gp: 1 } } }), {
      system: { currency: { gp: 1 } },
    });

    expect(emitted).toEqual([]);
  });

  it("leaves a token-only update alone — this family has no opinion about tokens", () => {
    const { hooks, emitted } = harness();
    hooks.emit("updateToken", tokenDocument(), {});
    expect(emitted).toEqual([]);
  });
});
