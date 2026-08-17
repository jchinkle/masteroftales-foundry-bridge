import type { SystemAdapter } from "./index.js";

/**
 * dnd5e enrichment — a **stub** in v0.1.0.
 *
 * Slice 3 fills this in with advantage/disadvantage, crit, DC and success,
 * damage types and death saves, read out of the message's dnd5e flags rather
 * than from system roll hooks (those fire only on the originating client and
 * change shape between majors — fine as a source of garnish, never as the
 * contract).
 *
 * Today it reports the system it saw, which is enough for the server's renderer
 * to know a 5e-shaped `ext` is coming and for a heartbeat panel to say
 * "dnd5e 5.0.2" instead of making the customer guess.
 */
export const dnd5eAdapter: SystemAdapter = {
  id: "dnd5e",

  rollExt(_message, _roll, context) {
    return { dnd5e: { system: context.systemId, systemVersion: context.systemVersion } };
  },

  chatExt(_message, context) {
    return { dnd5e: { system: context.systemId, systemVersion: context.systemVersion } };
  },
};
