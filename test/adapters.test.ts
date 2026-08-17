import { describe, expect, it } from "vitest";
import { selectAdapter, toExt } from "../src/adapters/index.js";
import { genericAdapter } from "../src/adapters/generic.js";
import { advantageState, dnd5eAdapter } from "../src/adapters/dnd5e.js";
import { chatMessage, die, roll } from "./stubs.js";

const CONTEXT = { systemId: "dnd5e", systemVersion: "5.0.2" };

/** A d20 term with the modifiers Foundry records on it. */
function d20(results: number[], modifiers: string[] = []) {
  return { ...die({ faces: 20, results }), modifiers };
}

describe("selectAdapter", () => {
  it("returns the dnd5e adapter for a 5e world", () => {
    expect(selectAdapter("dnd5e")).toBe(dnd5eAdapter);
  });

  it("returns the generic adapter for every other system — Pathfinder gets a working log on day one", () => {
    expect(selectAdapter("pf2e")).toBe(genericAdapter);
    expect(selectAdapter("swade")).toBe(genericAdapter);
    expect(selectAdapter("my-homebrew-system")).toBe(genericAdapter);
  });

  it("returns the generic adapter for a missing system id rather than throwing", () => {
    expect(selectAdapter(null)).toBe(genericAdapter);
    expect(selectAdapter(undefined)).toBe(genericAdapter);
    expect(selectAdapter("")).toBe(genericAdapter);
  });
});

describe("genericAdapter", () => {
  it("garnishes nothing at all", () => {
    expect(genericAdapter.rollExt(chatMessage(), roll("1d20", 5), CONTEXT)).toBeUndefined();
    expect(genericAdapter.chatExt(chatMessage(), CONTEXT)).toBeUndefined();
    expect(genericAdapter.actorExt({ system: null, delta: null }, CONTEXT)).toBeUndefined();
  });

  it("recognises no currency, which is what makes a generic table emit no coin events", () => {
    // Not an omission: core Foundry has no currency concept, so guessing at a
    // `system.currency` field would be inventing an event rather than reading one.
    const source = { system: { currency: { gp: 25 } }, delta: { currency: { gp: 25 } } };
    expect(genericAdapter.currency(source, CONTEXT)).toBeUndefined();
  });
});

describe("dnd5eAdapter — roll garnish", () => {
  it("always reports the system it saw", () => {
    expect(dnd5eAdapter.rollExt(chatMessage(), roll("1d20", 5), CONTEXT)).toEqual({
      dnd5e: { system: "dnd5e", systemVersion: "5.0.2" },
    });
  });

  it("keeps everything it produces inside the `ext.dnd5e` namespace", () => {
    // If an adapter ever emits a top-level key, the server could branch on it and
    // the feature quietly becomes a 5e feature.
    for (const ext of [
      dnd5eAdapter.chatExt(chatMessage(), CONTEXT),
      dnd5eAdapter.rollExt(chatMessage(), roll("1d20", 5), CONTEXT),
      dnd5eAdapter.actorExt({ system: null, delta: { attributes: { hp: { value: 1 } } } }, CONTEXT),
    ]) {
      expect(Object.keys(ext ?? {})).toEqual(["dnd5e"]);
    }
  });

  it("reports advantage from the D20Roll options", () => {
    const advantaged = { ...roll("2d20kh1", 18), options: { advantage: true } };
    expect(dnd5eAdapter.rollExt(chatMessage(), advantaged, CONTEXT)).toMatchObject({
      dnd5e: { advantage: true },
    });
  });

  it("reports disadvantage from the D20Roll options", () => {
    const disadvantaged = { ...roll("2d20kl1", 4), options: { disadvantage: true } };
    expect(dnd5eAdapter.rollExt(chatMessage(), disadvantaged, CONTEXT)).toMatchObject({
      dnd5e: { disadvantage: true },
    });
  });

  it("reads the newer `advantageMode` enum", () => {
    const adv = { ...roll("2d20kh1", 18), options: { advantageMode: 1 } };
    const dis = { ...roll("2d20kl1", 4), options: { advantageMode: -1 } };

    expect(dnd5eAdapter.rollExt(chatMessage(), adv, CONTEXT)).toMatchObject({ dnd5e: { advantage: true } });
    expect(dnd5eAdapter.rollExt(chatMessage(), dis, CONTEXT)).toMatchObject({ dnd5e: { disadvantage: true } });
  });

  it("says nothing at all about a straight roll", () => {
    const straight = { ...roll("1d20 + 5", 17), options: { advantageMode: 0 } };
    const ext = dnd5eAdapter.rollExt(chatMessage(), straight, CONTEXT) as { dnd5e: Record<string, unknown> };

    // "We found no evidence of advantage" and "this roll was straight" are
    // different sentences, and only the first one is true.
    expect(ext.dnd5e).not.toHaveProperty("advantage");
    expect(ext.dnd5e).not.toHaveProperty("disadvantage");
  });
});

