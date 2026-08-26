import { describe, expect, it, vi } from "vitest";
import type { ActorLike, EncounterPlan, Placement, ResolvedEntry } from "../src/commands/encounters.js";
import {
  combatantData,
  combatData,
  createEncounterDeployHandler,
  deployInitiative,
  dragPayload,
  ensureCombat,
  expectedTokenCount,
  findSceneCombat,
  initiativeTargets,
  matchPlacedToken,
  MAX_ENCOUNTER_NAME_LENGTH,
  MAX_ENTRIES,
  MAX_ENTRY_NAME_LENGTH,
  MAX_QUANTITY,
  placementFor,
  planEncounterDeploy,
  resolveCombatApi,
  resolveEntries,
  UNNAMED_ENTRY,
} from "../src/commands/encounters.js";
import { createDispatcher } from "../src/commands/index.js";
import { MODULE_ID } from "../src/protocol/version.js";
import {
  CREATE_TOKEN_HOOK,
  DEFAULT_TITLE,
  EncounterTray,
  ROLL_LABEL,
  UNLINKED_NOTE,
  UNRESOLVED_NOTE,
} from "../src/ui/encounterTray.js";
import { asDocument, FakeDocument, FakeElement } from "./fakeDom.js";
import {
  createCombats,
  createHooks,
  createLog,
  FakeCombat,
  FakeCombatant,
  flushMicrotasks,
} from "./stubs.js";

const GOBLIN_ID = "aBcD1234efGh5678";

/** One row of a stage, as MoT sends it. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: "row-a", actorId: GOBLIN_ID, name: "Goblin", quantity: 3, ...overrides };
}

/** An `encounter.deploy` payload as MoT broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    encounterName: "Ambush at the Ford",
    stageName: "Stage 2 — reinforcements",
    entries: [entry()],
    rollInitiative: true,
    ...overrides,
  };
}

/** The one actor this world has. Everything else resolves to nothing. */
const WORLD: Record<string, ActorLike> = {
  [GOBLIN_ID]: { id: GOBLIN_ID, uuid: `Actor.${GOBLIN_ID}`, name: "Goblin", img: "icons/goblin.webp" },
};

function lookup(actorId: string): ActorLike | null {
  return WORLD[actorId] ?? null;
}

/** A plan straight off a payload, for the tests that start further down. */
function plan(overrides: Record<string, unknown> = {}): EncounterPlan {
  const built = planEncounterDeploy(payload(overrides));
  if (!built) throw new Error("the fixture payload should have planned");
  return built;
}

function resolved(overrides: Record<string, unknown> = {}): ResolvedEntry[] {
  return resolveEntries(plan(overrides), lookup);
}

// --------------------------------------------------------------------- plan

