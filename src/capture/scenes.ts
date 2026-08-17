import { sceneActivatedKey } from "../protocol/keys.js";
import type { Envelope, SceneActivatedPayload } from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import type { DocumentCaptureDeps, DocumentContext } from "./documents.js";
import { changeStamp, docName, docUuid, documentTimestamp, plainRecord } from "./documents.js";
import { isBridgeOrigin } from "./loopGuard.js";

/**
 * Scene capture: `scene.activated`, which the server files as a `marker` — the
 * chapter heading a session log reads by. "The party left the crypt and arrived
 * at Vallaki" is one line that organises the fifty around it.
 *
 * ## Only the flip to true
 *
 * Activating a scene fires `updateScene` **twice**: once with `active: false` on
 * the scene being left, once with `active: true` on the one arriving. Only the
 * second is an event — the first is the same fact stated backwards, and logging
 * both would double every scene change.
 *
 * The check is against the **diff**, not the document. `scene.active` is true for
 * as long as the party is there, so reading the document would turn every
 * unrelated edit of the active scene — a light moved, a wall drawn, a note
 * pinned — into another "arrived at Vallaki".
 */
export function buildSceneActivated(
  scene: FoundryScene | null | undefined,
  change: unknown,
  context: DocumentContext,
): Envelope<SceneActivatedPayload> | null {
  if (!scene || isBridgeOrigin(scene)) return null;

  // Strictly `true`. Foundry sends a boolean here, and a loose check would let
  // an `active: 1` from some module's source object through as an activation.
  if (plainRecord(change)?.active !== true) return null;

  const sceneUuid = docUuid(scene);
  if (!sceneUuid) return null;

  return {
    v: PROTOCOL_VERSION,
    type: "scene.activated",
    // Stamped with the mtime rather than keyed on the uuid alone: a party that
    // goes to the tavern, out to the graveyard and back to the tavern has
    // arrived twice, and both arrivals belong in the log.
    id: sceneActivatedKey(sceneUuid, changeStamp(scene, context)),
    ts: documentTimestamp(scene, context),
    payload: { sceneUuid, name: docName(scene) },
  };
}

/** One hook, one gate, no decisions. */
export function registerSceneCapture(deps: DocumentCaptureDeps): number[] {
  return [
    deps.hooks.on("updateScene", (scene: FoundryScene, change: unknown) => {
      if (!deps.isActive()) return;
      const envelope = buildSceneActivated(scene, change, deps.context());
      if (envelope) deps.emit(envelope);
    }),
  ];
}
