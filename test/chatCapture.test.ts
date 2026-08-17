import { describe, expect, it } from "vitest";
import { buildChatEvents, MAX_TEXT_LENGTH, registerChatCapture } from "../src/capture/chat.js";
import { bridgeOriginFlags } from "../src/capture/loopGuard.js";
import type { Envelope } from "../src/protocol/types.js";
import { isActiveGM } from "../src/activation.js";
import { captureContext, chatMessage, createGame, createHooks, die, roll } from "./stubs.js";

const USERS = [
  { id: "gm1", name: "Jeremy", isGM: true, isSelf: true },
  { id: "p1", name: "Alex", isGM: false },
];

function ctx(overrides = {}) {
  return captureContext(overrides, createGame({ users: USERS }));
}

describe("buildChatEvents — rolls", () => {
  it("emits one roll.made per roll with the serialised dice", () => {
    const events = buildChatEvents(
      chatMessage({ rolls: [roll("1d20 + 5", 17, [die({ faces: 20, results: [12] })])], flavor: "Perception" }),
      ctx(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      v: 1,
      type: "roll.made",
      id: "fvtt:msg:msg1",
      ts: "2026-08-17T20:14:03.000Z",
      payload: {
        formula: "1d20 + 5",
        total: 17,
        modifier: null,
        flavor: "Perception",
        dice: [{ sides: 20, results: [{ value: 12, kept: true }] }],
      },
    });
  });

  it("marks discarded results as not kept — the advantage/disadvantage case", () => {
    const events = buildChatEvents(
      chatMessage({
        rolls: [
          roll("2d20kh1", 18, [
            die({ faces: 20, results: [{ result: 18, active: true }, { result: 4, active: false }] }),
          ]),
        ],
      }),
      ctx(),
    );

    expect(events[0]?.payload).toMatchObject({
      dice: [{ sides: 20, results: [{ value: 18, kept: true }, { value: 4, kept: false }] }],
    });
  });

  it("honours the `discarded` flag as well as `active`", () => {
    const events = buildChatEvents(
      chatMessage({
        rolls: [roll("4d6dl1", 12, [die({ faces: 6, results: [{ result: 1, discarded: true }, { result: 5 }] })])],
      }),
      ctx(),
    );
    const dice = (events[0]?.payload as { dice: Array<{ results: Array<{ kept: boolean }> }> }).dice;
    expect(dice[0]?.results.map((r) => r.kept)).toEqual([false, true]);
  });

  it("treats a result with no active/discarded fields as kept", () => {
    const events = buildChatEvents(
      chatMessage({ rolls: [{ formula: "1d6", total: 3, dice: [{ faces: 6, results: [{ result: 3 }] }] }] }),
      ctx(),
    );
    const dice = (events[0]?.payload as { dice: Array<{ results: Array<{ kept: boolean }> }> }).dice;
    expect(dice[0]?.results[0]?.kept).toBe(true);
  });

  it("gives each roll in a multi-roll message its own suffixed key", () => {
    const events = buildChatEvents(
      chatMessage({ rolls: [roll("1d20", 8), roll("2d6", 7)] }),
      ctx(),
    );
    expect(events.map((e) => e.id)).toEqual(["fvtt:msg:msg1:0", "fvtt:msg:msg1:1"]);
  });

  it("handles a roll with no dice terms, e.g. a flat formula", () => {
    const events = buildChatEvents(chatMessage({ rolls: [roll("5", 5, [])] }), ctx());
    expect(events[0]?.payload).toMatchObject({ formula: "5", total: 5, dice: [] });
  });

  it("normalises a null or non-numeric total rather than shipping NaN", () => {
    const events = buildChatEvents(
      chatMessage({ rolls: [{ formula: "1d20", total: null, dice: [] }] }),
      ctx(),
    );
    expect((events[0]?.payload as { total: unknown }).total).toBeNull();
  });

  it("strips HTML out of the flavor text", () => {
    const events = buildChatEvents(
      chatMessage({ rolls: [roll("1d20", 4)], flavor: "<b>Stealth</b> check" }),
      ctx(),
    );
    expect((events[0]?.payload as { flavor: string }).flavor).toBe("Stealth check");
  });

  it("prefers rolls over content — a roll message is never also a chat message", () => {
    const events = buildChatEvents(
      chatMessage({ rolls: [roll("1d20", 4)], content: "<p>some card markup</p>" }),
      ctx(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("roll.made");
  });
});

describe("buildChatEvents — chat", () => {
  it("emits chat.posted with the HTML stripped", () => {
    const events = buildChatEvents(chatMessage({ content: "<p>I search the <b>desk</b></p>" }), ctx());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "chat.posted",
      id: "fvtt:msg:msg1",
      payload: { text: "I search the desk", private: false },
    });
  });

  it("marks a whisper private — captured, and filed as editor-only on the server", () => {
    const events = buildChatEvents(chatMessage({ content: "psst", whisper: ["p1"] }), ctx());
    expect((events[0]?.payload as { private: boolean }).private).toBe(true);
  });

  it("is not private when the whisper array is empty or absent", () => {
    expect((buildChatEvents(chatMessage({ content: "hi", whisper: [] }), ctx())[0]?.payload as { private: boolean }).private).toBe(false);
    expect((buildChatEvents(chatMessage({ content: "hi", whisper: null }), ctx())[0]?.payload as { private: boolean }).private).toBe(false);
  });

  it("truncates a pathological message inside the server's per-event budget", () => {
    const events = buildChatEvents(chatMessage({ content: "x".repeat(50_000) }), ctx());
    expect((events[0]?.payload as { text: string }).text).toHaveLength(MAX_TEXT_LENGTH);
  });
});