describe("advantageState — three homes across dnd5e 2.x–5.x", () => {
  it("prefers the roll's own options", () => {
    expect(advantageState(chatMessage(), { ...roll("2d20kh1", 18), options: { advantage: true } })).toBe(
      "advantage",
    );
  });

  it("falls back to the message's dnd5e flags", () => {
    const message = chatMessage({ flags: { dnd5e: { roll: { advantageMode: -1 } } } });
    expect(advantageState(message, roll("2d20kl1", 4))).toBe("disadvantage");
  });

  it("falls back to the dice themselves — a d20 rolled twice keeping the highest", () => {
    expect(advantageState(chatMessage(), roll("2d20kh1", 18, [d20([18, 4], ["kh"])]))).toBe("advantage");
    expect(advantageState(chatMessage(), roll("2d20kl1", 4, [d20([18, 4], ["kl1"])]))).toBe("disadvantage");
  });

  it("lets the roll's options win over the dice, which is the authoritative source", () => {
    const conflicting = { ...roll("2d20kh1", 18, [d20([18, 4], ["kh"])]), options: { disadvantage: true } };
    expect(advantageState(chatMessage(), conflicting)).toBe("disadvantage");
  });

  it("ignores a keep-highest on a single die — that is not advantage", () => {
    expect(advantageState(chatMessage(), roll("1d20kh1", 18, [d20([18], ["kh"])]))).toBeNull();
  });

  it("ignores a keep-highest on a damage pool", () => {
    const damage = roll("4d6kh3", 14, [{ ...die({ faces: 6, results: [5, 4, 3, 2] }), modifiers: ["kh3"] }]);
    expect(advantageState(chatMessage(), damage)).toBeNull();
  });

  it("does not read the formula, where `2d20kh1` inside a bigger expression is not reliable evidence", () => {
    expect(advantageState(chatMessage(), roll("2d20kh1 + 5", 23))).toBeNull();
  });

  it("is null for a plain roll and for nothing at all", () => {
    expect(advantageState(chatMessage(), roll("1d20 + 5", 17))).toBeNull();
    expect(advantageState(null, null)).toBeNull();
    expect(advantageState(chatMessage({ flags: null }), { options: null })).toBeNull();
  });
});

describe("dnd5eAdapter — actor garnish", () => {
  const withTemp = { attributes: { hp: { value: 40, max: 40, temp: 15 } } };

  it("reports temp HP when the update was about hit points", () => {
    const source = { system: withTemp, delta: { attributes: { hp: { value: 40 } } } };
    expect(dnd5eAdapter.actorExt(source, CONTEXT)).toEqual({
      dnd5e: { system: "dnd5e", systemVersion: "5.0.2", tempHp: 15 },
    });
  });

  it("stays quiet about temp HP when the update was about something else", () => {
    // The field holds a value all the time; attaching it to a rename would
    // report a number the event had nothing to do with.
    const source = { system: withTemp, delta: { details: { level: 5 } } };
    expect(dnd5eAdapter.actorExt(source, CONTEXT)).toEqual({
      dnd5e: { system: "dnd5e", systemVersion: "5.0.2" },
    });
  });

  it("treats zero and null temp HP alike — both mean none, and neither is a line", () => {
    const delta = { attributes: { hp: { value: 40 } } };

    for (const temp of [0, null, undefined, "15"]) {
      const source = { system: { attributes: { hp: { temp } } }, delta };
      expect(dnd5eAdapter.actorExt(source, CONTEXT)).not.toHaveProperty("dnd5e.tempHp");
    }
  });

  it("survives an actor with no system data at all", () => {
    expect(dnd5eAdapter.actorExt({ system: null, delta: null }, CONTEXT)).toEqual({
      dnd5e: { system: "dnd5e", systemVersion: "5.0.2" },
    });
  });
});

describe("dnd5eAdapter — currency detection", () => {
  it("names the denominations the diff touched and the purse that resulted", () => {
    const source = {
      system: { currency: { pp: 0, gp: 25, ep: 0, sp: 4, cp: 88 } },
      delta: { currency: { gp: 25 } },
    };

    expect(dnd5eAdapter.currency(source, CONTEXT)).toEqual({
      current: { pp: 0, gp: 25, ep: 0, sp: 4, cp: 88 },
      changed: ["gp"],
    });
  });

  it("reports every denomination in a multi-coin transaction", () => {
    const source = {
      system: { currency: { gp: 8, sp: 15 } },
      delta: { currency: { gp: 8, sp: 15 } },
    };
    expect(dnd5eAdapter.currency(source, CONTEXT)?.changed).toEqual(["gp", "sp"]);
  });

  it("falls back to the diff when the document carried no purse", () => {
    const source = { system: null, delta: { currency: { gp: 25 } } };
    expect(dnd5eAdapter.currency(source, CONTEXT)).toEqual({ current: { gp: 25 }, changed: ["gp"] });
  });

  it("is undefined for an update that never touched currency", () => {
    expect(dnd5eAdapter.currency({ system: { currency: { gp: 1 } }, delta: null }, CONTEXT)).toBeUndefined();
    expect(
      dnd5eAdapter.currency({ system: null, delta: { attributes: { hp: { value: 1 } } } }, CONTEXT),
    ).toBeUndefined();
  });

  it("is undefined when the currency node carries nothing numeric", () => {
    const source = { system: null, delta: { currency: { gp: "twenty-five" } } };
    expect(dnd5eAdapter.currency(source, CONTEXT)).toBeUndefined();
  });

  it("drops non-numeric denominations from the resulting purse", () => {
    const source = { system: { currency: { gp: 25, notes: "in a pouch" } }, delta: { currency: { gp: 25 } } };
    expect(dnd5eAdapter.currency(source, CONTEXT)?.current).toEqual({ gp: 25 });
  });

  it("accepts zero — an emptied purse is the most interesting transaction there is", () => {
    const source = { system: { currency: { gp: 0 } }, delta: { currency: { gp: 0 } } };
    expect(dnd5eAdapter.currency(source, CONTEXT)).toEqual({ current: { gp: 0 }, changed: ["gp"] });
  });
});

describe("toExt", () => {
  it("passes a populated object through", () => {
    expect(toExt({ dnd5e: { crit: true } })).toEqual({ dnd5e: { crit: true } });
  });

  it("drops undefined and empty objects so events do not carry `ext: {}`", () => {
    expect(toExt(undefined)).toBeUndefined();
    expect(toExt({})).toBeUndefined();
  });
});
