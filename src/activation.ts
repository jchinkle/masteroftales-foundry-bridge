/**
 * The activation gate, alone in its own file because it is the single rule most
 * likely to be "simplified" by a future reader into a bug.
 *
 * **`game.users.activeGM?.isSelf`, never `game.user.isGM`.**
 *
 * A table with two GMs logged in has two clients that pass `isGM`, and every
 * event gets captured twice — two POSTs, two of everything, from a module whose
 * whole job is to be an accurate record. There is exactly one `activeGM` (Foundry
 * picks the longest-connected GM), and `isSelf` is true on exactly one browser.
 *
 * Server-side idempotency keys would catch the duplicates anyway. That is belt
 * and braces on purpose, not a reason to skip the belt.
 *
 * Re-evaluated on **every** captured event rather than once at `ready`, because
 * `activeGM` moves: the primary GM drops off the wifi and this client is
 * promoted mid-session, or vice versa. A gate read once at startup would be
 * wrong for the rest of the night in both directions.
 */
export function isActiveGM(g: Pick<FoundryGame, "users"> | null | undefined): boolean {
  return g?.users?.activeGM?.isSelf === true;
}

/** For the idle console line: are we a GM at all, just not the active one? */
export function isNonActiveGM(g: Pick<FoundryGame, "user" | "users"> | null | undefined): boolean {
  return g?.user?.isGM === true && !isActiveGM(g);
}
