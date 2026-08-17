import type { SystemAdapter } from "./index.js";

/**
 * The fallback, and the one that proves the design: a Pathfinder, Savage Worlds
 * or homebrew table gets a working session log on day one — just a plainer one.
 * It garnishes nothing, and nothing downstream notices.
 */
export const genericAdapter: SystemAdapter = {
  id: "*",
  rollExt() {
    return undefined;
  },
  chatExt() {
    return undefined;
  },
};