describe("planEncounterDeploy", () => {
  it("normalises the ordinary case", () => {
    expect(planEncounterDeploy(payload())).toEqual({
      encounterName: "Ambush at the Ford",
      stageName: "Stage 2 — reinforcements",
      entries: [{ key: "row-a", actorId: GOBLIN_ID, name: "Goblin", quantity: 3 }],
      rollInitiative: true,
    });
  });

  it("keeps an unlinked row — a bare name is a mook the GM places by hand", () => {
    const result = planEncounterDeploy(payload({ entries: [entry({ actorId: null, name: "Bandit boss" })] }));
    expect(result?.entries).toEqual([{ key: "row-a", actorId: null, name: "Bandit boss", quantity: 3 }]);
  });

  it("keeps an actorId this world may not have — resolving is a later question", () => {
    const result = planEncounterDeploy(payload({ entries: [entry({ actorId: "ghost", name: null })] }));
    expect(result?.entries[0]).toEqual({ key: "row-a", actorId: "ghost", name: null, quantity: 3 });
  });

  it("drops a row with neither a usable actorId nor a usable name", () => {
    const result = planEncounterDeploy(
      payload({ entries: [entry({ actorId: null, name: "   " }), entry({ key: "row-b" })] }),
    );
    expect(result?.entries.map((row) => row.key)).toEqual(["row-b"]);
  });

  it("drops a payload with nothing usable in it at all", () => {
    expect(planEncounterDeploy(payload({ entries: [] }))).toBeNull();
    expect(planEncounterDeploy(payload({ entries: undefined }))).toBeNull();
    expect(planEncounterDeploy(payload({ entries: "goblins" }))).toBeNull();
    expect(planEncounterDeploy(payload({ entries: [{}, null, 7, "goblin", []] }))).toBeNull();
  });

  it("drops anything that is not an object", () => {
    for (const bad of [null, undefined, "encounter", 7, [], [payload()]]) {
      expect(planEncounterDeploy(bad)).toBeNull();
    }
  });

  it("clamps quantity to 1..50 and whole numbers", () => {
    const quantities = [0, -5, 1, 3.7, 50, 500, Number.NaN, Number.POSITIVE_INFINITY];
    const result = planEncounterDeploy(
      payload({
        entries: quantities.map((quantity, index) => entry({ key: `row-${index}`, quantity })),
      }),
    );
    expect(result?.entries.map((row) => row.quantity)).toEqual([1, 1, 1, 3, 50, MAX_QUANTITY, 1, 1]);
  });

  it("reads a missing or non-numeric quantity as one, not as none", () => {
    // The row exists because the keeper put a monster on it.
    expect(planEncounterDeploy(payload({ entries: [entry({ quantity: undefined })] }))?.entries[0]?.quantity).toBe(1);
    expect(planEncounterDeploy(payload({ entries: [entry({ quantity: "3" })] }))?.entries[0]?.quantity).toBe(1);
  });

  it("caps the entry list", () => {
    const entries = Array.from({ length: MAX_ENTRIES + 20 }, (_, index) => entry({ key: `row-${index}` }));
    expect(planEncounterDeploy(payload({ entries }))?.entries).toHaveLength(MAX_ENTRIES);
  });

  it("strips markup out of the names and caps them", () => {
    const result = planEncounterDeploy(
      payload({
        encounterName: "<b>Ambush</b> at the Ford",
        stageName: "S".repeat(400),
        entries: [entry({ name: "<i>Goblin</i>" })],
      }),
    );

    expect(result?.encounterName).toBe("Ambush at the Ford");
    expect(result?.stageName).toHaveLength(MAX_ENCOUNTER_NAME_LENGTH);
    expect(result?.entries[0]?.name).toBe("Goblin");
    expect(planEncounterDeploy(payload({ entries: [entry({ name: "N".repeat(400) })] }))?.entries[0]?.name)
      .toHaveLength(MAX_ENTRY_NAME_LENGTH);
  });

  it("nulls the names MoT did not send rather than inventing one", () => {
    const result = planEncounterDeploy(payload({ encounterName: 7, stageName: null }));
    expect(result?.encounterName).toBeNull();
    expect(result?.stageName).toBeNull();
  });

  it("falls a row with no key back to its position, and breaks a duplicate the same way", () => {
    // The tray counts placements per key: two rows sharing one would count each
    // other's goblins.
    const result = planEncounterDeploy(
      payload({ entries: [entry({ key: undefined }), entry({ key: "row-a" }), entry({ key: "row-a" })] }),
    );
    expect(result?.entries.map((row) => row.key)).toEqual(["row-0", "row-a", "row-2"]);
  });

  it("refuses a key or an actorId with a control character in it", () => {
    const result = planEncounterDeploy(payload({ entries: [entry({ actorId: "aBcD\n1234", name: "Goblin" })] }));
    // Refused as an id, but the row survives on its name — an unlinked mook.
    expect(result?.entries[0]?.actorId).toBeNull();
  });

  it("reads a MISSING rollInitiative as false, never as true", () => {
    // Same direction as `planTargets` refusing to default `targets` to "all": a
    // field MoT failed to send must not be the one that starts a fight.
    expect(planEncounterDeploy(payload({ rollInitiative: undefined }))?.rollInitiative).toBe(false);
    expect(planEncounterDeploy(payload({ rollInitiative: "yes" }))?.rollInitiative).toBe(false);
    expect(planEncounterDeploy(payload({ rollInitiative: 1 }))?.rollInitiative).toBe(false);
    expect(planEncounterDeploy(payload({ rollInitiative: false }))?.rollInitiative).toBe(false);
    expect(planEncounterDeploy(payload({ rollInitiative: true }))?.rollInitiative).toBe(true);
  });
});

// ----------------------------------------------------------------- resolving

