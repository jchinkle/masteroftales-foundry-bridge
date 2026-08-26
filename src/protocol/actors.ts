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
  /**
   * Portrait or token art, as an **absolute URL**. Null when the actor has none
   * this module can read, or when this client could not work out its own address.
   *
   * Absolute rather than the `icons/creatures/goblin.webp` Foundry stores,
   * because the only browser that ever renders this string is pointed at
   * masteroftales.com, where a relative path resolves against MoT's own host and
   * 404s as a broken square. This client is the one end that knows where the
   * pictures live — it is *in* the Foundry — so it says so. See
   * {@link absoluteAssetUrl}.
   */
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
 * An asset URL longer than this is dropped rather than truncated.
 *
 * Truncating a path produces a *different* path, which is the one failure mode
 * worse than a missing picture: the picker would ask the browser for a file that
 * does not exist and show a broken image where a portrait should be. Absent over
 * wrong, exactly as the capture layer reads documents.
 *
 * It governs the **reported** string rather than the raw `actor.img`, and it was
 * 500 when that was the same thing. An absolutized URL carries an origin and any
 * route prefix in front of the world path, so the old number would start dropping
 * portraits this module used to send. A thousand still sits well inside the
 * server's own 2,000-character truncation of the column, and a catalog is capped
 * at {@link MAX_CATALOG_ACTORS} rows, so the worst case is a POST a browser sends
 * without thinking about it.
 */
export const MAX_ACTOR_PATH_LENGTH = 1_000;

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
 * objects and a client that is still booting are all unit tests. `base` is this
 * Foundry's own address — {@link resolveAssetBase} is what reads it off the
 * globals, and it is a required argument rather than an optional one so a call
 * site cannot quietly go back to shipping relative paths.
 *
 * Never throws and never invents. An actor without a usable string id is skipped
 * entirely — the id is the only field the whole feature turns on, and a catalog
 * row that cannot be pointed at is worse than an absent one.
 */
export function collectActorCatalog(actors: unknown, base: string | null): BridgeActor[] {
  const catalog: BridgeActor[] = [];

  for (const actor of collectionValues<FoundryActor>(actors)) {
    if (catalog.length >= MAX_CATALOG_ACTORS) break;
    if (!actor || typeof actor !== "object") continue;

    const id = nonEmpty(actor.id);
    if (id === null) continue;

    catalog.push({
      id,
      name: capped(actor.name, MAX_ACTOR_NAME_LENGTH) ?? id,
      img: actorImage(actor.img, base),
      type: whole(actor.type, MAX_ACTOR_TYPE_LENGTH),
    });
  }

  return catalog;
}

/**
 * Foundry's word for a picture — `icons/creatures/goblin.webp`,
 * `worlds/barovia/tokens/ireena.png` — made into a URL a browser somewhere else
 * entirely can fetch.
 *
 * Pure, and takes the base as a string, because "where is this Foundry?" is the
 * one question in the file a laptop cannot answer by running the suite.
 *
 * Four cases, and each is a decision:
 *
 *  1. **A relative path** is resolved against `base`, which carries the origin
 *     *and* the route prefix. `new URL` is doing the work rather than string
 *     concatenation, so `../`, an already-percent-encoded path and a path with a
 *     space in it all come out right — the last of these better than before,
 *     since the encoding now happens here instead of in whichever browser
 *     eventually renders it.
 *  2. **Anything already carrying a scheme** passes through untouched. An https
 *     URL is somebody's CDN or MoT's own upload and is already right; a `data:`
 *     URI is self-contained and refers to no host at all. Neither is ours to
 *     rewrite. (In practice a `data:` portrait is longer than the cap below and
 *     is therefore dropped, which is the right end for a catalog that would
 *     otherwise carry five hundred inlined images.)
 *  3. **No base** — a client whose `location` this module could not read —
 *     returns null rather than the bare path. A relative path is not a URL that
 *     is merely worse; it is one that resolves against the *wrong server*, and
 *     the picker draws a broken square for it. Absent over wrong, again.
 *  4. **Control characters** are refused outright, for `commands/images.ts`'s
 *     reason: `URL` strips tabs, newlines and returns *before* parsing, so a
 *     value carrying one would be reported as a path nobody stored. A plain
 *     space is not one of them and is fine — Foundry worlds are full of
 *     `tokens/old man.webp`, and `URL` percent-encodes it honestly.
 */
