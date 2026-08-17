import { MODULE_ID } from "../protocol/version.js";

/**
 * The echo brake.
 *
 * Anything MoT causes to appear in Foundry — slice 4's mirrored dice, an
 * announced note — is stamped `flags["masteroftales-bridge"].origin = "mot"`.
 * The capture layer drops those on sight. Without this, a mirrored roll comes
 * straight back as a Foundry `createChatMessage` and the session log doubles
 * every entry, forever, in a loop that looks like a server bug.
 *
 * Written now, before there is anything to guard against, because the slice that
 * needs it is the slice where forgetting it is most expensive.
 */

export const ORIGIN_MOT = "mot";

export interface FlaggedDocument {
  flags?: Record<string, unknown> | null;
  getFlag?(scope: string, key: string): unknown;
}

/** The flag object to stamp onto anything this module creates in Foundry. */
export function bridgeOriginFlags(): Record<string, Record<string, string>> {
  return { [MODULE_ID]: { origin: ORIGIN_MOT } };
}

/**
 * True when the document was created by MoT rather than by a human at the table.
 *
 * Reads `flags` directly rather than through `getFlag`, because the hook payload
 * is sometimes a plain source object (v13/v14 both pass the Document, but
 * `preCreate`-adjacent paths and our own tests pass source data) and `getFlag`
 * would not exist on it. Falls back to `getFlag` when the raw flags are absent.
 */
export function isBridgeOrigin(doc: FlaggedDocument | null | undefined): boolean {
  if (!doc) return false;

  const scoped = doc.flags?.[MODULE_ID] as { origin?: unknown } | undefined;
  if (scoped && typeof scoped === "object") {
    return scoped.origin === ORIGIN_MOT;
  }

  if (typeof doc.getFlag === "function") {
    try {
      const flags = doc.getFlag(MODULE_ID, "origin");
      return flags === ORIGIN_MOT;
    } catch {
      return false;
    }
  }

  return false;
}