describe("resolveEntries", () => {
  it("attaches the actor a row points at", () => {
    expect(resolved()).toEqual([
      {
        key: "row-a",
        name: "Goblin",
        quantity: 3,
        actorId: GOBLIN_ID,
        uuid: `Actor.${GOBLIN_ID}`,
        img: "icons/goblin.webp",
        state: "ready",
      },
    ]);
  });

  it("marks a row MoT never linked as unlinked, and keeps it", () => {
    expect(resolved({ entries: [entry({ actorId: null, name: "Bandit boss", quantity: 1 })] })).toEqual([
      { key: "row-a", name: "Bandit boss", quantity: 1, actorId: null, uuid: null, img: null, state: "unlinked" },
    ]);
  });

  it("names an unlinked row with nothing to call it", () => {
    const entries = resolveEntries(
      { encounterName: null, stageName: null, rollInitiative: false, entries: [{ key: "k", actorId: null, name: null, quantity: 1 }] },
      lookup,
    );
    expect(entries[0]?.name).toBe(UNNAMED_ENTRY);
  });

  it("marks an actorId this world does not know as unresolved, and keeps it", () => {
    // The same shrug `image.show` takes about a target it cannot resolve.
    expect(resolved({ entries: [entry({ actorId: "ghost" })] })).toEqual([
      { key: "row-a", name: "Goblin", quantity: 3, actorId: "ghost", uuid: null, img: null, state: "unresolved" },
    ]);
  });

  it("falls an unresolved row with no name of its own back to the id", () => {
    expect(resolved({ entries: [entry({ actorId: "ghost", name: null })] })[0]?.name).toBe("ghost");
  });

  it("lets the actor's own name win — the tray names what will stand on the map", () => {
    const entries = resolveEntries(plan({ entries: [entry({ name: "Goblin (from MoT)" })] }), lookup);
    expect(entries[0]?.name).toBe("Goblin");
  });

  it("synthesises `Actor.<id>` for an actor document that carried no uuid", () => {
    const entries = resolveEntries(plan(), () => ({ id: GOBLIN_ID, name: "Goblin" }));
    expect(entries[0]?.uuid).toBe(`Actor.${GOBLIN_ID}`);
    expect(entries[0]?.state).toBe("ready");
  });

  it("treats an actor with no id at all as unresolved", () => {
    expect(resolveEntries(plan(), () => ({ name: "Goblin" }))[0]?.state).toBe("unresolved");
  });

  it("treats a lookup that throws as unresolved rather than as a failed deploy", () => {
    const entries = resolveEntries(plan(), () => {
      throw new Error("game.actors is not ready");
    });
    expect(entries[0]?.state).toBe("unresolved");
  });
});

describe("expectedTokenCount", () => {
  it("counts only the rows that can produce a token", () => {
    const entries = resolved({
      entries: [
        entry({ key: "a", quantity: 3 }),
        entry({ key: "b", actorId: null, name: "Bandit boss", quantity: 4 }),
        entry({ key: "c", actorId: "ghost", quantity: 5 }),
      ],
    });
    expect(expectedTokenCount(entries)).toBe(3);
  });

  it("is zero for a stage with nothing linked in it", () => {
    expect(expectedTokenCount(resolved({ entries: [entry({ actorId: null })] }))).toBe(0);
  });
});

// --------------------------------------------------------------- the drag

describe("dragPayload", () => {
  it("is exactly what a drag from Foundry's own actor directory carries", () => {
    expect(dragPayload(resolved()[0]!)).toEqual({ type: "Actor", uuid: `Actor.${GOBLIN_ID}` });
  });

  it("is null for a row with no actor behind it", () => {
    expect(dragPayload({ uuid: null })).toBeNull();
  });
});

// ------------------------------------------------------- what landed where

describe("matchPlacedToken", () => {
  const entries = resolved();

  it("matches on the resolved actor document", () => {
    expect(matchPlacedToken(entries, { id: "t1", actor: { id: GOBLIN_ID } })).toBe("row-a");
  });

  it("falls back to the token's raw actorId — a source object has no resolved actor", () => {
    expect(matchPlacedToken(entries, { id: "t1", actorId: GOBLIN_ID })).toBe("row-a");
  });

  it("is null for a token from some other fight entirely", () => {
    expect(matchPlacedToken(entries, { id: "t1", actorId: "someone-else" })).toBeNull();
  });

  it("is null for a token with no actor at all, and for junk", () => {
    expect(matchPlacedToken(entries, { id: "t1" })).toBeNull();
    expect(matchPlacedToken(entries, null)).toBeNull();
    expect(matchPlacedToken(entries, undefined)).toBeNull();
  });

  it("never matches an unlinked or unresolved row", () => {
    const greyed = resolved({ entries: [entry({ actorId: null, name: "Bandit boss" })] });
    expect(matchPlacedToken(greyed, { id: "t1", actorId: GOBLIN_ID })).toBeNull();
  });
});

describe("placementFor", () => {
  it("reads the scene off the token's parent", () => {
    expect(placementFor({ id: "t1", actor: { id: GOBLIN_ID }, parent: { id: "scene1" } }, "row-a")).toEqual({
      key: "row-a",
      tokenId: "t1",
      sceneId: "scene1",
      actorId: GOBLIN_ID,
    });
  });

  it("accepts a scene named directly, as an id or as a document", () => {
    expect(placementFor({ id: "t1", scene: "scene9" }, null)?.sceneId).toBe("scene9");
    expect(placementFor({ id: "t1", scene: { id: "scene9" } }, null)?.sceneId).toBe("scene9");
  });

  it("nulls a scene it cannot read rather than guessing one", () => {
    expect(placementFor({ id: "t1" }, null)?.sceneId).toBeNull();
  });

  it("is null for a token that carried no id to add", () => {
    expect(placementFor({ actorId: GOBLIN_ID }, "row-a")).toBeNull();
    expect(placementFor(null, "row-a")).toBeNull();
  });
});

// ------------------------------------------------------------- the combat

