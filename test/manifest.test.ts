import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODULE_ID, MODULE_VERSION, PROTOCOL_VERSION } from "../src/protocol/version.js";

/**
 * Guards on the manifest, because every one of these is a mistake that only
 * shows up as "the module does not appear in Foundry" *after* a release is cut.
 */
const manifest = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("module.json", () => {
  it("uses the id the code, the settings namespace and the loop-guard flag all assume", () => {
    expect(manifest.id).toBe(MODULE_ID);
  });

  it("keeps its version in step with package.json and the protocol constant", () => {
    // The release workflow stamps the tag into module.json; these three must
    // start from the same place or a release silently ships a mismatch.
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.version).toBe(MODULE_VERSION);
  });

  it("targets Foundry v13 with v14 verified", () => {
    expect(manifest.compatibility).toEqual({ minimum: "13", verified: "14" });
  });

  it("points esmodules at the file Vite actually builds", () => {
    expect(manifest.esmodules).toEqual(["dist/main.js"]);
  });

  it("does not claim Foundry's socket — this module owns both ends of its own protocol", () => {
    expect(manifest.socket).toBe(false);
  });

  it("points manifest and download at the GitHub Releases pattern Foundry installs from", () => {
    expect(manifest.manifest).toBe(
      "https://github.com/jchinkle/masteroftales-foundry-bridge/releases/latest/download/module.json",
    );
    expect(manifest.download).toMatch(/releases\/.*\/module\.zip$/);
  });

  it("names an author, which Foundry's package browser requires", () => {
    expect(manifest.authors).toEqual([{ name: "Jeremy Hinkle" }]);
  });
});

describe("package.json", () => {
  it("ships no runtime dependencies — the whole point of hand-writing the cable protocol", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("keeps the dev toolchain to typescript, vite and vitest", () => {
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["typescript", "vite", "vitest"]);
  });
});

describe("protocol version", () => {
  it("is v1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
