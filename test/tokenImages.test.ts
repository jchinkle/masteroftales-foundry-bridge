import { describe, expect, it } from "vitest";
import {
  buildTokenFile,
  DATA_SOURCE,
  decodeBase64,
  extensionFor,
  FALLBACK_FILE_STEM,
  MAX_DATA_URL_LENGTH,
  parseImageDataUrl,
  prepareTokenDirectory,
  readActorImage,
  resolveFilePicker,
  safeFileName,
  TOKEN_DIRECTORY,
  uniqueFileName,
  uploadedPath,
  uploadTokenImage,
} from "../src/commands/tokenImages.js";
import { createLog, fakePicker, PNG_BASE64, PNG_BYTES, PNG_DATA_URL, tokenImage } from "./stubs.js";

/**
 * The picture pipeline, which both `actor.create` and `actor.place` send a token
 * image down. Every rule here is a rule about somebody else's data directory —
 * what may become a path, what may become a file, and what may quietly replace a
 * picture that was already there — so each one is a value with a test rather than
 * something a customer discovers at a table.
 */

// ------------------------------------------------------------------ the image

describe("readActorImage", () => {
  it("reads an absent picture as none, which creates an art-less actor", () => {
    expect(readActorImage(null)).toEqual({ status: "none" });
    expect(readActorImage(undefined)).toEqual({ status: "none" });
  });

  it("refuses a picture that is not the shape both ends agreed on", () => {
    expect(readActorImage(PNG_DATA_URL).status).toBe("refused");
    expect(readActorImage([{ dataUrl: PNG_DATA_URL }]).status).toBe("refused");
    expect(readActorImage({}).status).toBe("refused");
  });

  it("names the picture from the mime type when MoT suggested nothing", () => {
    const result = readActorImage({ dataUrl: PNG_DATA_URL });
    expect(result).toEqual({
      status: "ready",
      image: { mimeType: "image/png", base64: PNG_BASE64, filename: `${FALLBACK_FILE_STEM}.png` },
    });
  });
});

// -------------------------------------------------------------- the data URL

describe("parseImageDataUrl", () => {
  it("reads a base64 image data URL", () => {
    expect(parseImageDataUrl(PNG_DATA_URL)).toEqual({ mimeType: "image/png", base64: PNG_BASE64 });
  });

  it("accepts any image content type, and lower-cases it", () => {
    expect(parseImageDataUrl(`DATA:IMAGE/WEBP;BASE64,${PNG_BASE64}`)?.mimeType).toBe("image/webp");
    expect(parseImageDataUrl(`data:image/svg+xml;base64,${PNG_BASE64}`)?.mimeType).toBe("image/svg+xml");
  });

  it("carries media-type parameters without tripping over them", () => {
    expect(parseImageDataUrl(`data:image/png;charset=utf-8;base64,${PNG_BASE64}`)?.mimeType).toBe("image/png");
  });

  it("REFUSES every scheme that is not a base64 image data URL", () => {
    // The wall the whole file is built around: everything past this point turns
    // the string into bytes inside the keeper's own world directory.
    expect(parseImageDataUrl("javascript:alert(1)")).toBeNull();
    expect(parseImageDataUrl("https://masteroftales.com/tokens/bugbear.png")).toBeNull();
    expect(parseImageDataUrl("worlds/barovia/tokens/ireena.png")).toBeNull();
    expect(parseImageDataUrl(`data:text/html;base64,${PNG_BASE64}`)).toBeNull();
    expect(parseImageDataUrl(`data:application/octet-stream;base64,${PNG_BASE64}`)).toBeNull();
    expect(parseImageDataUrl("data:image/png,%89PNG")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64")).toBeNull();
  });

  it("refuses a payload that is not base64 at all", () => {
    expect(parseImageDataUrl("data:image/png;base64,not base64!!")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,abcde")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("tolerates the line breaks a wrapped base64 payload arrives with", () => {
    const wrapped = `data:image/png;base64,${PNG_BASE64.slice(0, 4)}\n  ${PNG_BASE64.slice(4)}`;
    expect(parseImageDataUrl(wrapped)?.base64).toBe(PNG_BASE64);
  });

  it("refuses anything that is not a string, and anything past the cap", () => {
    expect(parseImageDataUrl(null)).toBeNull();
    expect(parseImageDataUrl({ dataUrl: PNG_DATA_URL })).toBeNull();
    expect(parseImageDataUrl(`data:image/png;base64,${"A".repeat(MAX_DATA_URL_LENGTH)}`)).toBeNull();
  });
});

// --------------------------------------------------------------- the filename

describe("safeFileName", () => {
  it("keeps an ordinary basename", () => {
    expect(safeFileName("bugbear.png", "image/png")).toBe("bugbear.png");
  });

  it("STRIPS directory components — a filename off a wire may not name a path", () => {
    expect(safeFileName("../../worlds/barovia/bugbear.png", "image/png")).toBe("bugbear.png");
    expect(safeFileName("C:\\Users\\gm\\bugbear.png", "image/png")).toBe("bugbear.png");
    expect(safeFileName("..", "image/png")).toBe("token.png");
    expect(safeFileName("/etc/passwd", "image/png")).toBe("passwd.png");
  });

  it("takes the extension from the bytes rather than the suggestion", () => {
    // A PNG named .jpg is a file that lies to every tool that later opens it.
    expect(safeFileName("bugbear.jpg", "image/png")).toBe("bugbear.png");
    expect(safeFileName("bugbear", "image/jpeg")).toBe("bugbear.jpg");
    expect(safeFileName("bugbear.png", "image/webp")).toBe("bugbear.webp");
  });

  it("reduces anything outside [A-Za-z0-9._-] to a dash", () => {
    expect(safeFileName("Ash Hollow Bugbear!.png", "image/png")).toBe("Ash-Hollow-Bugbear.png");
    expect(safeFileName("bug/bear;rm -rf.png", "image/png")).toBe("bear-rm-rf.png");
  });

  it("never starts with a dot and never sanitises away to nothing", () => {
    expect(safeFileName(".htaccess", "image/png")).toBe("htaccess.png");
    expect(safeFileName("...", "image/png")).toBe("token.png");
    expect(safeFileName("", "image/png")).toBe("token.png");
    expect(safeFileName(null, "image/png")).toBe("token.png");
    expect(safeFileName("!!!", "image/png")).toBe("token.png");
  });

  it("caps the stem", () => {
    expect(safeFileName(`${"b".repeat(400)}.png`, "image/png")).toBe(`${"b".repeat(60)}.png`);
  });

  it("keeps an inner dot, which is a legal part of a name", () => {
    expect(safeFileName("ash.hollow.bugbear.png", "image/png")).toBe("ash.hollow.bugbear.png");
  });
});

describe("extensionFor", () => {
  it("spells the well-travelled types", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("IMAGE/PNG")).toBe("png");
    expect(extensionFor("image/svg+xml")).toBe("svg");
  });

  it("derives an extension for a type it has never heard of", () => {
    expect(extensionFor("image/x-tga")).toBe("xtga");
    expect(extensionFor("image/")).toBe("png");
  });
});