function placement(overrides: Partial<Placement> = {}): Placement {
  return { key: "row-a", tokenId: "t1", sceneId: "scene1", actorId: GOBLIN_ID, ...overrides };
}

describe("combatantData", () => {
  it("builds the createEmbeddedDocuments argument as a value", () => {
    expect(combatantData([placement()])).toEqual([
      { tokenId: "t1", sceneId: "scene1", actorId: GOBLIN_ID, hidden: false },
    ]);
  });

  it("deduplicates by token id — one goblin must not act twice", () => {
    expect(combatantData([placement(), placement(), placement({ tokenId: "t2" })])).toHaveLength(2);
  });

  it("drops a placement with no token id", () => {
    expect(combatantData([placement({ tokenId: "" }), placement({ tokenId: null as unknown as string })])).toEqual([]);
  });

  it("passes a null scene through rather than inventing one", () => {
    expect(combatantData([placement({ sceneId: null })])[0]?.sceneId).toBeNull();
  });
});

describe("initiativeTargets", () => {
  function combat(combatants: FakeCombatant[]): FakeCombat {
    return new FakeCombat("combat1", { combatants });
  }

  it("names the combatants standing on the tokens just placed", () => {
    const fight = combat([
      new FakeCombatant({ id: "c1", tokenId: "t1" }),
      new FakeCombatant({ id: "c2", tokenId: "t2" }),
    ]);
    expect(initiativeTargets(fight, ["t1", "t2"])).toEqual(["c1", "c2"]);
  });

  it("SKIPS a combatant that already rolled — the party's turn order is theirs", () => {
    // Reinforcements arriving in round three must not reshuffle a fight in
    // progress, and must not do it silently.
    const fight = combat([
      new FakeCombatant({ id: "pc", tokenId: "t1", initiative: 18 }),
      new FakeCombatant({ id: "c2", tokenId: "t2" }),
    ]);
    expect(initiativeTargets(fight, ["t1", "t2"])).toEqual(["c2"]);
  });

  it("ignores combatants this stage did not place", () => {
    const fight = combat([
      new FakeCombatant({ id: "c1", tokenId: "t1" }),
      new FakeCombatant({ id: "other", tokenId: "t9" }),
    ]);
    expect(initiativeTargets(fight, ["t1"])).toEqual(["c1"]);
  });

  it("deduplicates and survives combatants with nothing usable on them", () => {
    const fight = combat([
      new FakeCombatant({ id: "c1", tokenId: "t1" }),
      new FakeCombatant({ id: "c1", tokenId: "t1" }),
      new FakeCombatant({ id: "", tokenId: "t1" }),
      new FakeCombatant({ id: "c3", tokenId: null }),
    ]);
    expect(initiativeTargets(fight, ["t1"])).toEqual(["c1"]);
  });

  it("is empty when there is nothing to roll for, and when there is no combat", () => {
    expect(initiativeTargets(combat([new FakeCombatant({ id: "c1", tokenId: "t1" })]), [])).toEqual([]);
    expect(initiativeTargets(null, ["t1"])).toEqual([]);
    expect(initiativeTargets({ combatants: null }, ["t1"])).toEqual([]);
  });

  it("reads a plain array of combatants as happily as a collection", () => {
    expect(initiativeTargets({ combatants: [{ id: "c1", tokenId: "t1" }] }, ["t1"])).toEqual(["c1"]);
  });
});

// -------------------------------------------------------------- foundry glue

describe("resolveCombatApi", () => {
  it("prefers the v13+ namespace over the deprecated global", () => {
    const world = createCombats();
    const api = resolveCombatApi(world.v13Scope);

    expect(api).not.toBeNull();
    void api?.Combat.create({});
    expect(world.created).toHaveLength(1);
    expect(world.decoyed).toEqual([]);
  });

  it("falls back to a bare global", () => {
    const world = createCombats();
    void resolveCombatApi(world.legacyScope)?.Combat.create({});
    expect(world.created).toHaveLength(1);
  });

  it("is null in anything that is not a Foundry", () => {
    expect(resolveCombatApi({})).toBeNull();
    expect(resolveCombatApi(null)).toBeNull();
    expect(resolveCombatApi({ Combat: "nope" })).toBeNull();
    expect(resolveCombatApi({ Combat: () => undefined })).toBeNull();
  });
});

