import { describe, expect, it } from "vitest";
import {
  buildCombatEnded,
  buildCombatStarted,
  buildCombatTurn,
  registerCombatCapture,
} from "../src/capture/combat.js";
import { bridgeOriginFlags } from "../src/capture/loopGuard.js";
import type { Envelope } from "../src/protocol/types.js";
import {
  actorDocument,
  combatDocument,
  combatant,
  createHooks,
  documentContext,
  STUB_MTIME,
  tokenDocument,
} from "./stubs.js";

const GOBLIN = combatant({
  id: "c1",
  uuid: "Scene.s.Combat.k.Combatant.c1",
  name: "Goblin",
  actor: actorDocument({ uuid: "Actor.gob", name: "Goblin" }),
  token: tokenDocument({ uuid: "Scene.s.Token.t1", disposition: -1 }),
});

const THARIVOL = combatant({
  id: "c2",
  uuid: "Scene.s.Combat.k.Combatant.c2",
  name: "Tharivol",
  actor: actorDocument({ uuid: "Actor.thar", name: "Tharivol" }),
  token: tokenDocument({ uuid: "Scene.s.Token.t2", disposition: 1 }),
});

function combat(overrides = {}) {
  return combatDocument({
    uuid: "Scene.s.Combat.k",
    combatants: [GOBLIN, THARIVOL],
    ...overrides,
  });
}

describe("buildCombatStarted", () => {
  it("emits the roster as it stood before anybody died", () => {
    const envelope = buildCombatStarted(combat(), documentContext());

    expect(envelope).toEqual({
      v: 1,
      type: "combat.started",
      id: "fvtt:combat:Scene.s.Combat.k:start",
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        combatUuid: "Scene.s.Combat.k",
        combatants: [
          { name: "Goblin", actorUuid: "Actor.gob", tokenUuid: "Scene.s.Token.t1", disposition: -1 },
          { name: "Tharivol", actorUuid: "Actor.thar", tokenUuid: "Scene.s.Token.t2", disposition: 1 },
        ],
      },
    });
  });

  it("keys on the combat alone, so a second combatStart is a duplicate not a second header", () => {
    const context = documentContext();
    expect(buildCombatStarted(combat(), context)?.id).toBe(buildCombatStarted(combat(), context)?.id);
  });

  it("reads an EmbeddedCollection as happily as an array", () => {
    const collection = { contents: [GOBLIN], get: (id: string) => (id === "c1" ? GOBLIN : undefined) };
    const envelope = buildCombatStarted(combat({ combatants: collection }), documentContext());

    expect(envelope?.payload.combatants).toHaveLength(1);
  });

  it("still emits with an empty roster — the header the rounds hang from", () => {
    const envelope = buildCombatStarted(combat({ combatants: [] }), documentContext());
    expect(envelope?.payload.combatants).toEqual([]);
  });

  it("survives a roster of half-resolved combatants", () => {
    const orphan = combatant({ id: "c9", uuid: null, name: null, actor: null, token: null });
    const envelope = buildCombatStarted(combat({ combatants: [orphan] }), documentContext());

    expect(envelope?.payload.combatants).toEqual([
      { name: null, actorUuid: null, tokenUuid: null, disposition: null },
    ]);
  });

  it("skips a combat with no uuid — no stable key means a reconnect would duplicate it", () => {
    expect(buildCombatStarted(combat({ uuid: null }), documentContext())).toBeNull();
  });

  it("skips a combat MoT itself created — the echo brake", () => {
    expect(buildCombatStarted(combat({ flags: bridgeOriginFlags() }), documentContext())).toBeNull();
  });

  it("is null for no combat at all", () => {
    expect(buildCombatStarted(null, documentContext())).toBeNull();
    expect(buildCombatStarted(undefined, documentContext())).toBeNull();
  });
});