describe("uniqueFileName", () => {
  it("keeps the name when nothing has it", () => {
    expect(uniqueFileName("bugbear.png", [])).toBe("bugbear.png");
    expect(uniqueFileName("bugbear.png", ["masteroftales-tokens/goblin.png"])).toBe("bugbear.png");
  });

  it("NEVER overwrites — Foundry's own upload would, silently", () => {
    const taken = ["masteroftales-tokens/bugbear.png"];
    expect(uniqueFileName("bugbear.png", taken)).toBe("bugbear-1.png");
    expect(uniqueFileName("bugbear.png", [...taken, "masteroftales-tokens/bugbear-1.png"])).toBe("bugbear-2.png");
  });

  it("compares case-insensitively, because some filesystems do", () => {
    expect(uniqueFileName("bugbear.png", ["masteroftales-tokens/BugBear.PNG"])).toBe("bugbear-1.png");
  });

  it("ignores anything in the listing that is not a path", () => {
    expect(uniqueFileName("bugbear.png", [null, 7, ""] as unknown as string[])).toBe("bugbear.png");
  });
});

// ------------------------------------------------------------ resolving foundry

describe("resolveFilePicker", () => {
  const picker = Object.assign(function FilePicker() {}, { upload: () => undefined });
  const legacy = Object.assign(function FilePicker() {}, { upload: () => undefined });

  it("prefers the v13 namespace over the deprecated bare global", () => {
    const scope = { foundry: { applications: { apps: { FilePicker: picker } } }, FilePicker: legacy };
    expect(resolveFilePicker(scope)).toBe(picker);
  });

  it("falls back to the bare global", () => {
    expect(resolveFilePicker({ FilePicker: legacy })).toBe(legacy);
  });

  it("answers null for a client that has neither, or one with no upload on it", () => {
    expect(resolveFilePicker({})).toBeNull();
    expect(resolveFilePicker(null)).toBeNull();
    expect(resolveFilePicker({ FilePicker: function FilePicker() {} })).toBeNull();
  });
});

// --------------------------------------------------------------- the bytes

