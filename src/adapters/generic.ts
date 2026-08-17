import type { SystemAdapter } from "./index.js";

/**
 * The fallback, and the one that proves the design: a Pathfinder, Savage Worlds
 * or homebrew table gets a working session log on day one — just a plainer one.
 * It garnishes nothing, and nothing downstream notices.
 *
 * Each method is written out rather than collapsed into a loop, because the
 * honest statement here is "we looked at this event family and had nothing
 * system-specific to add", and four explicit `undefined`s say that where a
 * generated stub would only say "unimplemented".
 *
 * `currency` returning undefined is the load-bearing one: it is what makes a
 * generic table emit **no** `currency.changed` events at all, rather than
 * guessing at a `system.currency` field that means something else — or nothing —
 * on the system in front of it.
 */
export const genericAdapter: SystemAdapter = {
  id: "*",

  rollExt() {
    return undefined;
  },

  chatExt() {
    return undefined;
  },

  actorExt() {
    return undefined;
  },

  currency() {
    return undefined;
  },
};