describe("buildCombatTurn", () => {
  const marker = { round: 2, turn: 1, combatantId: "c2", tokenId: "t2" };

  it("reports the round, the turn and whose it is", () => {
    const envelope = buildCombatTurn(combat({ round: 2, turn: 1 }), marker, documentContext());

    expect(envelope).toEqual({
      v: 1,
      type: "combat.turn",
      id: "fvtt:combat:Scene.s.Combat.k:2:1",
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        combatUuid: "Scene.s.Combat.k",
        round: 2,
        turn: 1,
        current: { name: "Tharivol", actorUuid: "Actor.thar", tokenUuid: "Scene.s.Token.t2", disposition: 1 },
        private: false,
      },
    });
  });

  it("prefers the marker's round and turn over the document's — the marker is what this event is about", () => {
    // The tracker has already moved on by the time a batch settles; the marker
    // still names the turn that actually changed.
    const envelope = buildCombatTurn(combat({ round: 9, turn: 5 }), marker, documentContext());
    expect(envelope?.payload).toMatchObject({ round: 2, turn: 1 });
    expect(envelope?.id).toBe("fvtt:combat:Scene.s.Combat.k:2:1");
  });

  it("falls back to the document when the hook carried no marker", () => {
    const envelope = buildCombatTurn(combat({ round: 4, turn: 3 }), null, documentContext());
    expect(envelope?.payload).toMatchObject({ round: 4, turn: 3 });
  });

  it("resolves the combatant through the collection's `get` when it has one", () => {
    const collection = {
      contents: [GOBLIN, THARIVOL],
      get: (id: string) => (id === "c1" ? GOBLIN : undefined),
    };
    const envelope = buildCombatTurn(combat({ combatants: collection }), { round: 1, turn: 0, combatantId: "c1" }, documentContext());

    expect(envelope?.payload.current?.name).toBe("Goblin");
  });

  it("finds the combatant by id in a plain array when there is no `get`", () => {
    const envelope = buildCombatTurn(combat(), { round: 1, turn: 0, combatantId: "c1" }, documentContext());
    expect(envelope?.payload.current?.name).toBe("Goblin");
  });

  it("falls back to combat.combatant when the marker names nobody", () => {
    const envelope = buildCombatTurn(
      combat({ combatant: GOBLIN }),
      { round: 1, turn: 0 },
      documentContext(),
    );
    expect(envelope?.payload.current?.name).toBe("Goblin");
  });

  it("emits with a null `current` rather than nothing when the roster names nobody", () => {
    const envelope = buildCombatTurn(
      combat({ combatants: [], combatant: null }),
      { round: 1, turn: 0, combatantId: "gone" },
      documentContext(),
    );

    expect(envelope?.payload.current).toBeNull();
    expect(envelope?.payload.round).toBe(1);
  });

  it("marks a hidden ambusher's turn private — the players have not been told", () => {
    const lurker = combatant({
      id: "c3",
      name: "Assassin",
      token: tokenDocument({ uuid: "Scene.s.Token.t3", hidden: true }),
    });
    const envelope = buildCombatTurn(
      combat({ combatants: [lurker] }),
      { round: 1, turn: 0, combatantId: "c3" },
      documentContext(),
    );

    expect(envelope?.payload.private).toBe(true);
  });

  it("leaves a visible combatant's turn public", () => {
    const envelope = buildCombatTurn(combat(), marker, documentContext());
    expect(envelope?.payload.private).toBe(false);
  });

  it("keys every turn distinctly, so a whole round replays as duplicates and not doubles", () => {
    const context = documentContext();
    const keys = [
      buildCombatTurn(combat(), { round: 1, turn: 0 }, context)?.id,
      buildCombatTurn(combat(), { round: 1, turn: 1 }, context)?.id,
      buildCombatTurn(combat(), { round: 2, turn: 0 }, context)?.id,
    ];

    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      "fvtt:combat:Scene.s.Combat.k:1:0",
      "fvtt:combat:Scene.s.Combat.k:1:1",
      "fvtt:combat:Scene.s.Combat.k:2:0",
    ]);
  });

  it("accepts round 0 and turn 0 — they are real indices, not missing values", () => {
    const envelope = buildCombatTurn(combat(), { round: 0, turn: 0 }, documentContext());
    expect(envelope?.id).toBe("fvtt:combat:Scene.s.Combat.k:0:0");
  });

  it("skips rather than inventing an index when the round or turn is unreadable", () => {
    // A guessed index would silently merge two real turns under one key, which
    // a skipped event never does.
    expect(buildCombatTurn(combat({ round: null, turn: 1 }), { turn: 1 }, documentContext())).toBeNull();
    expect(buildCombatTurn(combat({ round: 1, turn: null }), { round: 1 }, documentContext())).toBeNull();
  });

  it("skips a combat with no uuid, and MoT's own echo", () => {
    expect(buildCombatTurn(combat({ uuid: null }), marker, documentContext())).toBeNull();
    expect(buildCombatTurn(combat({ flags: bridgeOriginFlags() }), marker, documentContext())).toBeNull();
    expect(buildCombatTurn(null, marker, documentContext())).toBeNull();
  });
});

