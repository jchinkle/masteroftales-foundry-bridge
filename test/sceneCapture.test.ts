import { describe, expect, it } from "vitest";
import { bridgeOriginFlags } from "../src/capture/loopGuard.js";
import { buildSceneActivated, registerSceneCapture } from "../src/capture/scenes.js";
import type { Envelope } from "../src/protocol/types.js";
import { createHooks, documentContext, sceneDocument, STUB_MTIME } from "./stubs.js";

describe("buildSceneActivated", () => {
  const vallaki = sceneDocument({ uuid: "Scene.vallaki", name: "Vallaki", active: true });

  it("emits the chapter heading a session log reads by", () => {
    expect(buildSceneActivated(vallaki, { active: true }, documentContext())).toEqual({
      v: 1,
      type: "scene.activated",
      id: `fvtt:scene:Scene.vallaki:${STUB_MTIME}`,
      ts: "2026-08-17T20:14:03.000Z",
      payload: { sceneUuid: "Scene.vallaki", name: "Vallaki" },
    });
  });

  it("ignores the scene being LEFT — activating fires updateScene twice", () => {
    // Once with `active: false` on the scene departed, once with `active: true`
    // on the one arrived. Logging both would double every scene change.
    const crypt = sceneDocument({ uuid: "Scene.crypt", name: "The Crypt", active: false });
    expect(buildSceneActivated(crypt, { active: false }, documentContext())).toBeNull();
  });

  it("reads the diff, not the document — editing the active scene is not arriving at it", () => {
    // `scene.active` stays true for as long as the party is there, so a light
    // moved or a wall drawn would otherwise be another "arrived at Vallaki".
    expect(buildSceneActivated(vallaki, { name: "Vallaki by night" }, documentContext())).toBeNull();
    expect(buildSceneActivated(vallaki, {}, documentContext())).toBeNull();
    expect(buildSceneActivated(vallaki, null, documentContext())).toBeNull();
  });

  it("requires a strict boolean true rather than anything truthy", () => {
    expect(buildSceneActivated(vallaki, { active: 1 }, documentContext())).toBeNull();
    expect(buildSceneActivated(vallaki, { active: "true" }, documentContext())).toBeNull();
  });

  it("keys on the mtime, so returning to the tavern is a second arrival", () => {
    const first = buildSceneActivated(vallaki, { active: true }, documentContext());
    const later = sceneDocument({ uuid: "Scene.vallaki", modifiedTime: STUB_MTIME + 90_000 });
    const second = buildSceneActivated(later, { active: true }, documentContext());

    expect(first?.id).not.toBe(second?.id);
    expect(second?.id).toBe(`fvtt:scene:Scene.vallaki:${STUB_MTIME + 90_000}`);
  });

  it("falls back to the sequence counter, never a wall clock, when there is no mtime", () => {
    const bare = sceneDocument({ uuid: "Scene.vallaki", modifiedTime: null });
    expect(buildSceneActivated(bare, { active: true }, documentContext())?.id).toBe("fvtt:scene:Scene.vallaki:s1");
  });

  it("reports a null name rather than a placeholder", () => {
    const unnamed = sceneDocument({ uuid: "Scene.x", name: null });
    expect(buildSceneActivated(unnamed, { active: true }, documentContext())?.payload.name).toBeNull();
  });

  it("skips a scene with no uuid, and MoT's own echo", () => {
    expect(buildSceneActivated(sceneDocument({ uuid: null }), { active: true }, documentContext())).toBeNull();

    const echo = sceneDocument({ uuid: "Scene.x", flags: bridgeOriginFlags() });
    expect(buildSceneActivated(echo, { active: true }, documentContext())).toBeNull();
    expect(buildSceneActivated(null, { active: true }, documentContext())).toBeNull();
  });
});

describe("registerSceneCapture", () => {
  function harness(active = true) {
    const hooks = createHooks();
    const emitted: Envelope[] = [];
    registerSceneCapture({
      hooks,
      isActive: () => active,
      context: () => documentContext(),
      emit: (envelope) => void emitted.push(envelope),
    });
    return { hooks, emitted };
  }

  it("registers only updateScene", () => {
    const { hooks } = harness();
    expect([...hooks.handlers.keys()]).toEqual(["updateScene"]);
  });

  it("emits on the flip to active", () => {
    const { hooks, emitted } = harness();
    hooks.emit("updateScene", sceneDocument({ uuid: "Scene.vallaki" }), { active: true });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("scene.activated");
  });

  it("emits exactly once for a scene change, not twice", () => {
    const { hooks, emitted } = harness();
    hooks.emit("updateScene", sceneDocument({ uuid: "Scene.crypt", active: false }), { active: false });
    hooks.emit("updateScene", sceneDocument({ uuid: "Scene.vallaki" }), { active: true });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({ sceneUuid: "Scene.vallaki" });
  });

  it("emits nothing when the activation gate is closed", () => {
    const { hooks, emitted } = harness(false);
    hooks.emit("updateScene", sceneDocument(), { active: true });

    expect(emitted).toEqual([]);
  });
});
