import { describe, expect, it } from "vitest";
import { selectAdapter, toExt } from "../src/adapters/index.js";
import { genericAdapter } from "../src/adapters/generic.js";
import { dnd5eAdapter } from "../src/adapters/dnd5e.js";
import { chatMessage, roll } from "./stubs.js";

const CONTEXT = { systemId: "dnd5e", systemVersion: "5.0.2" };

describe("selectAdapter", () => {
  it("returns the dnd5e adapter for a 5e world", () => {
    expect(selectAdapter("dnd5e")).toBe(dnd5eAdapter);
  });

  it("returns the generic adapter for every other system — Pathfinder gets a working log on day one", () => {
    expect(selectAdapter("pf2e")).toBe(genericAdapter);
    expect(selectAdapter("swade")).toBe(genericAdapter);
    expect(selectAdapter("my-homebrew-system")).toBe(genericAdapter);
  });

  it("returns the generic adapter for a missing system id rather than throwing", () => {
    expect(selectAdapter(null)).toBe(genericAdapter);
    expect(selectAdapter(undefined)).toBe(genericAdapter);
    expect(selectAdapter("")).toBe(genericAdapter);
  });
});

describe("genericAdapter", () => {
  it("garnishes nothing at all", () => {
    expect(genericAdapter.rollExt(chatMessage(), roll("1d20", 5), CONTEXT)).toBeUndefined();
    expect(genericAdapter.chatExt(chatMessage(), CONTEXT)).toBeUndefined();
  });
});

describe("dnd5eAdapter", () => {
  it("reports the system it saw — the v0.1.0 stub", () => {
    expect(dnd5eAdapter.rollExt(chatMessage(), roll("1d20", 5), CONTEXT)).toEqual({
      dnd5e: { system: "dnd5e", systemVersion: "5.0.2" },
    });
  });

  it("keeps everything it produces inside the `ext` namespace", () => {
    const ext = dnd5eAdapter.chatExt(chatMessage(), CONTEXT) ?? {};
    // If an adapter ever emits a top-level key, the server could branch on it and
    // the feature quietly becomes a 5e feature.
    expect(Object.keys(ext)).toEqual(["dnd5e"]);
  });
});

describe("toExt", () => {
  it("passes a populated object through", () => {
    expect(toExt({ dnd5e: { crit: true } })).toEqual({ dnd5e: { crit: true } });
  });

  it("drops undefined and empty objects so events do not carry `ext: {}`", () => {
    expect(toExt(undefined)).toBeUndefined();
    expect(toExt({})).toBeUndefined();
  });
});
