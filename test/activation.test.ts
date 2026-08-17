import { describe, expect, it } from "vitest";
import { isActiveGM, isNonActiveGM } from "../src/activation.js";
import { createGame } from "./stubs.js";

/**
 * The rule most likely to be "simplified" into a bug by a future reader, so it
 * gets its own file at both ends: the implementation and the test.
 */
describe("isActiveGM", () => {
  it("is true on the one client Foundry considers the active GM", () => {
    const game = createGame({
      users: [{ id: "gm1", name: "Jeremy", isGM: true, isSelf: true }],
      activeGMId: "gm1",
    });
    expect(isActiveGM(game)).toBe(true);
  });

  it("is FALSE on a second GM's client, which `isGM` would have let through", () => {
    const game = createGame({
      users: [
        { id: "gm1", name: "Jeremy", isGM: true, isSelf: false },
        { id: "gm2", name: "Robin", isGM: true, isSelf: true },
      ],
      activeGMId: "gm1",
    });
    expect(game.user?.isGM).toBe(true);
    expect(isActiveGM(game)).toBe(false);
  });

  it("is false on a player's client", () => {
    const game = createGame({
      users: [
        { id: "gm1", isGM: true },
        { id: "p1", isGM: false, isSelf: true },
      ],
      activeGMId: "gm1",
    });
    expect(isActiveGM(game)).toBe(false);
  });

  it("is false when no GM is online at all", () => {
    const game = createGame({ users: [{ id: "p1", isGM: false, isSelf: true }], activeGMId: null });
    expect(isActiveGM(game)).toBe(false);
  });

  it("is false rather than throwing on a half-built game object", () => {
    expect(isActiveGM(null)).toBe(false);
    expect(isActiveGM(undefined)).toBe(false);
    expect(isActiveGM({} as never)).toBe(false);
    expect(isActiveGM({ users: null } as never)).toBe(false);
  });
});

describe("isNonActiveGM", () => {
  it("identifies the second-GM case, so the idle log line can say why", () => {
    const game = createGame({
      users: [
        { id: "gm1", isGM: true, isSelf: false },
        { id: "gm2", isGM: true, isSelf: true },
      ],
      activeGMId: "gm1",
    });
    expect(isNonActiveGM(game)).toBe(true);
  });

  it("is false for the active GM and for a player", () => {
    const active = createGame({ users: [{ id: "gm1", isGM: true, isSelf: true }], activeGMId: "gm1" });
    expect(isNonActiveGM(active)).toBe(false);

    const player = createGame({
      users: [
        { id: "gm1", isGM: true },
        { id: "p1", isGM: false, isSelf: true },
      ],
      activeGMId: "gm1",
    });
    expect(isNonActiveGM(player)).toBe(false);
  });
});
