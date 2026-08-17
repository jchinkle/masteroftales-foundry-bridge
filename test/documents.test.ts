import { describe, expect, it } from "vitest";
import {
  changeStamp,
  collectionValues,
  combatantRef,
  docName,
  docUuid,
  documentTimestamp,
  finiteNumber,
  isActorDocument,
  isHidden,
  modifiedTime,
  nonEmptyString,
  plainRecord,
  readPath,
  recordAt,
  tokenDelta,
  tokenImage,
} from "../src/capture/documents.js";
import {
  actorDocument,
  combatant,
  documentContext,
  itemDocument,
  STUB_MTIME,
  tokenDocument,
} from "./stubs.js";

/**
 * The reading layer under all four capture families. Every one of these is a
 * "what does this document actually say, on whichever Foundry major the
 * customer is running, without throwing when the answer is nothing" question —
 * so the interesting assertions are the null ones.
 */

describe("scalar readers", () => {
  it("takes finite numbers and refuses everything else", () => {
    expect(finiteNumber(0)).toBe(0);
    expect(finiteNumber(-1)).toBe(-1);
    expect(finiteNumber(12.5)).toBe(12.5);

    expect(finiteNumber("12")).toBeNull();
    expect(finiteNumber(Number.NaN)).toBeNull();
    expect(finiteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(finiteNumber(null)).toBeNull();
    expect(finiteNumber(undefined)).toBeNull();
    expect(finiteNumber(true)).toBeNull();
  });

  it("trims strings and treats whitespace as absent", () => {
    expect(nonEmptyString("  Tharivol  ")).toBe("Tharivol");
    expect(nonEmptyString("")).toBeNull();
    expect(nonEmptyString("   ")).toBeNull();
    expect(nonEmptyString(null)).toBeNull();
    expect(nonEmptyString(12)).toBeNull();
  });

  it("counts only plain objects as records — an array is not a record", () => {
    expect(plainRecord({ a: 1 })).toEqual({ a: 1 });
    expect(plainRecord([])).toBeNull();
    expect(plainRecord([1, 2])).toBeNull();
    expect(plainRecord(null)).toBeNull();
    expect(plainRecord("x")).toBeNull();
  });
});

describe("path readers", () => {
  const source = { system: { attributes: { hp: { value: 12, max: 30 } } } };

  it("walks a nested path", () => {
    expect(readPath(source, ["system", "attributes", "hp", "value"])).toBe(12);
    expect(recordAt(source, ["system", "attributes", "hp"])).toEqual({ value: 12, max: 30 });
  });

  it("returns null at any missing depth rather than throwing", () => {
    expect(readPath(source, ["system", "nope", "hp"])).toBeNull();
    expect(readPath(null, ["system"])).toBeNull();
    expect(recordAt(source, ["system", "attributes", "hp", "value"])).toBeNull();
  });

  it("returns the source itself for an empty path", () => {
    expect(recordAt({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe("document readers", () => {
  it("reads uuid and name, treating blanks as absent", () => {
    expect(docUuid(actorDocument({ uuid: "Actor.abc" }))).toBe("Actor.abc");
    expect(docUuid(actorDocument({ uuid: null }))).toBeNull();
    expect(docUuid(actorDocument({ uuid: "  " }))).toBeNull();
    expect(docUuid(null)).toBeNull();

    expect(docName(actorDocument({ name: "Tharivol" }))).toBe("Tharivol");
    expect(docName(actorDocument({ name: null }))).toBeNull();
  });

  it("reads _stats.modifiedTime and rejects the values that are not an epoch", () => {
    expect(modifiedTime(actorDocument())).toBe(STUB_MTIME);
    expect(modifiedTime(actorDocument({ modifiedTime: null }))).toBeNull();
    expect(modifiedTime(actorDocument({ modifiedTime: 0 }))).toBeNull();
    expect(modifiedTime(null)).toBeNull();
  });

  it("names an Actor parent and refuses everything else — effects live on Items too", () => {
    expect(isActorDocument(actorDocument())).toBe(true);
    expect(isActorDocument(itemDocument())).toBe(false);
    expect(isActorDocument(null)).toBe(false);
    // A plain source object that never named itself is not evidence of an Actor.
    expect(isActorDocument({ uuid: "Actor.abc" } as FoundryDocument)).toBe(false);
  });
});

describe("changeStamp", () => {
  it("uses Foundry's own mtime when there is one", () => {
    expect(changeStamp(actorDocument(), documentContext())).toBe(String(STUB_MTIME));
  });

  it("falls back to the injected counter — never a wall clock — when there is not", () => {
    const context = documentContext();
    const doc = actorDocument({ modifiedTime: null });

    expect(changeStamp(doc, context)).toBe("s1");
    expect(changeStamp(doc, context)).toBe("s2");
  });

  it("is identical for the same document twice, which is what makes a replay a duplicate", () => {
    const context = documentContext();
    const doc = actorDocument();
    expect(changeStamp(doc, context)).toBe(changeStamp(doc, context));
  });
});

describe("documentTimestamp", () => {
  it("reports when the thing happened at the table, not when we sent it", () => {
    expect(documentTimestamp(actorDocument(), documentContext())).toBe("2026-08-17T20:14:03.000Z");
  });

  it("falls back to the injected clock for a document with no mtime", () => {
    expect(documentTimestamp(actorDocument({ modifiedTime: null }), documentContext())).toBe(
      "2026-08-17T00:00:00.000Z",
    );
  });
});

describe("collectionValues", () => {
  it("passes a plain array through", () => {
    expect(collectionValues([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("prefers `.contents`, which is how Foundry's EmbeddedCollection exposes documents", () => {
    expect(collectionValues({ contents: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("uses `.values()` on a Map — spreading one would yield [id, doc] pairs, not documents", () => {
    const map = new Map([
      ["a", { id: "a" }],
      ["b", { id: "b" }],
    ]);
    expect(collectionValues(map)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("falls back to plain iteration", () => {
    expect(collectionValues(new Set(["x", "y"]))).toEqual(["x", "y"]);
  });

  it("returns an empty array for anything it cannot read", () => {
    expect(collectionValues(null)).toEqual([]);
    expect(collectionValues(undefined)).toEqual([]);
    expect(collectionValues(42)).toEqual([]);
    expect(collectionValues({})).toEqual([]);
  });

  it("survives a collection whose iterator throws", () => {
    const hostile = {
      [Symbol.iterator]() {
        throw new Error("collection is mid-teardown");
      },
    };
    expect(collectionValues(hostile)).toEqual([]);
  });
});

describe("tokenImage", () => {
  it("prefers texture.src — the v10+ location", () => {
    expect(tokenImage(tokenDocument({ texture: { src: "worlds/x/goblin.webp" }, img: "old.png" }))).toBe(
      "worlds/x/goblin.webp",
    );
  });

  it("falls back to the pre-v10 `img`", () => {
    expect(tokenImage(tokenDocument({ texture: null, img: "old.png" }))).toBe("old.png");
  });

  it("falls back to the actor's portrait", () => {
    const token = tokenDocument({ texture: null, img: null, actor: actorDocument({ img: "portrait.webp" }) });
    expect(tokenImage(token)).toBe("portrait.webp");
  });

  it("is null rather than a guess when nothing carries an image", () => {
    expect(tokenImage(tokenDocument({ texture: null, img: null }))).toBeNull();
    expect(tokenImage(null)).toBeNull();
  });
});

describe("isHidden — the privacy rule in one function", () => {
  it("is true only for a token Foundry actually marked hidden", () => {
    expect(isHidden(tokenDocument({ hidden: true }))).toBe(true);
    expect(isHidden(tokenDocument({ hidden: false }))).toBe(false);
    expect(isHidden(tokenDocument({ hidden: null }))).toBe(false);
    expect(isHidden(null)).toBe(false);
  });

  it("does not accept a truthy non-boolean — public is the safe default to be sure about", () => {
    expect(isHidden({ hidden: 1 } as unknown as FoundryTokenDocument)).toBe(false);
  });
});

describe("tokenDelta", () => {
  it("reads the v11+ `delta`", () => {
    expect(tokenDelta({ delta: { system: { hp: 1 } } })).toEqual({ system: { hp: 1 } });
  });

  it("reads the v10 `actorData` — the rename that would silently break mook damage", () => {
    expect(tokenDelta({ actorData: { system: { hp: 1 } } })).toEqual({ system: { hp: 1 } });
  });

  it("prefers `delta` when a migrated world carries both", () => {
    expect(tokenDelta({ delta: { system: { a: 1 } }, actorData: { system: { b: 2 } } })).toEqual({
      system: { a: 1 },
    });
  });

  it("is null when the update touched neither", () => {
    expect(tokenDelta({ x: 1 })).toBeNull();
    expect(tokenDelta(null)).toBeNull();
  });
});

describe("combatantRef", () => {
  it("prefers the resolved documents' uuids", () => {
    const ref = combatantRef(
      combatant({
        name: "Goblin Boss",
        actor: actorDocument({ uuid: "Actor.gob" }),
        token: tokenDocument({ uuid: "Scene.s.Token.t", disposition: -1 }),
      }),
    );

    expect(ref).toEqual({
      name: "Goblin Boss",
      actorUuid: "Actor.gob",
      tokenUuid: "Scene.s.Token.t",
      disposition: -1,
    });
  });

  it("falls back to the raw ids when the documents could not be resolved", () => {
    const ref = combatantRef(combatant({ actor: null, token: null, actorId: "abc", tokenId: "def" }));
    expect(ref).toMatchObject({ actorUuid: "abc", tokenUuid: "def", disposition: null });
  });

  it("falls back through combatant, token then actor for the name", () => {
    expect(combatantRef(combatant({ name: null, token: tokenDocument({ name: "Goblin A" }) }))?.name).toBe(
      "Goblin A",
    );
    expect(
      combatantRef(combatant({ name: null, token: null, actor: actorDocument({ name: "Goblin" }) }))?.name,
    ).toBe("Goblin");
  });

  it("produces a usable ref even when everything is missing — a line, not an exception", () => {
    expect(combatantRef(combatant({ name: null, uuid: null, actor: null, token: null }))).toEqual({
      name: null,
      actorUuid: null,
      tokenUuid: null,
      disposition: null,
    });
  });

  it("is null only for no combatant at all", () => {
    expect(combatantRef(null)).toBeNull();
    expect(combatantRef(undefined)).toBeNull();
  });
});
