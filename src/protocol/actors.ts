import { collectionValues } from "../capture/documents.js";
import { truncate } from "../capture/html.js";
import type { BridgeInfo } from "./types.js";

/**
 * The world's actor catalog — what this Foundry could put on a map.
 *
 * It exists for the same reason `protocol/roster.ts` does, and the argument is
 * word for word the same one: MoT's encounter planner needs a **pick-list**, and
 * the only end that knows the pick-list is this one. A keeper writing "Stage 2 —
 * three goblins and a bugbear" has to be able to point each row at a real Foundry
 * actor, and a keeper cannot type a sixteen-character document id out of the air.
 *
 * Three decisions worth stating, because each is the sort of thing a later reader
 * would tidy into a bug or into a leak:
 *
 *  1. **It is pushed, never pulled.** Nothing ever connects *in* to a customer's
 *     Foundry — the module dials out and holds one socket open (see the README's
 *     data-flow section). So MoT asks for the catalog over that socket
 *     (`actors.request`) and this module answers with a POST of its own. The
 *     request payload is ignored entirely; it is a doorbell, not an argument list.
 *  2. **Four fields, and no fifth.** Id, name, image and system type. Not
 *     ownership, not permissions, not hit points, not the sheet. The picker needs
 *     enough to draw a row a human can recognise, and a catalog that carried more
 *     would be a world export with a different name on it.
 *  3. **No user, member or role id ever rides here.** Same wall the whole bridge
 *     wire keeps: an actor is a creature in a world, and who at the table may
 *     open its sheet is not this door's business.
 *
 * Unlike the roster this does **not** ride on `BridgeInfo` and therefore does not
 * go out on every batch. A roster changes when somebody's browser opens; an actor
 * directory changes when a keeper imports a bestiary, which is to say almost
 * never, and five hundred rows on every heartbeat all night would be a poor trade
 * for freshness nobody asked for. It is sent once on activation and again
 * whenever MoT asks.
 */

export interface BridgeActor {
  id: string;
  /**
   * Never null, unlike the roster's — an unnamed actor falls back to its id.
   * A row in a picker has to say *something*, and "aBcD1234efGh5678" is at least
   * a thing the keeper can match against their own directory.
   */
  name: string;
  /** Portrait or token art. Null when the actor has none this module can read. */
  img: string | null;
  /** The system's own actor type: `"npc"`, `"character"`, `"vehicle"`… */
  type: string | null;
}

/** The POST body, as a value. See `actorCatalogBody`. */
export interface ActorCatalogBody {
  bridge: BridgeInfo;
  actors: BridgeActor[];
}

/** A display name is a name, not an essay. Purely defensive. */
export const MAX_ACTOR_NAME_LENGTH = 120;

/**
 * An asset path longer than this is dropped rather than truncated.
 *
 * Truncating a path produces a *different* path, which is the one failure mode
 * worse than a missing picture: the picker would ask the browser for a file that
 * does not exist and show a broken image where a portrait should be. Absent over
 * wrong, exactly as the capture layer reads documents.
 */
export const MAX_ACTOR_PATH_LENGTH = 500;

/** System type keys are short handles. Anything longer is not one. */
export const MAX_ACTOR_TYPE_LENGTH = 60;

/**
 * The catalog cap, matched on the server side.
 *
 * A world with more actors than this has a compendium's worth of them, and the
 * five-hundred-and-first is not the one the keeper was looking for. The cap keeps
 * one POST to a size a browser sends without thinking about it, and it means the
 * failure mode for a huge world is a short list rather than a request that hangs.
 */
export const MAX_CATALOG_ACTORS = 500;

/**
 * Reads `game.actors` into the wire shape.
 *
 * Pure in the sense that matters: it takes the collection rather than reaching
 * for the `game` global, so a v13 collection, a v14 one, a plain array of source
 * objects and a client that is still booting are all unit tests.
 *
 * Never throws and never invents. An actor without a usable string id is skipped
 * entirely — the id is the only field the whole feature turns on, and a catalog
 * row that cannot be pointed at is worse than an absent one.
 */
export function collectActorCatalog(actors: unknown): BridgeActor[] {
  const catalog: BridgeActor[] = [];

  for (const actor of collectionValues<FoundryActor>(actors)) {
    if (catalog.length >= MAX_CATALOG_ACTORS) break;
    if (!actor || typeof actor !== "object") continue;

    const id = nonEmpty(actor.id);
    if (id === null) continue;

    catalog.push({
      id,
      name: capped(actor.name, MAX_ACTOR_NAME_LENGTH) ?? id,
      img: whole(actor.img, MAX_ACTOR_PATH_LENGTH),
      type: whole(actor.type, MAX_ACTOR_TYPE_LENGTH),
    });
  }

  return catalog;
}

/**
 * The `POST /api/v1/bridge/actors` body, as a value.
 *
 * Built here rather than inline at the call site so the shape is a unit test
 * rather than something a customer discovers. `bridge` is the same identity block
 * every batch and every heartbeat carries, which is what lets the server file the
 * catalog against the right world without a second lookup.
 */
export function actorCatalogBody(actors: unknown, info: BridgeInfo): ActorCatalogBody {
  return { bridge: info, actors: collectActorCatalog(actors) };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Trimmed and truncated — for prose, where a shortened version is still true. */
function capped(value: unknown, max: number): string | null {
  const trimmed = nonEmpty(value);
  return trimmed === null ? null : truncate(trimmed, max);
}

/** Trimmed, and dropped rather than shortened — for handles and paths. */
function whole(value: unknown, max: number): string | null {
  const trimmed = nonEmpty(value);
  if (trimmed === null || trimmed.length > max) return null;
  return trimmed;
}
