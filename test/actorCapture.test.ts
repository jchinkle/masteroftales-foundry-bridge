import { describe, expect, it } from "vitest";
import {
  buildActorAppeared,
  buildActorUpdate,
  buildCombatantDefeat,
  buildEffectChange,
  buildTokenUpdate,
  effectLabel,
  effectStatuses,
  extractHp,
  findHp,
  registerActorCapture,
  subjectFromActor,
  subjectFromToken,
  subjectUuid,
} from "../src/capture/actors.js";
import { bridgeOriginFlags } from "../src/capture/loopGuard.js";
import { PriorValues } from "../src/capture/priorValues.js";
import type { Envelope } from "../src/protocol/types.js";
import {
  actorDocument,
  activeEffect,
  combatant,
  createHooks,
  documentContext,
  itemDocument,
  STUB_MTIME,
  tokenDocument,
} from "./stubs.js";

/** dnd5e's shape, and the one `system.attributes.hp` path covers most of the d20 family. */
function hp(value: number, max = 30) {
  return { attributes: { hp: { value, max } } };
}

describe("subject resolution", () => {
  it("resolves a world actor with no token", () => {
    const actor = actorDocument({ uuid: "Actor.thar", name: "Tharivol", system: hp(24) });
    expect(subjectFromActor(actor)).toEqual({
      actorUuid: "Actor.thar",
      tokenUuid: null,
      name: "Tharivol",
      private: false,
      system: hp(24),
    });
  });

  it("resolves a synthetic actor's token — so an updateActor on a mook still carries the token", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", hidden: true });
    const actor = actorDocument({ uuid: "Actor.gob", name: "Goblin", token, system: hp(3, 7) });

    expect(subjectFromActor(actor)).toMatchObject({
      actorUuid: "Actor.gob",
      tokenUuid: "Scene.s.Token.t1",
      private: true,
    });
  });

  it("resolves a token through its synthetic actor, which has the overrides applied", () => {
    const actor = actorDocument({ uuid: "Actor.gob", name: "Goblin", system: hp(3, 7) });
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", name: "Goblin A", actor });

    expect(subjectFromToken(token)).toEqual({
      actorUuid: "Actor.gob",
      tokenUuid: "Scene.s.Token.t1",
      name: "Goblin A",
      private: false,
      system: hp(3, 7),
    });
  });

  it("falls back to the raw delta when Foundry built no synthetic actor", () => {
    const token = tokenDocument({ actor: null, delta: { system: hp(5, 7) } });
    expect(subjectFromToken(token).system).toEqual(hp(5, 7));
  });

  it("reads the v10 `actorData` spelling too", () => {
    const token = tokenDocument({ actor: null, actorData: { system: hp(5, 7) } });
    expect(subjectFromToken(token).system).toEqual(hp(5, 7));
  });

  it("keys on the token where there is one — four goblins are four pools, not one", () => {
    const a = subjectFromToken(tokenDocument({ uuid: "Scene.s.Token.a", actor: actorDocument({ uuid: "Actor.gob" }) }));
    const b = subjectFromToken(tokenDocument({ uuid: "Scene.s.Token.b", actor: actorDocument({ uuid: "Actor.gob" }) }));

    expect(subjectUuid(a)).toBe("Scene.s.Token.a");
    expect(subjectUuid(b)).toBe("Scene.s.Token.b");
    expect(subjectUuid(a)).not.toBe(subjectUuid(b));
  });

  it("falls back to the actor uuid for a linked character", () => {
    expect(subjectUuid(subjectFromActor(actorDocument({ uuid: "Actor.thar" })))).toBe("Actor.thar");
  });
});

