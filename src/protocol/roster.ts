import { truncate } from "../capture/html.js";

/**
 * The table's roster — who exists in this world and who is currently connected.
 *
 * MoT needs this for exactly one reason: `image.show` takes a list of Foundry
 * user ids, and a GM cannot pick user ids out of the air. The panel needs a
 * pick-list, and the only end that knows the pick-list is this one.
 *
 * Two decisions worth stating, because both are the sort of thing a later reader
 * would "tidy" into a bug:
 *
 *  1. **Every user is reported, GMs included, with a `gm` boolean** — rather than
 *     filtered here. Filtering is a *presentation* choice ("who can I show a map
 *     to?" wants players; "who is at the table?" wants everyone), and a filter
 *     baked into the module can only be changed by shipping a module. The server
 *     gets the facts and decides.
 *  2. **`active` is Foundry's own connectedness flag, not a guess.** It is the
 *     difference between "Robin has a character in this world" and "Robin's
 *     browser is open right now", and only the second can receive an image.
 *
 * This rides on `BridgeInfo`, which means it goes out on every batch *and* every
 * heartbeat, and is therefore never more than one heartbeat stale — see
 * transport/heartbeat.ts for why a quiet table still reports.
 */

export interface BridgeUser {
  id: string;
  /** Foundry lets a user have no name in principle; null rather than "". */
  name: string | null;
  /** Connected right now. Foundry's `User#active`. */
  active: boolean;
  gm: boolean;
}

/** A display name is a name, not an essay. Purely defensive. */
export const MAX_USER_NAME_LENGTH = 120;

/**
 * The roster cap. A Foundry world with more users than this is not a table, and
 * a bridge identity block is not the place to discover that: the batch POST
 * carries this on every request all night, so it has to have a ceiling.
 */
export const MAX_ROSTER = 200;

/**
 * Reads `game.users` into the wire shape.
 *
 * Pure in the sense that matters: it takes the collection rather than reaching
 * for the `game` global, so every shape below — a user with no id, a v13
 * collection, a v14 one, a client that is still booting — is a unit test.
 *
 * Never throws and never invents. A user without a usable string id is skipped
 * entirely: an id is the only field the whole feature turns on, and a roster
 * entry that cannot be targeted is worse than an absent one.
 */
export function readRoster(users: Iterable<FoundryUser> | null | undefined): BridgeUser[] {
  if (!users || typeof (users as Iterable<FoundryUser>)[Symbol.iterator] !== "function") return [];

  const roster: BridgeUser[] = [];

  for (const user of users) {
    if (roster.length >= MAX_ROSTER) break;
    if (!user || typeof user !== "object") continue;
    if (typeof user.id !== "string" || user.id === "") continue;

    roster.push({
      id: user.id,
      name: userName(user.name),
      // `=== true` throughout: these arrive off a document that may be a plain
      // source object on some paths, where the flags are simply absent. Absent
      // reads as false, which is the direction that shows fewer people online
      // rather than more.
      active: user.active === true,
      gm: user.isGM === true,
    });
  }

  return roster;
}

function userName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = truncate(value.trim(), MAX_USER_NAME_LENGTH);
  return trimmed === "" ? null : trimmed;
}