describe("findSceneCombat", () => {
  it("adopts the fight already running on this scene", () => {
    const here = new FakeCombat("c1", { scene: "scene1" });
    expect(findSceneCombat([new FakeCombat("c0", { scene: "other" }), here], "scene1")).toBe(here);
  });

  it("prefers the active one when a scene holds several", () => {
    const active = new FakeCombat("c2", { scene: "scene1", active: true });
    expect(findSceneCombat([new FakeCombat("c1", { scene: "scene1" }), active], "scene1")).toBe(active);
  });

  it("takes only an ACTIVE combat when there is no scene to match against", () => {
    // A client with no scene up cannot tell which map a token landed on, and
    // filing reinforcements into an unrelated fight is worse than making one.
    const idle = new FakeCombat("c1", { scene: "somewhere" });
    expect(findSceneCombat([idle], null)).toBeNull();

    const active = new FakeCombat("c2", { scene: "somewhere", active: true });
    expect(findSceneCombat([idle, active], null)).toBe(active);
  });

  it("is null when nothing matches, and survives junk", () => {
    expect(findSceneCombat([], "scene1")).toBeNull();
    expect(findSceneCombat(null, "scene1")).toBeNull();
    expect(findSceneCombat([null, 7, "combat"], "scene1")).toBeNull();
  });
});

describe("combatData", () => {
  it("files a new fight under the active scene", () => {
    expect(combatData("scene1")).toEqual({ scene: "scene1" });
  });

  it("omits `scene` entirely rather than filing at null", () => {
    expect(combatData(null)).toEqual({});
  });
});

describe("ensureCombat", () => {
  it("adopts the scene's existing fight rather than starting a second one", async () => {
    const world = createCombats({ combats: [new FakeCombat("c1", { scene: "scene1" })] });
    const combat = await ensureCombat(resolveCombatApi(world.v13Scope)!, world.world);

    expect(combat?.id).toBe("c1");
    expect(world.created).toEqual([]);
  });

  it("creates one and makes it the fight the tracker is showing", async () => {
    const world = createCombats();
    const combat = (await ensureCombat(resolveCombatApi(world.v13Scope)!, world.world)) as FakeCombat;

    expect(world.created).toEqual([{ scene: "scene1" }]);
    expect(combat.activations).toBe(1);
    expect(combat.active).toBe(true);
  });

  it("is null when Foundry refused to create one", async () => {
    const world = createCombats({ createReturnsNull: true });
    expect(await ensureCombat(resolveCombatApi(world.v13Scope)!, world.world)).toBeNull();
  });
});

// ---------------------------------------------------------- deployInitiative

describe("deployInitiative", () => {
  it("adds the placed tokens to the fight and asks Foundry to roll for them", async () => {
    const world = createCombats();
    const outcome = await deployInitiative(resolveCombatApi(world.v13Scope)!, world.world, [
      placement({ tokenId: "t1" }),
      placement({ tokenId: "t2" }),
    ]);

    const combat = world.last!;
    expect(combat.added).toEqual([
      [
        { tokenId: "t1", sceneId: "scene1", actorId: GOBLIN_ID, hidden: false },
        { tokenId: "t2", sceneId: "scene1", actorId: GOBLIN_ID, hidden: false },
      ],
    ]);
    expect(combat.rolled[0]?.map((id) => combat.combatants.get(id)?.tokenId)).toEqual(["t1", "t2"]);
    expect(outcome).toEqual({ added: 2, rolled: 2 });
  });

  it("leaves a character who was already in the fight out of the roll", async () => {
    const running = new FakeCombat("c1", {
      scene: "scene1",
      combatants: [new FakeCombatant({ id: "pc", tokenId: "pc1", initiative: 18 })],
    });
    const world = createCombats({ combats: [running] });

    await deployInitiative(resolveCombatApi(world.v13Scope)!, world.world, [placement({ tokenId: "t1" })]);

    expect(running.rolled[0]).not.toContain("pc");
    expect(running.combatants.get("pc")?.initiative).toBe(18);
  });

  it("falls back to rollAll on a Foundry whose Combat has no rollInitiative", async () => {
    const world = createCombats({ rolls: "all" });
    const outcome = await deployInitiative(resolveCombatApi(world.v13Scope)!, world.world, [placement()]);

    expect(world.last?.rollAllCalls).toBe(1);
    expect(outcome).toEqual({ added: 1, rolled: 1 });
  });

  it("leaves the tokens in the tracker when this Foundry cannot roll at all", async () => {
    const log = createLog();
    const world = createCombats({ rolls: "none" });
    const outcome = await deployInitiative(resolveCombatApi(world.v13Scope)!, world.world, [placement()], log);

    expect(world.last?.added).toHaveLength(1);
    expect(outcome).toEqual({ added: 1, rolled: 0 });
    expect(log.lines.warn).toHaveLength(1);
  });

  it("does not start a fight for a deploy with nothing placed in it", async () => {
    const world = createCombats();
    expect(await deployInitiative(resolveCombatApi(world.v13Scope)!, world.world, [])).toEqual({
      added: 0,
      rolled: 0,
    });
    expect(world.created).toEqual([]);
  });

  it("says so and stops when there is no combat to deploy into", async () => {
    const log = createLog();
    const world = createCombats({ createReturnsNull: true });
    const outcome = await deployInitiative(resolveCombatApi(world.v13Scope)!, world.world, [placement()], log);

    expect(outcome).toEqual({ added: 0, rolled: 0 });
    expect(log.lines.warn.join(" ")).toMatch(/no combat to deploy into/);
  });
});