describe("findHp — where hit points live is a system question", () => {
  it("finds the d20-family path", () => {
    expect(findHp(hp(12))?.path).toEqual(["attributes", "hp"]);
  });

  it("finds the flatter spellings other systems use", () => {
    expect(findHp({ hp: { value: 3 } })?.path).toEqual(["hp"]);
    expect(findHp({ health: { value: 3 } })?.path).toEqual(["health"]);
    expect(findHp({ attributes: { health: { value: 3 } } })?.path).toEqual(["attributes", "health"]);
  });

  it("prefers the first listed path when a system carries two", () => {
    expect(findHp({ ...hp(12), hp: { value: 99 } })?.node).toEqual({ value: 12, max: 30 });
  });

  it("is null for a system that keeps hit points somewhere else entirely", () => {
    // The whole point: no damage lines beats wrong damage lines.
    expect(findHp({ vitality: { current: 4 } })).toBeNull();
    expect(findHp(null)).toBeNull();
  });
});

describe("extractHp", () => {
  const subject = subjectFromActor(actorDocument({ uuid: "Actor.thar", system: hp(12) }));

  it("reports from, to and max once a previous value is known", () => {
    const prior = new PriorValues();
    prior.remember("hp:Actor.thar", { value: 24, max: 30 });

    expect(extractHp(subject, hp(12), "Actor.thar", prior)).toEqual({ from: 24, to: 12, max: 30 });
  });

  it("reports `from: null` on first sighting rather than guessing", () => {
    expect(extractHp(subject, hp(12), "Actor.thar", new PriorValues())).toEqual({
      from: null,
      to: 12,
      max: 30,
    });
  });

  it("remembers both halves of the pool, so the next change has a delta", () => {
    const prior = new PriorValues();
    extractHp(subject, hp(12), "Actor.thar", prior);
    expect(prior.recall("hp:Actor.thar")).toEqual({ value: 12, max: 30 });
  });

  it("takes `to` from the document, which is authoritative after the write", () => {
    const doc = subjectFromActor(actorDocument({ system: hp(8, 30) }));
    // The diff says only that hp moved; the document says where it landed.
    expect(extractHp(doc, { attributes: { hp: { value: 8 } } }, "u", new PriorValues())?.to).toBe(8);
  });

  it("falls back to the diff when there is no document data", () => {
    const bare = { actorUuid: "Actor.x", tokenUuid: null, name: null, private: false, system: null };
    expect(extractHp(bare, hp(5, 9), "u", new PriorValues())).toEqual({ from: null, to: 5, max: 9 });
  });

  it("is null when the update was not about hit points at all", () => {
    expect(extractHp(subject, { name: "renamed" }, "u", new PriorValues())).toBeNull();
    expect(extractHp(subject, null, "u", new PriorValues())).toBeNull();
  });

  it("is null for a temp-hp-only change — core has nothing to say, the adapter does", () => {
    const touched = { attributes: { hp: { temp: 15 } } };
    expect(extractHp(subject, touched, "u", new PriorValues())).toBeNull();
  });

  it("suppresses a no-op write of the same pool — a sheet save is not a wound", () => {
    const prior = new PriorValues();
    prior.remember("hp:Actor.thar", { value: 12, max: 30 });

    // dnd5e writes the whole hp object back on an ordinary save, so `max` being
    // present in the diff is not evidence that anything moved.
    expect(extractHp(subject, hp(12), "Actor.thar", prior)).toBeNull();
  });

  it("still reports an unchanged value when the maximum actually moved — that is a level-up", () => {
    const prior = new PriorValues();
    prior.remember("hp:Actor.thar", { value: 12, max: 24 });

    const levelled = subjectFromActor(actorDocument({ uuid: "Actor.thar", system: hp(12, 38) }));
    expect(extractHp(levelled, hp(12, 38), "Actor.thar", prior)).toEqual({ from: 12, to: 12, max: 38 });
  });

  it("reports a null max rather than zero when the system does not publish one", () => {
    const bare = { actorUuid: "a", tokenUuid: null, name: null, private: false, system: null };
    expect(extractHp(bare, { hp: { value: 4 } }, "u", new PriorValues())?.max).toBeNull();
  });

  it("is null when the new value is unreadable", () => {
    const bare = { actorUuid: "a", tokenUuid: null, name: null, private: false, system: null };
    expect(extractHp(bare, { hp: { value: "twelve" } }, "u", new PriorValues())).toBeNull();
  });

  it("accepts zero — a creature dropping to exactly 0 is the most important line there is", () => {
    const bare = { actorUuid: "a", tokenUuid: null, name: null, private: false, system: null };
    expect(extractHp(bare, { hp: { value: 0, max: 7 } }, "u", new PriorValues())).toEqual({
      from: null,
      to: 0,
      max: 7,
    });
  });
});

