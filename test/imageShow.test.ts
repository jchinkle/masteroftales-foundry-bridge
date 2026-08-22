import { describe, expect, it } from "vitest";
import type { ImagePlan, ImageShowSocketEvent } from "../src/commands/images.js";
import {
  createImageShowHandler,
  createImageSocketListener,
  IMAGE_SHOW_EVENT,
  imagePopoutArgs,
  isTargeted,
  MAX_TARGETS,
  MAX_TITLE_LENGTH,
  planImageShow,
  planTargets,
  renderImagePopout,
  resolveImagePopout,
  SOCKET_CHANNEL,
} from "../src/commands/images.js";
import { createDispatcher } from "../src/commands/index.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { createImagePopout, createLog, createModuleSocket, flushMicrotasks } from "./stubs.js";

/** An `image.show` payload as MoT broadcasts one. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://masteroftales.test/uploads/barovia.webp",
    title: "The gates of Barovia",
    targets: "all",
    ...overrides,
  };
}

function plan(overrides: Partial<ImagePlan> = {}): ImagePlan {
  return { url: "https://masteroftales.test/map.webp", title: "A map", targets: "all", ...overrides };
}

// --------------------------------------------------------------------- plan

describe("planImageShow", () => {
  it("normalises the ordinary case", () => {
    expect(planImageShow(payload())).toEqual({
      url: "https://masteroftales.test/uploads/barovia.webp",
      title: "The gates of Barovia",
      targets: "all",
    });
  });

  it("keeps a target list, deduped and trimmed", () => {
    const result = planImageShow(payload({ targets: [" p1 ", "p2", "p1", "", 7, null] }));
    expect(result?.targets).toEqual(["p1", "p2"]);
  });

  it("accepts a relative Foundry asset path — that is how the GM's own maps are spelled", () => {
    const result = planImageShow(payload({ url: "worlds/curse-of-strahd/maps/barovia.webp" }));
    // Returned verbatim, not resolved: an absolutised path would point at the
    // parsing base rather than at the Foundry server.
    expect(result?.url).toBe("worlds/curse-of-strahd/maps/barovia.webp");
  });

  it("refuses a javascript: url", () => {
    expect(planImageShow(payload({ url: "javascript:alert(1)" }))).toBeNull();
    // And the newline trick, which `URL` would otherwise strip into a valid one.
    expect(planImageShow(payload({ url: "java\nscript:alert(1)" }))).toBeNull();
  });

  it("refuses a data: url", () => {
    expect(planImageShow(payload({ url: "data:image/png;base64,iVBORw0KGgo=" }))).toBeNull();
  });

  it("drops a payload with no usable url", () => {
    for (const url of [undefined, null, "", "   ", 7, {}]) {
      expect(planImageShow(payload({ url }))).toBeNull();
    }
  });

  it("drops a payload that targets nobody, rather than defaulting to everybody", () => {
    // The direction is the whole point: a command whose targeting MoT failed to
    // send must show nobody anything, not put a picture on every screen.
    expect(planImageShow(payload({ targets: [] }))).toBeNull();
    expect(planImageShow(payload({ targets: undefined }))).toBeNull();
    expect(planImageShow(payload({ targets: "everyone" }))).toBeNull();
    expect(planImageShow(payload({ targets: ["", "  "] }))).toBeNull();
  });

  it("strips markup out of a title and caps it", () => {
    expect(planImageShow(payload({ title: "<b>Barovia</b>" }))?.title).toBe("Barovia");
    expect(planImageShow(payload({ title: "T".repeat(400) }))?.title?.length).toBe(MAX_TITLE_LENGTH);
    expect(planImageShow(payload({ title: "   " }))?.title).toBeNull();
    expect(planImageShow(payload({ title: 12 }))?.title).toBeNull();
  });

  it("drops anything that is not an object", () => {
    for (const bad of [null, undefined, "image", 7, [], [payload()]]) {
      expect(planImageShow(bad)).toBeNull();
    }
  });

  it("caps the target list", () => {
    const targets = Array.from({ length: MAX_TARGETS + 40 }, (_, index) => `u${index}`);
    expect(planTargets(targets)).toHaveLength(MAX_TARGETS);
  });
});

describe("isTargeted", () => {
  it("is true for everyone on `all`", () => {
    expect(isTargeted("all", "p1")).toBe(true);
    expect(isTargeted("all", null)).toBe(true);
  });

  it("is true only for the named ids on a list", () => {
    expect(isTargeted(["p1", "p2"], "p2")).toBe(true);
    expect(isTargeted(["p1", "p2"], "p3")).toBe(false);
  });

  it("is false for a client that does not know its own user id", () => {
    expect(isTargeted(["p1"], null)).toBe(false);
    expect(isTargeted(["p1"], "")).toBe(false);
  });

  it("is false when there are no targets at all", () => {
    expect(isTargeted(null, "p1")).toBe(false);
  });
});

// ------------------------------------------------------------ version glue

describe("resolveImagePopout", () => {
  it("prefers the v13+ namespace over the deprecated global", () => {
    // Load-bearing: on v13 both spellings exist and are the *same* ApplicationV2
    // class, so finding the global first and then calling it with the v12
    // argument list would open a popout with no image in it.
    const popout = createImagePopout();
    const resolved = resolveImagePopout(popout.v13Scope);
    expect(resolved?.style).toBe("v13");
    expect(resolved?.ImagePopout).toBe(
      (popout.v13Scope.foundry as { applications: { apps: { ImagePopout: unknown } } }).applications.apps.ImagePopout,
    );
  });

  it("falls back to a bare global as the v12-era signature", () => {
    expect(resolveImagePopout(createImagePopout().legacyScope)?.style).toBe("legacy");
  });

  it("is null in anything that is not a Foundry", () => {
    expect(resolveImagePopout({})).toBeNull();
    expect(resolveImagePopout(null)).toBeNull();
    expect(resolveImagePopout({ foundry: { applications: { apps: { ImagePopout: "nope" } } } })).toBeNull();
  });
});

describe("imagePopoutArgs", () => {
  it("builds the v13+ single options object, with the title under `window`", () => {
    expect(imagePopoutArgs(plan({ title: "A map" }), "v13")).toEqual([
      { src: "https://masteroftales.test/map.webp", shareable: false, title: "A map", window: { title: "A map" } },
    ]);
  });

  it("omits the title entirely when there is none, so the popout titles itself", () => {
    expect(imagePopoutArgs(plan({ title: null }), "v13")).toEqual([
      { src: "https://masteroftales.test/map.webp", shareable: false },
    ]);
  });

  it("builds the v12-era `(src, options)` pair", () => {
    expect(imagePopoutArgs(plan({ title: "A map" }), "legacy")).toEqual([
      "https://masteroftales.test/map.webp",
      { title: "A map", shareable: false },
    ]);
  });
});

describe("renderImagePopout", () => {
  it("constructs and force-renders", () => {
    const popout = createImagePopout();
    const api = resolveImagePopout(popout.v13Scope);

    expect(renderImagePopout(plan(), api!)).toBe(true);
    expect(popout.last?.rendered).toEqual([true]);
  });

  it("shrugs when Foundry refuses to construct one", () => {
    const popout = createImagePopout({ constructorThrows: true });
    expect(renderImagePopout(plan(), resolveImagePopout(popout.v13Scope)!)).toBe(false);
  });

  it("swallows a rejected render rather than leaving an unhandled rejection", async () => {
    const popout = createImagePopout({ renderRejects: true });
    expect(renderImagePopout(plan(), resolveImagePopout(popout.v13Scope)!)).toBe(true);
    await flushMicrotasks();
  });
});

// ------------------------------------------------------------ the GM's half

function gmHandler(overrides: { selfId?: string | null; isActive?: boolean } = {}) {
  const socket = createModuleSocket();
  const emitted: ImageShowSocketEvent[] = [];
  const renderedLocally: ImagePlan[] = [];
  const log = createLog();

  const handle = createImageShowHandler({
    isActive: () => overrides.isActive !== false,
    emit: (event) => {
      emitted.push(event);
      socket.socket.emit(SOCKET_CHANNEL, event);
    },
    selfId: () => (overrides.selfId === undefined ? "gm1" : overrides.selfId),
    renderLocal: (image) => void renderedLocally.push(image),
    log,
  });

  return { handle, socket, emitted, renderedLocally, log };
}

describe("createImageShowHandler", () => {
  it("puts the command on the module socket, with the targets intact", () => {
    const gm = gmHandler();
    gm.handle(payload({ targets: ["p1", "p2"] }));

    expect(gm.socket.emitted).toEqual([
      {
        event: `module.${MODULE_ID}`,
        data: {
          type: IMAGE_SHOW_EVENT,
          url: "https://masteroftales.test/uploads/barovia.webp",
          title: "The gates of Barovia",
          targets: ["p1", "p2"],
        },
      },
    ]);
  });

  it("renders locally too when the GM is a target — Foundry does not echo `emit`", () => {
    const gm = gmHandler({ selfId: "gm1" });
    gm.handle(payload({ targets: ["gm1", "p1"] }));

    expect(gm.socket.emitted).toHaveLength(1);
    expect(gm.renderedLocally.map((image) => image.url)).toEqual([
      "https://masteroftales.test/uploads/barovia.webp",
    ]);
  });

  it("renders locally on `all`", () => {
    const gm = gmHandler();
    gm.handle(payload({ targets: "all" }));
    expect(gm.renderedLocally).toHaveLength(1);
  });

  it("does NOT render locally when the GM was not targeted", () => {
    const gm = gmHandler({ selfId: "gm1" });
    gm.handle(payload({ targets: ["p1", "p2"] }));

    expect(gm.socket.emitted).toHaveLength(1);
    expect(gm.renderedLocally).toEqual([]);
  });

  it("does nothing at all on a client that is not the active GM", () => {
    // One client owns the re-broadcast; a two-GM table would otherwise open
    // every picture twice on every player's screen.
    const gm = gmHandler({ isActive: false });
    gm.handle(payload());

    expect(gm.socket.emitted).toEqual([]);
    expect(gm.renderedLocally).toEqual([]);
  });

  it("drops a malformed command calmly", () => {
    const gm = gmHandler();
    gm.handle(payload({ url: "javascript:alert(1)" }));
    gm.handle(null);

    expect(gm.socket.emitted).toEqual([]);
    expect(gm.renderedLocally).toEqual([]);
    expect(gm.log.lines.debug).toHaveLength(2);
  });

  it("still opens the GM's own copy when the socket refuses the emit", () => {
    const log = createLog();
    const renderedLocally: ImagePlan[] = [];
    const handle = createImageShowHandler({
      isActive: () => true,
      emit: () => {
        throw new Error("socket is not connected");
      },
      selfId: () => "gm1",
      renderLocal: (image) => void renderedLocally.push(image),
      log,
    });

    handle(payload({ targets: "all" }));
    expect(renderedLocally).toHaveLength(1);
    expect(log.lines.debug).toHaveLength(1);
  });
});

// ---------------------------------------------------- the every-client half

function client(userId: string | null, options: { scope?: "v13" | "legacy" | "none" } = {}) {
  const popout = createImagePopout();
  const log = createLog();
  const scope =
    options.scope === "legacy" ? popout.legacyScope : options.scope === "none" ? {} : popout.v13Scope;

  const listen = createImageSocketListener({
    selfId: () => userId,
    api: () => resolveImagePopout(scope),
    log,
  });

  return { listen, popout, log };
}

/** The event exactly as `createImageShowHandler` puts it on the wire. */
function socketEvent(overrides: Partial<ImageShowSocketEvent> = {}): unknown {
  return {
    type: IMAGE_SHOW_EVENT,
    url: "https://masteroftales.test/uploads/barovia.webp",
    title: "The gates of Barovia",
    targets: "all",
    ...overrides,
  };
}