// --------------------------------------------------------------- the handler

interface HandlerOptions {
  isActive?: boolean;
  openThrows?: boolean;
}

function handler(options: HandlerOptions = {}) {
  const log = createLog();
  const opened: Array<{ plan: EncounterPlan; entries: ResolvedEntry[] }> = [];

  const handle = createEncounterDeployHandler({
    isActive: () => options.isActive !== false,
    lookupActor: lookup,
    openTray: (built, entries) => {
      if (options.openThrows) throw new Error("no application layer");
      opened.push({ plan: built, entries });
    },
    log,
  });

  return { handle, opened, log };
}

describe("createEncounterDeployHandler", () => {
  it("opens the tray with the stage resolved against this world", () => {
    const table = handler();
    table.handle(payload());

    expect(table.opened).toHaveLength(1);
    expect(table.opened[0]?.plan.stageName).toBe("Stage 2 — reinforcements");
    expect(table.opened[0]?.entries[0]?.state).toBe("ready");
  });

  it("does nothing at all on a client that is not the active GM", () => {
    // Two GMs would otherwise get a tray each, and both would count the same
    // tokens landing.
    const table = handler({ isActive: false });
    table.handle(payload());
    expect(table.opened).toEqual([]);
  });

  it("drops a malformed command calmly", () => {
    const table = handler();
    table.handle(payload({ entries: [] }));
    table.handle(null);

    expect(table.opened).toEqual([]);
    expect(table.log.lines.debug).toHaveLength(2);
  });

  it("keeps a tray that would not open off the dispatcher's back", () => {
    const table = handler({ openThrows: true });
    expect(() => table.handle(payload())).not.toThrow();
    expect(table.log.lines.warn).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ the tray

const TRAY_ID = `${MODULE_ID}-encounter-tray`;

interface TrayOptions {
  entries?: Record<string, unknown>[];
  rollInitiative?: boolean;
}

function tray(options: TrayOptions = {}) {
  const doc = new FakeDocument(["interface"]);
  const hooks = createHooks();
  const log = createLog();
  const rolls: Placement[][] = [];

  const built = plan({
    entries: options.entries ?? [entry({ quantity: 2 })],
    rollInitiative: options.rollInitiative !== false,
  });

  const window = new EncounterTray({
    plan: built,
    entries: resolveEntries(built, lookup),
    hooks,
    rollInitiative: (placements) => void rolls.push(placements),
    document: asDocument(doc),
    log,
  });

  const element = (): FakeElement | null => doc.getElementById(TRAY_ID);
  const rows = (): FakeElement[] => element()?.querySelector(".mot-encounter-rows")?.children ?? [];
  /** A token landing on the map, as Foundry's `createToken` hook reports it. */
  const land = (tokenId: string, actorId: string = GOBLIN_ID): void =>
    hooks.emit(CREATE_TOKEN_HOOK, { id: tokenId, actor: { id: actorId }, parent: { id: "scene1" } });

  return { doc, hooks, log, rolls, tray: window, element, rows, land };
}

function textOf(row: FakeElement | undefined, className: string): string | undefined {
  return row?.children.find((child) => child.className.split(/\s+/).includes(className))?.textContent;
}

describe("EncounterTray rendering", () => {
  it("draws a row per entry, with the count, the name and a placed counter", () => {
    const table = tray();
    table.tray.open();

    expect(table.rows()).toHaveLength(1);
    expect(textOf(table.rows()[0], "mot-encounter-quantity")).toBe("2 ×");
    expect(textOf(table.rows()[0], "mot-encounter-name")).toBe("Goblin");
    expect(textOf(table.rows()[0], "mot-encounter-count")).toBe("0 / 2");
  });

  it("titles itself from the encounter and the stage, and falls back when MoT sent neither", () => {
    const table = tray();
    table.tray.open();
    expect(table.element()?.text).toContain("Ambush at the Ford");
    expect(table.element()?.text).toContain("Stage 2 — reinforcements");

    const doc = new FakeDocument(["interface"]);
    new EncounterTray({
      plan: { encounterName: null, stageName: null, rollInitiative: false, entries: [] },
      entries: [],
      hooks: createHooks(),
      rollInitiative: () => undefined,
      document: asDocument(doc),
    }).open();
    expect(doc.getElementById(TRAY_ID)?.text).toContain(DEFAULT_TITLE);
  });

  it("greys an unlinked row and says why, rather than dropping it", () => {
    const table = tray({ entries: [entry({ actorId: null, name: "Bandit boss" })] });
    table.tray.open();

    const row = table.rows()[0];
    expect(row?.classList.contains("is-unavailable")).toBe(true);
    expect(row?.draggable).toBe(false);
    expect(textOf(row, "mot-encounter-note")).toBe(UNLINKED_NOTE);
  });

  it("greys an unresolved row and says why", () => {
    const table = tray({ entries: [entry({ actorId: "ghost" })] });
    table.tray.open();
    expect(textOf(table.rows()[0], "mot-encounter-note")).toBe(UNRESOLVED_NOTE);
  });

  it("carries the actor's art when there is any", () => {
    const table = tray();
    table.tray.open();
    expect(table.rows()[0]?.children[0]?.src).toBe("icons/goblin.webp");
  });

  it("hands a drag exactly what Foundry's own actor directory would", () => {
    const table = tray();
    table.tray.open();

    const row = table.rows()[0]!;
    expect(row.draggable).toBe(true);

    const written: Array<[string, string]> = [];
    row.dispatch("dragstart", { dataTransfer: { setData: (a: string, b: string) => void written.push([a, b]) } });

    expect(written).toEqual([["text/plain", JSON.stringify({ type: "Actor", uuid: `Actor.${GOBLIN_ID}` })]]);
  });

  it("writes every string as text, never as markup — it all arrived over a socket", () => {
    const table = tray({ entries: [entry({ actorId: null, name: "Goblin & <Friend" })] });
    table.tray.open();

    const name = table.rows()[0]?.children.find((child) => child.className === "mot-encounter-name");
    expect(name?.textContent).toBe("Goblin & <Friend");
    expect(name?.children).toEqual([]);
  });

  it("injects its stylesheet once and is a silent no-op with no document at all", () => {
    const table = tray();
    table.tray.open();
    table.tray.close();
    table.tray.open();
    expect([...table.doc.head.descendants()].filter((el) => el.id === `${MODULE_ID}-encounter-style`)).toHaveLength(1);

    const headless = new EncounterTray({
      plan: plan(),
      entries: [],
      hooks: createHooks(),
      rollInitiative: () => undefined,
      document: undefined as unknown as Document,
    });
    expect(() => headless.open()).not.toThrow();
  });
});

describe("EncounterTray placements", () => {
  it("counts a token that landed and repaints the counter", () => {
    const table = tray();
    table.tray.open();
    table.land("t1");

    expect(textOf(table.rows()[0], "mot-encounter-count")).toBe("1 / 2");
    expect(table.tray.placed).toBe(1);
  });

  it("ignores a token that belongs to no row in this stage", () => {
    const table = tray();
    table.tray.open();
    table.land("t1", "someone-else");
    expect(table.tray.placed).toBe(0);
  });

  it("counts one token once, however many times Foundry mentions it", () => {
    const table = tray();
    table.tray.open();
    table.land("t1");
    table.land("t1");
    expect(table.tray.placed).toBe(1);
  });

  it("presses the roll button itself once every expected token is on the map", () => {
    const table = tray();
    table.tray.open();

    table.land("t1");
    expect(table.rolls).toEqual([]);

    table.land("t2");
    expect(table.rolls).toHaveLength(1);
    expect(table.rolls[0]?.map((row) => row.tokenId)).toEqual(["t1", "t2"]);
  });

  it("presses it once, not once per token that lands afterwards", () => {
    const table = tray();
    table.tray.open();
    table.land("t1");
    table.land("t2");
    table.land("t3");
    expect(table.rolls).toHaveLength(1);
  });

  it("stays pressable for a partial deploy — four of six goblins is a choice", () => {
    const table = tray({ entries: [entry({ quantity: 6 })] });
    table.tray.open();
    table.land("t1");
    table.land("t2");

    const button = table.element()?.querySelector(".mot-encounter-roll");
    expect(button?.textContent).toBe(ROLL_LABEL);
    button?.click();

    expect(table.rolls).toHaveLength(1);
    expect(table.rolls[0]?.map((row) => row.tokenId)).toEqual(["t1", "t2"]);
  });

  it("hands each press only what has landed since the last one", () => {
    const table = tray({ entries: [entry({ quantity: 6 })] });
    table.tray.open();
    const press = (): void => {
      table.element()?.querySelector(".mot-encounter-roll")?.click();
    };

    table.land("t1");
    press();
    table.land("t2");
    press();
    // …and a press with nothing new is a no-op rather than a second combatant.
    press();

    expect(table.rolls.map((batch) => batch.map((row) => row.tokenId))).toEqual([["t1"], ["t2"]]);
  });

  it("carries the scene and the actor through to the placement", () => {
    const table = tray({ entries: [entry({ quantity: 1 })] });
    table.tray.open();
    table.land("t1");

    expect(table.rolls[0]).toEqual([{ key: "row-a", tokenId: "t1", sceneId: "scene1", actorId: GOBLIN_ID }]);
  });

  it("neither rolls nor offers a button when MoT said tray only", () => {
    const table = tray({ rollInitiative: false });
    table.tray.open();
    table.land("t1");
    table.land("t2");

    expect(table.rolls).toEqual([]);
    expect(table.element()?.querySelector(".mot-encounter-roll")).toBeNull();
  });

  it("never auto-presses for a stage with nothing linked in it", () => {
    const table = tray({ entries: [entry({ actorId: null, name: "Bandit boss" })] });
    table.tray.open();
    expect(table.rolls).toEqual([]);
  });
});

describe("EncounterTray closing", () => {
  it("takes its hook off — a tray left listening would count the next fight's tokens", () => {
    const table = tray();
    table.tray.open();
    expect(table.hooks.handlers.get(CREATE_TOKEN_HOOK)).toHaveLength(1);

    table.tray.close();

    expect(table.hooks.handlers.get(CREATE_TOKEN_HOOK)).toHaveLength(0);
    expect(table.element()).toBeNull();
    expect(table.tray.isOpen).toBe(false);
  });

  it("counts nothing after it is closed, even if a hook still reaches it", () => {
    const table = tray();
    table.tray.open();
    const [handle] = table.hooks.handlers.get(CREATE_TOKEN_HOOK) ?? [];
    table.tray.close();

    handle?.({ id: "t1", actor: { id: GOBLIN_ID } });
    handle?.({ id: "t2", actor: { id: GOBLIN_ID } });

    expect(table.tray.placed).toBe(0);
    expect(table.rolls).toEqual([]);
  });

  it("closes from its own close button, and a second close is a no-op", () => {
    const table = tray();
    table.tray.open();
    table.element()?.querySelector(".mot-encounter-close")?.click();
    expect(table.element()).toBeNull();

    expect(() => table.tray.close()).not.toThrow();
    expect(table.hooks.handlers.get(CREATE_TOKEN_HOOK)).toHaveLength(0);
  });

  it("opens once, however often `open` is called", () => {
    const table = tray();
    table.tray.open();
    table.tray.open();
    expect(table.hooks.handlers.get(CREATE_TOKEN_HOOK)).toHaveLength(1);
  });

  it("reports a roll callback that threw rather than letting it escape the hook", () => {
    const doc = new FakeDocument(["interface"]);
    const hooks = createHooks();
    const log = createLog();
    const built = plan({ entries: [entry({ quantity: 1 })] });

    new EncounterTray({
      plan: built,
      entries: resolveEntries(built, lookup),
      hooks,
      rollInitiative: () => {
        throw new Error("no canvas");
      },
      document: asDocument(doc),
      log,
    }).open();

    expect(() => hooks.emit(CREATE_TOKEN_HOOK, { id: "t1", actor: { id: GOBLIN_ID } })).not.toThrow();
    expect(log.lines.warn).toHaveLength(1);
  });
});

// ------------------------------------------------------------ end to end

describe("encounter.deploy through the dispatcher", () => {
  it("carries one MoT command to a tray, a drag and a roll", async () => {
    const doc = new FakeDocument(["interface"]);
    const hooks = createHooks();
    const world = createCombats();
    const opened: EncounterTray[] = [];

    const dispatch = createDispatcher({
      onSession: vi.fn(),
      onEncounterDeploy: createEncounterDeployHandler({
        isActive: () => true,
        lookupActor: lookup,
        openTray: (built, entries) => {
          const window = new EncounterTray({
            plan: built,
            entries,
            hooks,
            rollInitiative: (placements) =>
              void deployInitiative(resolveCombatApi(world.v13Scope)!, world.world, placements),
            document: asDocument(doc),
          });
          opened.push(window);
          window.open();
        },
      }),
    });

    dispatch({
      v: 1,
      type: "encounter.deploy",
      ts: "2026-08-25T20:00:00.000Z",
      payload: payload({ entries: [entry({ quantity: 2 })] }),
    });

    expect(doc.getElementById(TRAY_ID)).not.toBeNull();
    expect(opened[0]?.isOpen).toBe(true);

    hooks.emit(CREATE_TOKEN_HOOK, { id: "t1", actor: { id: GOBLIN_ID }, parent: { id: "scene1" } });
    hooks.emit(CREATE_TOKEN_HOOK, { id: "t2", actor: { id: GOBLIN_ID }, parent: { id: "scene1" } });
    await flushMicrotasks(20);

    const combat = world.last!;
    expect(combat.added[0]?.map((row) => row.tokenId)).toEqual(["t1", "t2"]);
    expect(combat.rolled[0]).toHaveLength(2);
  });

  it("treats encounter.deploy with no handler wired as an unknown type rather than a fault", () => {
    const log = createLog();
    const dispatch = createDispatcher({ onSession: vi.fn(), log });

    dispatch({ v: 1, type: "encounter.deploy", ts: "2026-08-25T20:00:00.000Z", payload: payload() });

    expect(log.lines.debug).toEqual(['[masteroftales-bridge] no renderer wired for "encounter.deploy"']);
  });
});