describe("buildActorAppeared", () => {
  const token = tokenDocument({
    uuid: "Scene.s.Token.t1",
    name: "Goblin A",
    disposition: -1,
    texture: { src: "tokens/goblin.webp" },
    actor: actorDocument({ uuid: "Actor.gob", system: hp(7, 7) }),
  });

  it("emits the whole appearance", () => {
    expect(buildActorAppeared(token, documentContext())).toEqual({
      v: 1,
      type: "actor.appeared",
      id: "fvtt:token:Scene.s.Token.t1:appeared",
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        actorUuid: "Actor.gob",
        tokenUuid: "Scene.s.Token.t1",
        name: "Goblin A",
        disposition: -1,
        imageUrl: "tokens/goblin.webp",
        private: false,
      },
    });
  });

  it("marks a hidden token private — the v1 privacy rule", () => {
    const lurker = tokenDocument({ uuid: "Scene.s.Token.t9", hidden: true });
    expect(buildActorAppeared(lurker, documentContext())?.payload.private).toBe(true);
  });

  it("seeds the hp memory so the token's FIRST wound already has a `from`", () => {
    const context = documentContext();
    buildActorAppeared(token, context);

    const hurt = tokenDocument({
      uuid: "Scene.s.Token.t1",
      actor: actorDocument({ uuid: "Actor.gob", system: hp(2, 7) }),
    });
    const envelope = buildTokenUpdate(hurt, { delta: { system: hp(2, 7) } }, context);

    expect(envelope?.payload.hp).toEqual({ from: 7, to: 2, max: 7 });
  });

  it("keys on the token uuid alone — an appearance needs no timestamp to be replay-safe", () => {
    const context = documentContext();
    expect(buildActorAppeared(token, context)?.id).toBe(buildActorAppeared(token, context)?.id);
  });

  it("reports nulls rather than guesses for a bare token", () => {
    const bare = tokenDocument({ uuid: "Scene.s.Token.x", name: null, disposition: null, actor: null });
    expect(buildActorAppeared(bare, documentContext())?.payload).toMatchObject({
      actorUuid: null,
      name: null,
      disposition: null,
      imageUrl: null,
    });
  });

  it("skips a token with no uuid, and MoT's own echo", () => {
    expect(buildActorAppeared(tokenDocument({ uuid: null }), documentContext())).toBeNull();
    expect(buildActorAppeared(tokenDocument({ flags: bridgeOriginFlags() }), documentContext())).toBeNull();
    expect(buildActorAppeared(null, documentContext())).toBeNull();
  });
});

describe("buildActorUpdate — the linked half", () => {
  it("emits actor.changed with the hp delta", () => {
    const context = documentContext();
    context.prior.remember("hp:Actor.thar", { value: 24, max: 30 });

    const actor = actorDocument({ uuid: "Actor.thar", name: "Tharivol", system: hp(12) });
    expect(buildActorUpdate(actor, { system: hp(12) }, context)).toEqual({
      v: 1,
      type: "actor.changed",
      id: `fvtt:actor:Actor.thar:${STUB_MTIME}`,
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        actorUuid: "Actor.thar",
        tokenUuid: null,
        name: "Tharivol",
        private: false,
        hp: { from: 24, to: 12, max: 30 },
      },
    });
  });

  it("emits nothing for an update that did not touch hit points", () => {
    const actor = actorDocument({ uuid: "Actor.thar", system: hp(12) });
    expect(buildActorUpdate(actor, { name: "Renamed" }, documentContext())).toBeNull();
  });

  it("falls back to the sequence counter for a document with no mtime — never a wall clock", () => {
    const actor = actorDocument({ uuid: "Actor.thar", system: hp(12), modifiedTime: null });
    expect(buildActorUpdate(actor, { system: hp(12) }, documentContext())?.id).toBe("fvtt:actor:Actor.thar:s1");
  });

  it("skips an actor with no uuid, and MoT's own echo", () => {
    const noUuid = actorDocument({ uuid: null, system: hp(12) });
    expect(buildActorUpdate(noUuid, { system: hp(12) }, documentContext())).toBeNull();

    const echo = actorDocument({ uuid: "Actor.a", system: hp(12), flags: bridgeOriginFlags() });
    expect(buildActorUpdate(echo, { system: hp(12) }, documentContext())).toBeNull();
    expect(buildActorUpdate(null, {}, documentContext())).toBeNull();
  });

  it("carries the adapter's ext and nothing outside it", () => {
    const context = documentContext({
      adapter: { ...documentContext().adapter, actorExt: () => ({ dnd5e: { tempHp: 5 } }) },
    });
    const actor = actorDocument({ uuid: "Actor.thar", system: hp(12) });
    const envelope = buildActorUpdate(actor, { system: hp(12) }, context);

    expect(envelope?.ext).toEqual({ dnd5e: { tempHp: 5 } });
  });

  it("omits ext entirely for a generic system rather than shipping `ext: {}`", () => {
    const actor = actorDocument({ uuid: "Actor.thar", system: hp(12) });
    expect(buildActorUpdate(actor, { system: hp(12) }, documentContext())).not.toHaveProperty("ext");
  });
});