describe("buildCombatEnded", () => {
  it("reports how long the fight lasted", () => {
    const envelope = buildCombatEnded(combat({ round: 5 }), documentContext());

    expect(envelope).toEqual({
      v: 1,
      type: "combat.ended",
      id: "fvtt:combat:Scene.s.Combat.k:end",
      ts: "2026-08-17T20:14:03.000Z",
      payload: { combatUuid: "Scene.s.Combat.k", rounds: 5 },
    });
  });

  it("reports null rounds rather than zero when the tracker never said", () => {
    expect(buildCombatEnded(combat({ round: null }), documentContext())?.payload.rounds).toBeNull();
  });

  it("skips a combat with no uuid, and MoT's own echo", () => {
    expect(buildCombatEnded(combat({ uuid: null }), documentContext())).toBeNull();
    expect(buildCombatEnded(combat({ flags: bridgeOriginFlags() }), documentContext())).toBeNull();
    expect(buildCombatEnded(null, documentContext())).toBeNull();
  });
});

describe("registerCombatCapture", () => {
  function harness(active = true) {
    const hooks = createHooks();
    const emitted: Envelope[] = [];
    registerCombatCapture({
      hooks,
      isActive: () => active,
      context: () => documentContext(),
      emit: (envelope) => void emitted.push(envelope),
    });
    return { hooks, emitted };
  }

  it("registers exactly the three post-write core hooks", () => {
    const { hooks } = harness();
    expect([...hooks.handlers.keys()].sort()).toEqual(["combatStart", "combatTurnChange", "deleteCombat"]);
  });

  it("does NOT register createCombat — a combat existing is not a combat happening", () => {
    // Otherwise every encounter a GM builds on a Tuesday opens a battle report.
    const { hooks } = harness();
    expect(hooks.handlers.has("createCombat")).toBe(false);
  });

  it("emits on combatStart", () => {
    const { hooks, emitted } = harness();
    hooks.emit("combatStart", combat());

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("combat.started");
  });

  it("passes combatTurnChange's third argument — the *current* marker, not the prior one", () => {
    const { hooks, emitted } = harness();
    hooks.emit("combatTurnChange", combat(), { round: 1, turn: 0 }, { round: 1, turn: 1, combatantId: "c2" });

    expect(emitted[0]?.id).toBe("fvtt:combat:Scene.s.Combat.k:1:1");
  });

  it("emits on deleteCombat", () => {
    const { hooks, emitted } = harness();
    hooks.emit("deleteCombat", combat({ round: 3 }));

    expect(emitted[0]).toMatchObject({ type: "combat.ended", payload: { rounds: 3 } });
  });

  it("emits nothing at all when the activation gate is closed", () => {
    const { hooks, emitted } = harness(false);
    hooks.emit("combatStart", combat());
    hooks.emit("combatTurnChange", combat(), {}, { round: 1, turn: 0 });
    hooks.emit("deleteCombat", combat());

    expect(emitted).toEqual([]);
  });

  it("re-reads the gate per event, because activeGM moves mid-session", () => {
    const hooks = createHooks();
    const emitted: Envelope[] = [];
    let active = false;

    registerCombatCapture({
      hooks,
      isActive: () => active,
      context: () => documentContext(),
      emit: (envelope) => void emitted.push(envelope),
    });

    hooks.emit("deleteCombat", combat());
    expect(emitted).toHaveLength(0);

    // This client is promoted when the primary GM drops off the wifi.
    active = true;
    hooks.emit("deleteCombat", combat());
    expect(emitted).toHaveLength(1);
  });

  it("emits nothing for a builder that returned null rather than pushing it", () => {
    const { hooks, emitted } = harness();
    hooks.emit("combatStart", combat({ uuid: null }));
    expect(emitted).toEqual([]);
  });

  it("stamps every envelope with the Foundry mtime, not the send time", () => {
    const { hooks, emitted } = harness();
    hooks.emit("combatStart", combat());
    expect(emitted[0]?.ts).toBe(new Date(STUB_MTIME).toISOString());
  });
});