describe("buildChatEvents — speaker", () => {
  it("prefers the speaker alias, which is what the table actually saw", () => {
    const events = buildChatEvents(
      chatMessage({ content: "hi", speaker: { alias: "Tharivol", actor: "Actor.a1", token: "Token.t1" }, author: "p1" }),
      ctx(),
    );
    expect((events[0]?.payload as { speaker: unknown }).speaker).toEqual({
      name: "Tharivol",
      actorUuid: "Actor.a1",
      tokenUuid: "Token.t1",
      gm: false,
    });
  });

  it("falls back to the account name when there is no alias", () => {
    const events = buildChatEvents(chatMessage({ content: "hi", speaker: {}, author: "p1" }), ctx());
    expect((events[0]?.payload as { speaker: { name: string } }).speaker.name).toBe("Alex");
  });

  it("falls back to Unknown when the user has been deleted", () => {
    const events = buildChatEvents(chatMessage({ content: "hi", speaker: {}, author: "ghost" }), ctx());
    expect((events[0]?.payload as { speaker: { name: string } }).speaker.name).toBe("Unknown");
  });

  it("marks GM-authored lines", () => {
    const events = buildChatEvents(chatMessage({ content: "hi", speaker: {}, author: "gm1" }), ctx());
    expect((events[0]?.payload as { speaker: { gm: boolean } }).speaker.gm).toBe(true);
  });

  it("reads the v12 `user` field as well as the v13+ `author` field", () => {
    const events = buildChatEvents(
      chatMessage({ content: "hi", speaker: {}, author: null, user: "p1" }),
      ctx(),
    );
    expect((events[0]?.payload as { speaker: { name: string } }).speaker.name).toBe("Alex");
  });

  it("accepts an inlined User document instead of an id", () => {
    const events = buildChatEvents(
      chatMessage({ content: "hi", speaker: {}, author: { id: "x", name: "Robin", isGM: true } }),
      ctx(),
    );
    expect((events[0]?.payload as { speaker: { name: string; gm: boolean } }).speaker).toMatchObject({
      name: "Robin",
      gm: true,
    });
  });
});

describe("buildChatEvents — skips", () => {
  it("SKIPS anything MoT itself put in Foundry — the echo brake", () => {
    const events = buildChatEvents(
      chatMessage({ content: "mirrored dice", rolls: [roll("1d20", 20)], flags: bridgeOriginFlags() }),
      ctx(),
    );
    expect(events).toEqual([]);
  });

  it("skips a message with no id, because no stable key could be minted for it", () => {
    expect(buildChatEvents(chatMessage({ id: null, content: "hi" }), ctx())).toEqual([]);
  });

  it("skips a message that is empty once the markup is gone", () => {
    expect(buildChatEvents(chatMessage({ content: "" }), ctx())).toEqual([]);
    expect(buildChatEvents(chatMessage({ content: "<div><span></span></div>" }), ctx())).toEqual([]);
    expect(buildChatEvents(chatMessage({ content: null }), ctx())).toEqual([]);
  });

  it("is safe on null and undefined messages", () => {
    expect(buildChatEvents(null, ctx())).toEqual([]);
    expect(buildChatEvents(undefined, ctx())).toEqual([]);
  });
});