describe("buildTokenUpdate — the unlinked half, and the classic miss", () => {
  const actor = actorDocument({ uuid: "Actor.gob", name: "Goblin", system: hp(2, 7) });

  it("reads the hp out of the v11+ `delta`", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", name: "Goblin A", actor });
    const envelope = buildTokenUpdate(token, { delta: { system: hp(2, 7) } }, documentContext());

    expect(envelope).toMatchObject({
      type: "actor.changed",
      id: `fvtt:actor:Scene.s.Token.t1:${STUB_MTIME}`,
      payload: {
        actorUuid: "Actor.gob",
        tokenUuid: "Scene.s.Token.t1",
        name: "Goblin A",
        hp: { from: null, to: 2, max: 7 },
      },
    });
  });

  it("reads the v10 `actorData` spelling — the rename that would silently kill mook damage", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", actor });
    const envelope = buildTokenUpdate(token, { actorData: { system: hp(2, 7) } }, documentContext());

    expect(envelope?.payload.hp).toEqual({ from: null, to: 2, max: 7 });
  });

  it("keys four identical goblins apart", () => {
    const context = documentContext();
    const ids = ["a", "b", "c", "d"].map((suffix) => {
      const token = tokenDocument({ uuid: `Scene.s.Token.${suffix}`, actor });
      return buildTokenUpdate(token, { delta: { system: hp(2, 7) } }, context)?.id;
    });

    expect(new Set(ids).size).toBe(4);
  });

  it("marks a hidden token's damage private", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", hidden: true, actor });
    const envelope = buildTokenUpdate(token, { delta: { system: hp(2, 7) } }, documentContext());

    expect(envelope?.payload.private).toBe(true);
  });

  it("emits nothing for a token update that only moved it across the map", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", actor });
    expect(buildTokenUpdate(token, { x: 1200, y: 400 }, documentContext())).toBeNull();
  });

  it("emits nothing for a visibility toggle alone", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", hidden: true, actor });
    expect(buildTokenUpdate(token, { hidden: true }, documentContext())).toBeNull();
  });

  it("skips MoT's own echo", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", actor, flags: bridgeOriginFlags() });
    expect(buildTokenUpdate(token, { delta: { system: hp(2, 7) } }, documentContext())).toBeNull();
    expect(buildTokenUpdate(null, {}, documentContext())).toBeNull();
  });
});