describe("createImageSocketListener", () => {
  it("renders for a targeted user", () => {
    const p1 = client("p1");
    p1.listen(socketEvent({ targets: ["p1"] }));

    expect(p1.popout.popouts).toHaveLength(1);
    expect(p1.popout.last?.args).toEqual([
      {
        src: "https://masteroftales.test/uploads/barovia.webp",
        shareable: false,
        title: "The gates of Barovia",
        window: { title: "The gates of Barovia" },
      },
    ]);
    expect(p1.popout.last?.rendered).toEqual([true]);
  });

  it("ignores an event aimed at somebody else", () => {
    const p2 = client("p2");
    p2.listen(socketEvent({ targets: ["p1"] }));

    expect(p2.popout.popouts).toEqual([]);
    // Not even a debug line: every client in the world receives this, and a
    // whisper to one player must not log on four other machines.
    expect(p2.log.lines.debug).toEqual([]);
  });

  it("renders everywhere on `all`", () => {
    const event = socketEvent({ targets: "all" });
    for (const id of ["gm1", "p1", "p2"]) {
      const each = client(id);
      each.listen(event);
      expect(each.popout.popouts).toHaveLength(1);
    }
  });

  it("goes through the full validation again rather than trusting the sender", () => {
    // It arrived over a socket, from a client this repo did not write.
    const p1 = client("p1");
    p1.listen(socketEvent({ url: "javascript:alert(1)" as string }));
    p1.listen(socketEvent({ targets: [] as string[] }));

    expect(p1.popout.popouts).toEqual([]);
    expect(p1.log.lines.debug).toHaveLength(2);
  });

  it("ignores a malformed payload", () => {
    const p1 = client("p1");
    for (const bad of [null, undefined, "imageShow", 7, [], {}]) p1.listen(bad);
    expect(p1.popout.popouts).toEqual([]);
  });

  it("ignores an event of a type it does not own, silently", () => {
    const p1 = client("p1");
    p1.listen({ type: "musicCue", url: "https://masteroftales.test/a.mp3", targets: "all" });

    expect(p1.popout.popouts).toEqual([]);
    expect(p1.log.lines.debug).toEqual([]);
  });

  it("uses the v12 argument list when only the bare global exists", () => {
    const p1 = client("p1", { scope: "legacy" });
    p1.listen(socketEvent({ targets: ["p1"] }));

    expect(p1.popout.last?.args).toEqual([
      "https://masteroftales.test/uploads/barovia.webp",
      { title: "The gates of Barovia", shareable: false },
    ]);
  });

  it("drops calmly on a client with no ImagePopout at all", () => {
    const p1 = client("p1", { scope: "none" });
    p1.listen(socketEvent({ targets: ["p1"] }));
    expect(p1.log.lines.debug).toHaveLength(1);
  });
});

