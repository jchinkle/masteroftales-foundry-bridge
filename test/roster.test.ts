import { describe, expect, it } from "vitest";
import { MAX_ROSTER, MAX_USER_NAME_LENGTH, readRoster } from "../src/protocol/roster.js";
import { createGame } from "./stubs.js";

/**
 * The roster is the half of `image.show` that has to exist before the feature is
 * usable at all: MoT cannot offer a "show this to…" pick-list without knowing
 * who is at the table, and this module is the only end that knows.
 */
describe("readRoster", () => {
  it("reports every user with the four fields the panel needs", () => {
    const game = createGame({
      users: [
        { id: "gm1", name: "Jeremy", isGM: true, isSelf: true, active: true },
        { id: "p1", name: "Robin", isGM: false, active: true },
        { id: "p2", name: "Sam", isGM: false, active: false },
      ],
      activeGMId: "gm1",
    });

    expect(readRoster(game.users as unknown as Iterable<FoundryUser>)).toEqual([
      { id: "gm1", name: "Jeremy", active: true, gm: true },
      { id: "p1", name: "Robin", active: true, gm: false },
      { id: "p2", name: "Sam", active: false, gm: false },
    ]);
  });

  it("includes GMs rather than filtering them, and flags them instead", () => {
    // The filter is the server's call, not this module's: "who is at the table?"
    // and "who can I show a map to?" want different lists, and a filter compiled
    // into a module can only be changed by shipping a module.
    const game = createGame({
      users: [
        { id: "gm1", name: "Jeremy", isGM: true, isSelf: true, active: true },
        { id: "gm2", name: "Robin", isGM: true, active: true },
      ],
      activeGMId: "gm1",
    });

    const roster = readRoster(game.users as unknown as Iterable<FoundryUser>);
    expect(roster).toHaveLength(2);
    expect(roster.every((user) => user.gm)).toBe(true);
  });

  it("reads `active` as offline when Foundry did not set it — absent over wrong", () => {
    // The direction matters: guessing "online" would put a name in the pick-list
    // for a browser that is not open, and the image would go nowhere.
    const roster = readRoster([{ id: "p1", name: "Robin" }]);
    expect(roster).toEqual([{ id: "p1", name: "Robin", active: false, gm: false }]);
  });

  it("carries a null name rather than an empty string", () => {
    expect(readRoster([{ id: "p1", name: "   ", active: true }])[0]?.name).toBeNull();
    expect(readRoster([{ id: "p1", active: true }])[0]?.name).toBeNull();
  });

  it("skips a user with no usable id — an untargetable entry is worse than none", () => {
    const roster = readRoster([
      { id: "p1", name: "Robin" },
      { id: "" } as FoundryUser,
      null as unknown as FoundryUser,
      { name: "nameless" } as unknown as FoundryUser,
    ]);
    expect(roster.map((user) => user.id)).toEqual(["p1"]);
  });

  it("truncates an absurd display name", () => {
    const roster = readRoster([{ id: "p1", name: "R".repeat(400) }]);
    expect(roster[0]?.name?.length).toBe(MAX_USER_NAME_LENGTH);
  });

  it("caps the roster — this rides on every batch all night", () => {
    const users = Array.from({ length: MAX_ROSTER + 25 }, (_, index) => ({ id: `u${index}` }));
    expect(readRoster(users)).toHaveLength(MAX_ROSTER);
  });

  it("answers an absent or non-iterable collection with an empty roster", () => {
    expect(readRoster(null)).toEqual([]);
    expect(readRoster(undefined)).toEqual([]);
    expect(readRoster({} as unknown as Iterable<FoundryUser>)).toEqual([]);
  });
});