describe("effect readers", () => {
  it("reads the v11+ `name` and the v10 `label`", () => {
    expect(effectLabel(activeEffect({ name: "Poisoned" }))).toBe("Poisoned");
    expect(effectLabel(activeEffect({ name: null, label: "Poisoned" }))).toBe("Poisoned");
    expect(effectLabel(activeEffect({ name: null, label: null }))).toBeNull();
  });

  it("reads statuses from a v11+ Set", () => {
    expect(effectStatuses(activeEffect({ statuses: new Set(["poisoned"]) }))).toEqual(["poisoned"]);
  });

  it("reads statuses from an array", () => {
    expect(effectStatuses(activeEffect({ statuses: ["dead"] }))).toEqual(["dead"]);
  });

  it("reads the v10 flags.core.statusId", () => {
    expect(effectStatuses(activeEffect({ statuses: null, flags: { core: { statusId: "dead" } } }))).toEqual([
      "dead",
    ]);
  });

  it("deduplicates and lowercases a world that carries both spellings", () => {
    const effect = activeEffect({ statuses: new Set(["Dead"]), flags: { core: { statusId: "dead" } } });
    expect(effectStatuses(effect)).toEqual(["dead"]);
  });

  it("is an empty list, not an error, for an effect with no statuses", () => {
    expect(effectStatuses(activeEffect({ statuses: null }))).toEqual([]);
    expect(effectStatuses(null)).toEqual([]);
  });
});

describe("buildEffectChange", () => {
  const parent = actorDocument({ uuid: "Actor.thar", name: "Tharivol" });

  it("reports a condition arriving", () => {
    const effect = activeEffect({ uuid: "Actor.thar.ActiveEffect.e1", name: "Poisoned", parent });

    expect(buildEffectChange(effect, "added", documentContext())).toEqual({
      v: 1,
      type: "actor.changed",
      id: "fvtt:effect:Actor.thar.ActiveEffect.e1:added",
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        actorUuid: "Actor.thar",
        tokenUuid: null,
        name: "Tharivol",
        private: false,
        conditions: { added: ["Poisoned"] },
      },
    });
  });

  it("reports a condition lifting", () => {
    const effect = activeEffect({ uuid: "Actor.thar.ActiveEffect.e1", name: "Poisoned", parent });
    const envelope = buildEffectChange(effect, "removed", documentContext());

    expect(envelope?.id).toBe("fvtt:effect:Actor.thar.ActiveEffect.e1:removed");
    expect(envelope?.payload.conditions).toEqual({ removed: ["Poisoned"] });
    expect(envelope?.payload.conditions).not.toHaveProperty("added");
  });

  it("sets `defeated` from the `dead` status effect", () => {
    const effect = activeEffect({ name: "Dead", statuses: new Set(["dead"]), parent });
    expect(buildEffectChange(effect, "added", documentContext())?.payload).toMatchObject({
      defeated: true,
      conditions: { added: ["Dead"] },
    });
  });

  it("clears `defeated` when the dead effect is removed", () => {
    const effect = activeEffect({ name: "Dead", statuses: new Set(["dead"]), parent });
    expect(buildEffectChange(effect, "removed", documentContext())?.payload.defeated).toBe(false);
  });

  it("also accepts `defeated` as a status id", () => {
    const effect = activeEffect({ name: "Defeated", statuses: ["defeated"], parent });
    expect(buildEffectChange(effect, "added", documentContext())?.payload.defeated).toBe(true);
  });

  it("does NOT treat unconscious as dead — a downed PC is a different sentence", () => {
    const effect = activeEffect({ name: "Unconscious", statuses: new Set(["unconscious"]), parent });
    const payload = buildEffectChange(effect, "added", documentContext())?.payload;

    expect(payload).not.toHaveProperty("defeated");
    expect(payload?.conditions).toEqual({ added: ["Unconscious"] });
  });

  it("labels an unnamed effect with its status id", () => {
    const effect = activeEffect({ name: null, label: null, statuses: new Set(["prone"]), parent });
    expect(buildEffectChange(effect, "added", documentContext())?.payload.conditions).toEqual({ added: ["prone"] });
  });

  it("emits nothing for an anonymous mechanical effect — no name, no status, no sentence", () => {
    const effect = activeEffect({ name: null, label: null, statuses: null, parent });
    expect(buildEffectChange(effect, "added", documentContext())).toBeNull();
  });

  it("ignores an effect on an Item — the +1 sword is not poisoned", () => {
    const effect = activeEffect({ name: "Poisoned", parent: itemDocument() });
    expect(buildEffectChange(effect, "added", documentContext())).toBeNull();
  });

  it("ignores an effect with no parent at all", () => {
    expect(buildEffectChange(activeEffect({ parent: null }), "added", documentContext())).toBeNull();
  });

  it("carries the token uuid and privacy of an unlinked parent", () => {
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", hidden: true });
    const synthetic = actorDocument({ uuid: "Actor.gob", token });
    const effect = activeEffect({ name: "Prone", parent: synthetic });

    expect(buildEffectChange(effect, "added", documentContext())?.payload).toMatchObject({
      tokenUuid: "Scene.s.Token.t1",
      private: true,
    });
  });

  it("keys off the effect uuid, so poison → cure → poison is three events", () => {
    const context = documentContext();
    const keys = [
      buildEffectChange(activeEffect({ uuid: "A.b.ActiveEffect.e1", parent }), "added", context)?.id,
      buildEffectChange(activeEffect({ uuid: "A.b.ActiveEffect.e1", parent }), "removed", context)?.id,
      buildEffectChange(activeEffect({ uuid: "A.b.ActiveEffect.e2", parent }), "added", context)?.id,
    ];

    expect(new Set(keys).size).toBe(3);
  });

  it("falls back to a parent-and-stamp key for an effect with no uuid", () => {
    const effect = activeEffect({ uuid: null, name: "Poisoned", parent });
    expect(buildEffectChange(effect, "added", documentContext())?.id).toBe(
      `fvtt:effect:Actor.thar:${STUB_MTIME}:added`,
    );
  });

  it("skips MoT's own echo", () => {
    const effect = activeEffect({ name: "Poisoned", parent, flags: bridgeOriginFlags() });
    expect(buildEffectChange(effect, "added", documentContext())).toBeNull();
    expect(buildEffectChange(null, "added", documentContext())).toBeNull();
  });
});