// ------------------------------------------------------ end to end, in memory

describe("the whole path", () => {
  it("carries one MoT command to exactly the targeted clients", () => {
    const socket = createModuleSocket();
    const gm = { id: "gm1", popout: createImagePopout() };
    const players = ["p1", "p2"].map((id) => ({ id, popout: createImagePopout() }));

    // Every client registers the listener at `init` — including the GM's, which
    // is what the local render below deliberately bypasses.
    for (const each of [gm, ...players]) {
      socket.socket.on(
        SOCKET_CHANNEL,
        createImageSocketListener({
          selfId: () => each.id,
          api: () => resolveImagePopout(each.popout.v13Scope),
        }),
      );
    }

    const dispatch = createDispatcher({
      onSession: () => undefined,
      onImageShow: createImageShowHandler({
        isActive: () => true,
        emit: (event) => socket.socket.emit(SOCKET_CHANNEL, event),
        selfId: () => gm.id,
        renderLocal: (image) => void renderImagePopout(image, resolveImagePopout(gm.popout.v13Scope)!),
      }),
    });

    dispatch({ v: 1, type: "image.show", ts: "2026-08-21T20:00:00.000Z", payload: payload({ targets: ["p1"] }) });

    // The GM's client emitted but rendered nothing: it was not a target.
    expect(socket.emitted).toHaveLength(1);
    expect(gm.popout.popouts).toEqual([]);

    // Foundry delivers to every *other* client; each decides for itself.
    socket.deliver(SOCKET_CHANNEL, socket.emitted[0]?.data);
    expect(players[0]?.popout.popouts).toHaveLength(1);
    expect(players[1]?.popout.popouts).toEqual([]);
  });

  it("leaves an unknown command type ignored, exactly as before", () => {
    const log = createLog();
    const dispatch = createDispatcher({ onSession: () => undefined, log });

    dispatch({ v: 1, type: "music.cue", ts: "2026-08-21T20:00:00.000Z", payload: { url: "a.mp3" } });

    expect(log.lines.debug).toEqual(['[masteroftales-bridge] ignoring unknown command type "music.cue"']);
  });

  it("treats image.show with no handler wired as an unknown type rather than a fault", () => {
    const log = createLog();
    const dispatch = createDispatcher({ onSession: () => undefined, log });

    dispatch({ v: 1, type: "image.show", ts: "2026-08-21T20:00:00.000Z", payload: payload() });

    expect(log.lines.debug).toEqual(['[masteroftales-bridge] no renderer wired for "image.show"']);
  });
});