describe("buildChatEvents — timestamps and ext", () => {
  it("uses the message's own timestamp, not send time", () => {
    const events = buildChatEvents(
      chatMessage({ content: "hi", timestamp: Date.UTC(2026, 0, 2, 3, 4, 5) }),
      ctx(),
    );
    expect(events[0]?.ts).toBe("2026-01-02T03:04:05.000Z");
  });

  it("falls back to the injected clock when a message carries no timestamp", () => {
    const events = buildChatEvents(chatMessage({ content: "hi", timestamp: null }), ctx());
    expect(events[0]?.ts).toBe("2026-08-17T00:00:00.000Z");
  });

  it("omits `ext` entirely when the adapter garnishes nothing", () => {
    const events = buildChatEvents(chatMessage({ content: "hi" }), ctx());
    expect(events[0]).not.toHaveProperty("ext");
  });

  it("attaches `ext` when an adapter supplies it", () => {
    const events = buildChatEvents(
      chatMessage({ content: "hi" }),
      ctx({
        adapter: {
          id: "dnd5e",
          rollExt: () => ({ dnd5e: { advantage: true } }),
          chatExt: () => ({ dnd5e: { card: true } }),
        },
      }),
    );
    expect(events[0]?.ext).toEqual({ dnd5e: { card: true } });
  });
});

describe("registerChatCapture — the activation gate", () => {
  function wire(game: ReturnType<typeof createGame>) {
    const hooks = createHooks();
    const emitted: Envelope[] = [];
    registerChatCapture({
      hooks,
      isActive: () => isActiveGM(game),
      context: () => captureContext({}, game),
      emit: (envelope) => emitted.push(envelope),
    });
    return { hooks, emitted };
  }

  it("captures on the active GM's client", () => {
    const game = createGame({
      users: [{ id: "gm1", name: "Jeremy", isGM: true, isSelf: true }],
      activeGMId: "gm1",
    });
    const { hooks, emitted } = wire(game);
    hooks.emit("createChatMessage", chatMessage({ rolls: [roll("1d20", 15)] }));
    expect(emitted).toHaveLength(1);
  });

  it("STAYS SILENT on a second GM's client — this is why the gate is not isGM", () => {
    // Two GMs are logged in. Both would pass `game.user.isGM`. Only one is the
    // activeGM, and this client is not it — so it must send nothing, or every
    // event in the session log arrives twice.
    const game = createGame({
      users: [
        { id: "gm1", name: "Jeremy", isGM: true, isSelf: false },
        { id: "gm2", name: "Robin", isGM: true, isSelf: true },
      ],
      activeGMId: "gm1",
    });
    expect(game.user?.isGM).toBe(true); // …and yet:
    const { hooks, emitted } = wire(game);
    hooks.emit("createChatMessage", chatMessage({ rolls: [roll("1d20", 15)] }));
    expect(emitted).toEqual([]);
  });

  it("stays silent on a player's client", () => {
    const game = createGame({
      users: [
        { id: "gm1", name: "Jeremy", isGM: true },
        { id: "p1", name: "Alex", isGM: false, isSelf: true },
      ],
      activeGMId: "gm1",
    });
    const { hooks, emitted } = wire(game);
    hooks.emit("createChatMessage", chatMessage({ content: "hello" }));
    expect(emitted).toEqual([]);
  });

  it("registers exactly one core document hook, not a system hook", () => {
    const game = createGame({ activeGMId: "gm1" });
    const { hooks } = wire(game);
    expect([...hooks.handlers.keys()]).toEqual(["createChatMessage"]);
  });

  it("re-reads the gate per event, so a mid-session promotion starts capturing", () => {
    const hooks = createHooks();
    const emitted: Envelope[] = [];
    let active = false;
    const game = createGame();
    registerChatCapture({
      hooks,
      isActive: () => active,
      context: () => captureContext({}, game),
      emit: (envelope) => emitted.push(envelope),
    });

    hooks.emit("createChatMessage", chatMessage({ id: "m1", content: "before" }));
    expect(emitted).toEqual([]);

    active = true; // the other GM dropped; Foundry promoted this client
    hooks.emit("createChatMessage", chatMessage({ id: "m2", content: "after" }));
    expect(emitted).toHaveLength(1);
  });

  it("skips a bridge-origin message even on the active GM's client", () => {
    const game = createGame({ activeGMId: "gm1" });
    const { hooks, emitted } = wire(game);
    hooks.emit("createChatMessage", chatMessage({ rolls: [roll("1d20", 20)], flags: bridgeOriginFlags() }));
    expect(emitted).toEqual([]);
  });
});