describe("decodeBase64 / buildTokenFile", () => {
  it("decodes to the bytes that went in", () => {
    expect([...(decodeBase64(PNG_BASE64) ?? [])]).toEqual([...PNG_BYTES]);
  });

  it("answers null rather than throwing for a payload atob refuses", () => {
    expect(decodeBase64("@@@ not base64 @@@")).toBeNull();
  });

  it("answers null on a client with no atob", () => {
    expect(decodeBase64(PNG_BASE64, {})).toBeNull();
  });

  it("builds a File carrying the name and the content type", async () => {
    const file = buildTokenFile(tokenImage()) as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("bugbear.png");
    expect(file.type).toBe("image/png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...PNG_BYTES]);
  });

  it("answers null on a client with no File constructor", () => {
    expect(buildTokenFile(tokenImage(), {})).toBeNull();
  });
});

// -------------------------------------------------------------- the upload

describe("prepareTokenDirectory", () => {
  it("lists what is already there", async () => {
    const picker = fakePicker({ files: ["masteroftales-tokens/goblin.png"] });
    await expect(prepareTokenDirectory(picker.api)).resolves.toEqual(["masteroftales-tokens/goblin.png"]);
    expect(picker.created).toEqual([]);
  });

  it("creates the directory when it is not there yet, then lists it", async () => {
    const picker = fakePicker({ files: null });
    await expect(prepareTokenDirectory(picker.api)).resolves.toEqual([]);
    expect(picker.created).toEqual([TOKEN_DIRECTORY]);
  });

  it("TOLERATES a directory that already exists — another client may have just made it", async () => {
    const log = createLog();
    const picker = fakePicker({ files: null, createDirectoryRejects: new Error("EEXIST: file already exists") });
    await expect(prepareTokenDirectory(picker.api, log)).resolves.toEqual([]);
    expect(log.lines.warn).toEqual([]);
  });

  it("shrugs at a Foundry with no browse at all", async () => {
    const picker = fakePicker({ omitBrowse: true });
    await expect(prepareTokenDirectory(picker.api)).resolves.toEqual([]);
  });
});

describe("uploadedPath", () => {
  it("reads Foundry's own success answer", () => {
    expect(uploadedPath({ status: "success", path: "masteroftales-tokens/bugbear.png" }, "fallback")).toBe(
      "masteroftales-tokens/bugbear.png",
    );
  });

  it("reads `false` as the failure it is — Foundry returns it rather than throwing", () => {
    expect(uploadedPath(false, "fallback")).toBeNull();
    expect(uploadedPath(null, "fallback")).toBeNull();
    expect(uploadedPath(undefined, "fallback")).toBeNull();
    expect(uploadedPath({ status: "error", message: "no" }, "fallback")).toBeNull();
  });

  it("falls back to the composed path for an answer it does not recognise", () => {
    expect(uploadedPath({ status: "success" }, "fallback")).toBe("fallback");
    expect(uploadedPath(true, "fallback")).toBe("fallback");
  });
});

describe("uploadTokenImage", () => {
  it("uploads into the module's own directory, with Foundry's own toast suppressed", async () => {
    const picker = fakePicker();
    const path = await uploadTokenImage(picker.api, tokenImage());

    expect(path).toBe("masteroftales-tokens/bugbear.png");
    expect(picker.uploads).toHaveLength(1);
    expect(picker.uploads[0]?.source).toBe(DATA_SOURCE);
    expect(picker.uploads[0]?.path).toBe(TOKEN_DIRECTORY);
    expect(picker.uploads[0]?.file.name).toBe("bugbear.png");
    // This module reports its own failures, in its own voice, once.
    expect(picker.uploads[0]?.options).toEqual({ notify: false });
  });

  it("uniques the name rather than replacing a picture already there", async () => {
    const picker = fakePicker({ files: ["masteroftales-tokens/bugbear.png"] });
    const path = await uploadTokenImage(picker.api, tokenImage());

    expect(path).toBe("masteroftales-tokens/bugbear-1.png");
    expect(picker.uploads[0]?.file.name).toBe("bugbear-1.png");
  });

  it("answers null when Foundry refuses the upload, by throwing or by saying false", async () => {
    const log = createLog();
    await expect(uploadTokenImage(fakePicker({ uploadRejects: true }).api, tokenImage(), log)).resolves.toBeNull();
    await expect(uploadTokenImage(fakePicker({ uploadResult: false }).api, tokenImage())).resolves.toBeNull();
    expect(log.lines.warn).toHaveLength(1);
  });

  it("answers null without uploading when the bytes will not decode", async () => {
    const picker = fakePicker();
    const log = createLog();
    await expect(uploadTokenImage(picker.api, tokenImage({ base64: "not base64" }), log)).resolves.toBeNull();
    expect(picker.uploads).toEqual([]);
    expect(log.lines.warn).toHaveLength(1);
  });
});