describe("buildCombatantDefeat", () => {
  const goblin = combatant({
    uuid: "Scene.s.Combat.k.Combatant.c1",
    name: "Goblin",
    actor: actorDocument({ uuid: "Actor.gob" }),
    token: tokenDocument({ uuid: "Scene.s.Token.t1" }),
  });

  it("reports the tracker's skull button", () => {
    expect(buildCombatantDefeat(goblin, { defeated: true }, documentContext())).toEqual({
      v: 1,
      type: "actor.changed",
      id: `fvtt:combatant:Scene.s.Combat.k.Combatant.c1:${STUB_MTIME}`,
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        actorUuid: "Actor.gob",
        tokenUuid: "Scene.s.Token.t1",
        name: "Goblin",
        private: false,
        defeated: true,
      },
    });
  });

  it("reports the flag being cleared as well as set", () => {
    expect(buildCombatantDefeat(goblin, { defeated: false }, documentContext())?.payload.defeated).toBe(false);
  });

  it("emits nothing for a combatant update that did not move the flag", () => {
    expect(buildCombatantDefeat(goblin, { initiative: 17 }, documentContext())).toBeNull();
    expect(buildCombatantDefeat(goblin, {}, documentContext())).toBeNull();
    expect(buildCombatantDefeat(goblin, null, documentContext())).toBeNull();
  });

  it("refuses a truthy non-boolean rather than reading it as defeat", () => {
    expect(buildCombatantDefeat(goblin, { defeated: 1 }, documentContext())).toBeNull();
  });

  it("marks a hidden combatant's defeat private", () => {
    const lurker = combatant({
      uuid: "Scene.s.Combat.k.Combatant.c2",
      token: tokenDocument({ hidden: true }),
    });
    expect(buildCombatantDefeat(lurker, { defeated: true }, documentContext())?.payload.private).toBe(true);
  });

  it("skips a combatant with no uuid, and MoT's own echo", () => {
    expect(buildCombatantDefeat(combatant({ uuid: null }), { defeated: true }, documentContext())).toBeNull();

    const echo = combatant({ uuid: "C.1", flags: bridgeOriginFlags() });
    expect(buildCombatantDefeat(echo, { defeated: true }, documentContext())).toBeNull();
    expect(buildCombatantDefeat(null, { defeated: true }, documentContext())).toBeNull();
  });
});

