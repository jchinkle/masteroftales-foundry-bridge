import { describe, expect, it } from "vitest";
import { bridgeOriginFlags, isBridgeOrigin } from "../src/capture/loopGuard.js";
import { MODULE_ID } from "../src/protocol/version.js";

describe("loop guard", () => {
  it("flags a document this module created in Foundry", () => {
    expect(isBridgeOrigin({ flags: bridgeOriginFlags() })).toBe(true);
  });

  it("stamps the flag under the module's own scope", () => {
    expect(bridgeOriginFlags()).toEqual({ [MODULE_ID]: { origin: "mot" } });
  });

  it("does not flag an ordinary message from the table", () => {
    expect(isBridgeOrigin({ flags: {} })).toBe(false);
    expect(isBridgeOrigin({ flags: null })).toBe(false);
    expect(isBridgeOrigin({})).toBe(false);
  });

  it("ignores another module's flags", () => {
    expect(isBridgeOrigin({ flags: { "dice-so-nice": { origin: "mot" } } })).toBe(false);
  });

  it("ignores our own scope carrying a different origin", () => {
    expect(isBridgeOrigin({ flags: { [MODULE_ID]: { origin: "player" } } })).toBe(false);
    expect(isBridgeOrigin({ flags: { [MODULE_ID]: {} } })).toBe(false);
  });

  it("falls back to getFlag when raw flags are not present on the object", () => {
    const doc = { getFlag: (scope: string, key: string) => (scope === MODULE_ID && key === "origin" ? "mot" : undefined) };
    expect(isBridgeOrigin(doc)).toBe(true);
  });

  it("does not treat another module's getFlag answer as ours", () => {
    const doc = { getFlag: () => "mot-something-else" };
    expect(isBridgeOrigin(doc)).toBe(false);
  });

  it("survives a getFlag that throws", () => {
    const doc = {
      getFlag: () => {
        throw new Error("document not ready");
      },
    };
    expect(isBridgeOrigin(doc)).toBe(false);
  });

  it("is safe on null and undefined", () => {
    expect(isBridgeOrigin(null)).toBe(false);
    expect(isBridgeOrigin(undefined)).toBe(false);
  });
});
