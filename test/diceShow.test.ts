import { describe, expect, it, vi } from "vitest";
import { buildChatEvents } from "../src/capture/chat.js";
import {
  buildRoll,
  createDiceShowHandler,
  diceMessageData,
  MAX_DICE_PER_ROLL,
  planDiceShow,
  PUBLIC_ROLL,
  resolveDiceApi,
  type RollPlan,
} from "../src/commands/dice.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { captureContext, chatMessage, createDiceApi, createLog, flushMicrotasks } from "./stubs.js";

/** A `dice.show` payload exactly as `Bridge::Commands.deliver` broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formula: "1d20 + 5",
    total: 17,
    dice: [{ sides: 20, values: [12] }],
    modifier: 5,
    flavor: "Longsword attack",
    speaker: { alias: "Tharivol" },
    ...overrides,
  };
}

describe("planDiceShow", () => {
  it("normalises the ordinary case — one die, a modifier, a flavor and a speaker", () => {
    expect(planDiceShow(payload())).toEqual({
      dice: [{ faces: 20, number: 1, results: [{ result: 12, active: true, discarded: false }] }],
      modifier: 5,
      total: 17,
      formula: "1d20 + 5",
      flavor: "Longsword attack",
      alias: "Tharivol",
    });
  });

  it("marks the dice a kept array discarded — this is what advantage looks like", () => {
    const plan = planDiceShow(payload({ dice: [{ sides: 20, values: [19, 4], kept: [true, false] }] }));

    expect(plan?.dice[0]?.results).toEqual([
      { result: 19, active: true, discarded: false },
      { result: 4, active: false, discarded: true },
    ]);
    // `number` is the count of dice *rolled*, not the count kept — both faces
    // have to be on the table for Dice So Nice to animate them.
    expect(plan?.dice[0]?.number).toBe(2);
  });

  it("treats a missing kept flag as kept — absent over wrong, and it shows more dice", () => {
    const plan = planDiceShow(payload({ dice: [{ sides: 6, values: [1, 2, 3], kept: [false] }] }));
    expect(plan?.dice[0]?.results.map((r) => r.active)).toEqual([false, true, true]);
  });

  it("keeps every group when a roll carries several", () => {
    const plan = planDiceShow(
      payload({ dice: [{ sides: 20, values: [12] }, { sides: 6, values: [3, 5] }] }),
    );
    expect(plan?.dice.map((die) => [die.faces, die.number])).toEqual([
      [20, 1],
      [6, 2],
    ]);
  });

  it("handles a d100, whose values are the ones people assume break this", () => {
    const plan = planDiceShow(payload({ dice: [{ sides: 100, values: [100, 1, 73] }], modifier: 0, total: 174 }));
    expect(plan?.dice[0]).toEqual({
      faces: 100,
      number: 3,
      results: [
        { result: 100, active: true, discarded: false },
        { result: 1, active: true, discarded: false },
        { result: 73, active: true, discarded: false },
      ],
    });
  });

  it("drops a zero modifier rather than rendering `+ 0`", () => {
    expect(planDiceShow(payload({ modifier: 0 }))?.modifier).toBeNull();
    expect(planDiceShow(payload({ modifier: undefined }))?.modifier).toBeNull();
    expect(planDiceShow(payload({ modifier: null }))?.modifier).toBeNull();
    expect(planDiceShow(payload({ modifier: "5" }))?.modifier).toBeNull();
  });

  it("keeps a negative modifier", () => {
    expect(planDiceShow(payload({ modifier: -2 }))?.modifier).toBe(-2);
  });

  it("survives a missing flavor and a missing speaker", () => {
    const plan = planDiceShow({ dice: [{ sides: 20, values: [12] }] });
    expect(plan?.flavor).toBeNull();
    expect(plan?.alias).toBeNull();
    expect(plan?.formula).toBeNull();
    expect(plan?.total).toBeNull();
    expect(plan?.modifier).toBeNull();
  });

  it("survives an explicitly null flavor and speaker, which is what the contract sends", () => {
    const plan = planDiceShow(payload({ flavor: null, speaker: null }));
    expect(plan?.flavor).toBeNull();
    expect(plan?.alias).toBeNull();
  });

  it("escapes the flavor, because Foundry renders it as HTML", () => {
    const plan = planDiceShow(payload({ flavor: "Sneak <script>alert(1)</script> attack & then some" }));
    expect(plan?.flavor).toBe("Sneak attack &amp; then some");
    expect(plan?.flavor).not.toContain("<");
  });

  it("trims the alias and drops an empty one", () => {
    expect(planDiceShow(payload({ speaker: { alias: "  Tharivol  " } }))?.alias).toBe("Tharivol");
    expect(planDiceShow(payload({ speaker: { alias: "   " } }))?.alias).toBeNull();
    expect(planDiceShow(payload({ speaker: { alias: 7 } }))?.alias).toBeNull();
  });

  it("is a pure function of the payload — same input, same plan, no clock anywhere", () => {
    const source = payload();
    expect(planDiceShow(source)).toEqual(planDiceShow(source));
  });

  // ---------------------------------------------------------- calm drops

  it("drops a payload with no dice in it", () => {
    expect(planDiceShow(payload({ dice: [] }))).toBeNull();
    expect(planDiceShow(payload({ dice: undefined }))).toBeNull();
    expect(planDiceShow(payload({ dice: null }))).toBeNull();
    expect(planDiceShow(payload({ dice: "1d20" }))).toBeNull();
  });

  it("drops a payload that is not an object at all", () => {
    expect(planDiceShow(null)).toBeNull();
    expect(planDiceShow(undefined)).toBeNull();
    expect(planDiceShow("nope")).toBeNull();
    expect(planDiceShow(42)).toBeNull();
    expect(planDiceShow([{ sides: 20, values: [1] }])).toBeNull();
  });

  it("drops a group whose faces are missing, zero, fractional or not a number", () => {
    for (const sides of [undefined, null, 0, -6, 2.5, "20", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planDiceShow(payload({ dice: [{ sides, values: [1] }] }))).toBeNull();
    }
  });

  it("drops a group whose values are missing, empty or non-numeric", () => {
    for (const values of [undefined, null, [], "12", [1, "2"], [1, null], [Number.NaN]]) {
      expect(planDiceShow(payload({ dice: [{ sides: 20, values }] }))).toBeNull();
    }
  });

  it("drops the WHOLE command when one group of several is malformed", () => {
    // A d20 shown without its damage dice is a wrong answer, and a wrong answer
    // is worse than a missing animation.
    expect(planDiceShow(payload({ dice: [{ sides: 20, values: [12] }, { sides: 6, values: ["x"] }] }))).toBeNull();
  });

  it("drops a group that is not an object", () => {
    expect(planDiceShow(payload({ dice: [null] }))).toBeNull();
    expect(planDiceShow(payload({ dice: ["1d20"] }))).toBeNull();
  });

  it("drops a command carrying an absurd number of dice", () => {
    const values = Array.from({ length: MAX_DICE_PER_ROLL + 1 }, () => 1);
    expect(planDiceShow(payload({ dice: [{ sides: 6, values }] }))).toBeNull();
    // …and accepts one right at the cap.
    expect(planDiceShow(payload({ dice: [{ sides: 6, values: values.slice(1) }] }))).not.toBeNull();
  });

  it("never throws, whatever it is handed", () => {
    for (const junk of [null, undefined, 0, "", [], {}, { dice: [{}] }, { dice: [{ sides: 20 }] }]) {
      expect(() => planDiceShow(junk)).not.toThrow();
    }
  });
});

describe("buildRoll", () => {
  function plan(overrides: Partial<RollPlan> = {}): RollPlan {
    const built = planDiceShow(payload());
    if (!built) throw new Error("the fixture payload should always plan");
    return { ...built, ...overrides };
  }

  it("builds Die + Operator + Numeric terms in formula order", () => {
    const dice = createDiceApi();
    buildRoll(plan({ dice: [
      { faces: 20, number: 1, results: [{ result: 12, active: true, discarded: false }] },
      { faces: 6, number: 2, results: [
        { result: 3, active: true, discarded: false },
        { result: 5, active: true, discarded: false },
      ] },
    ] }), dice.api);

    expect(dice.terms.map((term) => term.kind)).toEqual(["Die", "OperatorTerm", "Die", "OperatorTerm", "NumericTerm"]);
    expect(dice.terms[1]?.data.operator).toBe("+");
  });

  it("hands each Die its faces, its count and its predetermined results", () => {
    const dice = createDiceApi();
    buildRoll(plan({ dice: [{ faces: 20, number: 2, results: [
      { result: 19, active: true, discarded: false },
      { result: 4, active: false, discarded: true },
    ] }], modifier: null }), dice.api);

    expect(dice.terms[0]?.data).toEqual({
      number: 2,
      faces: 20,
      results: [
        { result: 19, active: true, discarded: false },
        { result: 4, active: false, discarded: true },
      ],
    });
  });

  it("puts the sign on the operator so the card reads `- 2`, not `+ -2`", () => {
    const dice = createDiceApi();
    buildRoll(plan({ modifier: -2 }), dice.api);

    const [operator, numeric] = dice.terms.slice(-2);
    expect(operator?.data.operator).toBe("-");
    expect(numeric?.data.number).toBe(2);
  });

  it("emits no modifier term at all when there is none", () => {
    const dice = createDiceApi();
    buildRoll(plan({ modifier: null }), dice.api);
    expect(dice.terms.map((term) => term.kind)).toEqual(["Die"]);
  });

  it("marks EVERY term evaluated — Foundry refuses a half-evaluated roll", () => {
    const dice = createDiceApi();
    // The fake reproduces Foundry's own guard, so this passing is the assertion.
    expect(buildRoll(plan(), dice.api)).not.toBeNull();
    expect(dice.terms.every((term) => term._evaluated)).toBe(true);
  });

  it("marks the roll evaluated and takes MoT's total as the authority", () => {
    const dice = createDiceApi();
    buildRoll(plan({ total: 17 }), dice.api);
    expect(dice.lastRoll?._evaluated).toBe(true);
    expect(dice.lastRoll?._total).toBe(17);
  });

  it("shows MoT's formula rather than the one regenerated from the terms", () => {
    const dice = createDiceApi();
    buildRoll(plan({ formula: "2d20kh1 + 5" }), dice.api);
    expect(dice.lastRoll?._formula).toBe("2d20kh1 + 5");
  });

  it("leaves the derived formula alone when MoT sent none", () => {
    const dice = createDiceApi();
    buildRoll(plan({ formula: null, modifier: 5 }), dice.api);
    expect(dice.lastRoll?._formula).toBe("1d20 + 5");
  });

  it("gives each Die its own result objects — Foundry mutates them as it animates", () => {
    const dice = createDiceApi();
    const source = plan();
    buildRoll(source, dice.api);

    const results = dice.terms[0]?.data.results as Array<Record<string, unknown>>;
    results[0]!.shown = true;
    expect(source.dice[0]?.results[0]).toEqual({ result: 12, active: true, discarded: false });
  });

  it("returns null rather than throwing when a system's Roll rejects the terms", () => {
    const dice = createDiceApi({ fromTermsThrows: true });
    expect(buildRoll(plan(), dice.api)).toBeNull();
  });
});

describe("resolveDiceApi", () => {
  const terms = { Die: class {}, OperatorTerm: class {}, NumericTerm: class {} };
  const Roll = { fromTerms: () => ({ toMessage: () => Promise.resolve(null) }) };

  it("prefers the namespaced classes — the only spelling true on both v13 and v14", () => {
    const api = resolveDiceApi({ foundry: { dice: { terms, Roll } }, Die: class Legacy {} });
    expect(api?.Die).toBe(terms.Die);
  });

  it("falls back to the v13 globals when the namespace is absent", () => {
    const api = resolveDiceApi({ ...terms, Roll });
    expect(api?.Die).toBe(terms.Die);
    expect(api?.Roll).toBe(Roll);
  });

  it("returns null off a Foundry, which is every unit test and a client mid-boot", () => {
    expect(resolveDiceApi(null)).toBeNull();
    expect(resolveDiceApi(undefined)).toBeNull();
    expect(resolveDiceApi("nope")).toBeNull();
    expect(resolveDiceApi({})).toBeNull();
  });

  it("returns null when a term class is missing rather than half an API", () => {
    expect(resolveDiceApi({ Die: terms.Die, OperatorTerm: terms.OperatorTerm, Roll })).toBeNull();
    expect(resolveDiceApi({ ...terms })).toBeNull();
    expect(resolveDiceApi({ ...terms, Roll: {} })).toBeNull();
  });
});

describe("diceMessageData", () => {
  function plan(overrides: Partial<RollPlan> = {}): RollPlan {
    const built = planDiceShow(payload());
    if (!built) throw new Error("the fixture payload should always plan");
    return { ...built, ...overrides };
  }

  it("stamps the origin flag — this is the whole of the echo brake", () => {
    expect(diceMessageData(plan()).flags).toEqual({ [MODULE_ID]: { origin: "mot" } });
  });

  it("carries the speaker alias and the flavor", () => {
    const data = diceMessageData(plan());
    expect(data.speaker).toEqual({ alias: "Tharivol" });
    expect(data.flavor).toBe("Longsword attack");
  });

  it("OMITS the speaker and flavor when there are none, rather than sending null", () => {
    const data = diceMessageData(plan({ alias: null, flavor: null }));
    expect("speaker" in data).toBe(false);
    expect("flavor" in data).toBe(false);
  });
});

describe("createDiceShowHandler", () => {
  function handler(options: { active?: boolean; dice?: ReturnType<typeof createDiceApi> | null } = {}) {
    const dice = options.dice === undefined ? createDiceApi() : options.dice;
    const log = createLog();
    const render = createDiceShowHandler({
      isActive: () => options.active !== false,
      api: () => dice?.api ?? null,
      log,
    });
    return { render, dice, log };
  }

  it("posts an evaluated roll to chat", async () => {
    const { render, dice } = handler();
    render(payload());
    await flushMicrotasks();

    expect(dice?.rolls).toHaveLength(1);
    expect(dice?.lastRoll?.messages).toHaveLength(1);
    expect(dice?.lastRoll?.messages[0]?.data.flags).toEqual({ [MODULE_ID]: { origin: "mot" } });
  });

  it("forces a public roll mode — the GM's chat dropdown says nothing about MoT's dice", () => {
    const { render, dice } = handler();
    render(payload());
    expect(dice?.lastRoll?.messages[0]?.options).toEqual({ rollMode: PUBLIC_ROLL });
  });

  it("does NOTHING on a client that is not the active GM", () => {
    // Every connected client receives the command. Only one may render it, or
    // the table gets one chat message per open browser.
    const { render, dice } = handler({ active: false });
    render(payload());
    expect(dice?.rolls).toHaveLength(0);
    expect(dice?.terms).toHaveLength(0);
  });

  it("drops a malformed payload calmly, at debug volume, without building anything", () => {
    const { render, dice, log } = handler();
    render({ dice: [] });
    render(null);
    render({ dice: [{ sides: 20, values: ["nope"] }] });

    expect(dice?.rolls).toHaveLength(0);
    expect(log.lines.debug).toHaveLength(3);
    expect(log.lines.warn).toHaveLength(0);
    expect(log.lines.error).toHaveLength(0);
  });

  it("drops the command when there is no Foundry to render it with", () => {
    const { render, log } = handler({ dice: null });
    expect(() => render(payload())).not.toThrow();
    expect(log.lines.debug).toHaveLength(1);
  });

  it("survives a Roll class that refuses the terms", () => {
    const dice = createDiceApi({ fromTermsThrows: true });
    const log = createLog();
    const render = createDiceShowHandler({ isActive: () => true, api: () => dice.api, log });

    expect(() => render(payload())).not.toThrow();
    expect(log.lines.debug).toHaveLength(1);
  });

  it("swallows a toMessage rejection rather than leaving it unhandled", async () => {
    const dice = createDiceApi({ toMessageRejects: true });
    const log = createLog();
    const render = createDiceShowHandler({ isActive: () => true, api: () => dice.api, log });

    render(payload());
    await flushMicrotasks();
    expect(log.lines.debug).toHaveLength(1);
  });

  it("renders the same command twice identically — there is no clock in this path", () => {
    const { render, dice } = handler();
    render(payload());
    render(payload());
    expect(dice?.rolls[0]?._total).toBe(dice?.rolls[1]?._total);
    expect(dice?.rolls[0]?._formula).toBe(dice?.rolls[1]?._formula);
    expect(dice?.rolls[0]?.messages[0]?.data).toEqual(dice?.rolls[1]?.messages[0]?.data);
  });
});

describe("the echo guard, end to end", () => {
  it("does not capture the chat message dice.show just created", () => {
    // The one loop that would double a customer's log forever: MoT sends a
    // roll, Foundry fires createChatMessage, we send it straight back.
    const dice = createDiceApi();
    const render = createDiceShowHandler({ isActive: () => true, api: () => dice.api });
    render(payload());

    const posted = dice.lastRoll?.messages[0]?.data ?? {};
    const echoed = chatMessage({
      flags: posted.flags as Record<string, unknown>,
      rolls: [{ formula: "1d20 + 5", total: 17, dice: [{ faces: 20, results: [{ result: 12, active: true }] }] }],
    });

    expect(buildChatEvents(echoed, captureContext())).toEqual([]);
  });

  it("still captures an identical roll a human made at the table", () => {
    const human = chatMessage({
      flags: {},
      rolls: [{ formula: "1d20 + 5", total: 17, dice: [{ faces: 20, results: [{ result: 12, active: true }] }] }],
    });
    expect(buildChatEvents(human, captureContext())).toHaveLength(1);
  });
});

describe("no clock in the render path", () => {
  it("never reads Date.now while rendering a command", () => {
    const now = vi.spyOn(Date, "now");
    const dice = createDiceApi();
    createDiceShowHandler({ isActive: () => true, api: () => dice.api })(payload());
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