describe("registerActorCapture", () => {
  function harness(active = true) {
    const hooks = createHooks();
    const emitted: Envelope[] = [];
    const context = documentContext();

    registerActorCapture({
      hooks,
      isActive: () => active,
      context: () => context,
      emit: (envelope) => void emitted.push(envelope),
    });
    return { hooks, emitted, context };
  }

  it("registers both update hooks — watching only updateActor is the classic miss", () => {
    const { hooks } = harness();
    expect([...hooks.handlers.keys()].sort()).toEqual([
      "createActiveEffect",
      "createToken",
      "deleteActiveEffect",
      "updateActor",
      "updateCombatant",
      "updateToken",
    ]);
  });

  it("emits actor.appeared on createToken", () => {
    const { hooks, emitted } = harness();
    hooks.emit("createToken", tokenDocument({ uuid: "Scene.s.Token.t1" }));

    expect(emitted[0]?.type).toBe("actor.appeared");
  });

  it("emits actor.changed from updateActor", () => {
    const { hooks, emitted } = harness();
    hooks.emit("updateActor", actorDocument({ uuid: "Actor.a", system: hp(5) }), { system: hp(5) });

    expect(emitted[0]).toMatchObject({ type: "actor.changed", payload: { hp: { to: 5 } } });
  });

  it("emits actor.changed from updateToken", () => {
    const { hooks, emitted } = harness();
    const token = tokenDocument({ uuid: "Scene.s.Token.t1", actor: actorDocument({ system: hp(2, 7) }) });
    hooks.emit("updateToken", token, { delta: { system: hp(2, 7) } });

    expect(emitted[0]).toMatchObject({ type: "actor.changed", payload: { hp: { to: 2 } } });
  });

  it("emits from both effect hooks with the right direction", () => {
    const { hooks, emitted } = harness();
    const effect = activeEffect({ uuid: "A.b.ActiveEffect.e1", name: "Prone" });

    hooks.emit("createActiveEffect", effect);
    hooks.emit("deleteActiveEffect", effect);

    expect(emitted[0]?.payload).toMatchObject({ conditions: { added: ["Prone"] } });
    expect(emitted[1]?.payload).toMatchObject({ conditions: { removed: ["Prone"] } });
  });

  it("emits from updateCombatant", () => {
    const { hooks, emitted } = harness();
    hooks.emit("updateCombatant", combatant({ uuid: "C.1" }), { defeated: true });

    expect(emitted[0]?.payload).toMatchObject({ defeated: true });
  });

  it("shares one hp memory across the hooks, so appearance then damage reads as a delta", () => {
    const { hooks, emitted } = harness();
    const actor = actorDocument({ uuid: "Actor.gob", system: hp(7, 7) });

    hooks.emit("createToken", tokenDocument({ uuid: "Scene.s.Token.t1", actor }));
    hooks.emit(
      "updateToken",
      tokenDocument({ uuid: "Scene.s.Token.t1", actor: actorDocument({ uuid: "Actor.gob", system: hp(1, 7) }) }),
      { delta: { system: hp(1, 7) } },
    );

    expect(emitted[1]?.payload).toMatchObject({ hp: { from: 7, to: 1, max: 7 } });
  });

  it("emits nothing at all when the activation gate is closed", () => {
    const { hooks, emitted } = harness(false);
    hooks.emit("createToken", tokenDocument());
    hooks.emit("updateActor", actorDocument({ system: hp(5) }), { system: hp(5) });
    hooks.emit("updateToken", tokenDocument(), { delta: { system: hp(5) } });
    hooks.emit("createActiveEffect", activeEffect());
    hooks.emit("deleteActiveEffect", activeEffect());
    hooks.emit("updateCombatant", combatant(), { defeated: true });

    expect(emitted).toEqual([]);
  });

  it("does not record hit points while the gate is closed — a silent client stays silent", () => {
    const { hooks, context } = harness(false);
    hooks.emit("updateActor", actorDocument({ uuid: "Actor.a", system: hp(5) }), { system: hp(5) });

    expect(context.prior.size).toBe(0);
  });
});