export function absoluteAssetUrl(value: string | null, base: string | null): string | null {
  if (value === null) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;

  // Any scheme at all — `https:`, `data:`, and the ones nobody has thought of.
  // The picker on the other end decides what it is willing to render.
  if (/^[a-z][a-z0-9+.\-]*:/i.test(value)) return value;

  if (base === null) return null;

  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

/**
 * This Foundry's address, as a base URL with a trailing slash — the thing every
 * relative asset path in the world is spelled against.
 *
 * Takes the global scope as an argument for `resolveImagePopout`'s reason: this
 * is the single place the module asks the client where it is, and reading it
 * from a passed-in scope makes a routed install, an unrouted one and a headless
 * test three unit tests rather than three bug reports.
 *
 * **Route-prefix aware**, which is the whole reason it is not one line.
 * A Foundry served at `https://home.example/foundry/` reports its actor art as
 * `icons/goblin.webp` all the same, and resolving that against the bare origin
 * would produce a URL that 404s on the customer's own reverse proxy.
 * `foundry.utils.getRoute` is the client's own answer and is asked first;
 * `ROUTE_PREFIX` — the global it reads — is the fallback for a client where the
 * namespaced helper has moved or has not booted yet.
 *
 * Null when there is no usable `location`, which is a test harness or a client
 * mid-teardown. Callers report no picture rather than a wrong one.
 */
export function resolveAssetBase(scope: unknown): string | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const origin = readOrigin(global.location);
  if (origin === null) return null;

  const routed = callGetRoute(global);
  if (routed !== null) return joinBase(origin, routed);

  const prefix = nonEmpty(global.ROUTE_PREFIX);
  return joinBase(origin, prefix === null ? "/" : `/${prefix}/`);
}

/** `location.origin`, or the origin of `location.href` on a client that has only that. */
function readOrigin(location: unknown): string | null {
  if (!location || typeof location !== "object") return null;

  const record = location as Record<string, unknown>;
  const origin = nonEmpty(record.origin);
  if (origin !== null && origin !== "null") return origin;

  const href = nonEmpty(record.href);
  if (href === null) return null;
  try {
    const parsed = new URL(href).origin;
    return parsed === "null" ? null : parsed;
  } catch {
    return null;
  }
}

/** `foundry.utils.getRoute("/")` — the prefix as this client itself spells it. */
function callGetRoute(global: Record<string, unknown>): string | null {
  const utils = (global.foundry as { utils?: Record<string, unknown> } | undefined)?.utils;
  const getRoute = utils?.getRoute;
  if (typeof getRoute !== "function") return null;

  try {
    return nonEmpty((getRoute as (path: string) => unknown)("/"));
  } catch {
    // A helper that threw is a client we do not recognise. `ROUTE_PREFIX` next.
    return null;
  }
}

/** `https://host` + `/foundry/` -> `https://host/foundry/`. Always one trailing slash. */
function joinBase(origin: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${origin.replace(/\/+$/, "")}${suffix.replace(/\/*$/, "/")}`;
}

/**
 * The `POST /api/v1/bridge/actors` body, as a value.
 *
 * Built here rather than inline at the call site so the shape is a unit test
 * rather than something a customer discovers. `bridge` is the same identity block
 * every batch and every heartbeat carries, which is what lets the server file the
 * catalog against the right world without a second lookup.
 */
export function actorCatalogBody(actors: unknown, info: BridgeInfo, base: string | null): ActorCatalogBody {
  return { bridge: info, actors: collectActorCatalog(actors, base) };
}

// -------------------------------------------------------- the other direction

/**
 * The `POST /api/v1/bridge/actor_creations` body: the answer to one
 * `actor.create` (see commands/actorCreate.ts).
 *
 * Three fields, and the shape is the reason it is written as a value:
 *
 *  - `key` is the **opaque correlation string MoT minted**, echoed back exactly as
 *    it arrived. This module never parses it and never invents one; a report
 *    carrying a key MoT does not recognise is a report MoT drops, which is the
 *    right end for a module that has misunderstood something.
 *  - `actorId` and `name` are **Foundry's**, read off the document that now exists
 *    in the world rather than off the payload that asked for it. That is the whole
 *    reason the report exists: only this end knows what Foundry called it.
 *
 * And note what is absent, for the same reason the catalog says so out loud: **no
 * user, member or role id rides here**, and no MoT record id either. The bridge
 * wire does not carry them, in either direction, ever.
 *
 * Unlike the catalog this carries no `bridge` identity block. The report answers a
 * request that came down a socket the server already knows the world of, and the
 * bearer token names the project; an identity block here would be a second answer
 * to a question nobody asked twice.
 */
export interface ActorCreationBody {
  key: string;
  actorId: string;
  name: string;
}

/** The report body, as a value, so its shape is a unit test. */
export function actorCreationBody(key: string, actorId: string, name: string): ActorCreationBody {
  return { key, actorId, name };
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

/**
 * `actor.img` as the wire carries it: trimmed, absolutized, and capped.
 *
 * The cap is applied **last**, to the string that actually goes out, because
 * that is the one whose length the server stores and a browser requests. Dropped
 * rather than truncated, for {@link MAX_ACTOR_PATH_LENGTH}'s reason.
 */
function actorImage(value: unknown, base: string | null): string | null {
  const absolute = absoluteAssetUrl(nonEmpty(value), base);
  if (absolute === null || absolute.length > MAX_ACTOR_PATH_LENGTH) return null;
  return absolute;
}
