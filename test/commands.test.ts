import { describe, expect, it, vi } from "vitest";
import { createDispatcher, NO_SESSION, readSessionState, type SessionSummary } from "../src/commands/index.js";
import type { Envelope } from "../src/protocol/types.js";
import { createLog } from "./stubs.js";

function envelope(type: string, payload: unknown = {}): Envelope {
  return { v: 1, type, ts: "2026-08-17T20:00:00Z", payload };
}

/** The exact objects the server sends. */
const LIVE = { status: "live", id: "s1", name: "Session 14" };
const ENDED = { status: "ended", id: "s1", name: "Session 14" };

describe("readSessionState", () => {
  it("reads the project name and session out of bridge.welcome", () => {
    const summary = readSessionState(
      envelope("bridge.welcome", { project_id: "p1", project_name: "Faerûn", session: LIVE }),
    );
    expect(summary).toEqual({
      live: true,
      status: "live",
      id: "s1",
      name: "Session 14",
      projectName: "Faerûn",
    });
  });

  it("falls back to the project id when the server sent no name", () => {
    const summary = readSessionState(envelope("bridge.welcome", { project_id: "p1", session: null }));
    expect(summary?.projectName).toBe("p1");
    expect(summary?.live).toBe(false);
  });

  it("reads a welcome that arrived with nothing live", () => {
    const summary = readSessionState(envelope("bridge.welcome", { project_id: "p1", project_name: "Faerûn", session: null }));
    expect(summary).toEqual({ live: false, status: null, id: null, name: null, projectName: "Faerûn" });
  });

  it("reads session.state, whose payload IS the session object", () => {
    expect(readSessionState(envelope("session.state", LIVE))).toEqual({
      live: true,
      status: "live",
      id: "s1",
      name: "Session 14",
      projectName: null,
    });
  });

  it("treats an ended session.state as not live, though it arrives populated", () => {
    const summary = readSessionState(envelope("session.state", ENDED));
    expect(summary?.live).toBe(false);
    expect(summary?.status).toBe("ended");
    expect(summary?.name).toBe("Session 14");
  });

  it("treats a planned session as not live", () => {
    expect(readSessionState(envelope("session.state", { status: "planned", id: "s2", name: "Next week" }))?.live).toBe(
      false,
    );
  });

  it("returns null for a type it does not know, which is how unknowns get ignored", () => {
    expect(readSessionState(envelope("dice.show", { faces: [20] }))).toBeNull();
    expect(readSessionState(envelope("audio.play"))).toBeNull();
    expect(readSessionState(null)).toBeNull();
    expect(readSessionState(undefined)).toBeNull();
  });

  it("survives a missing or non-object payload", () => {
    expect(readSessionState({ v: 1, type: "session.state", ts: "x", payload: null })).toEqual({
      ...NO_SESSION,
    });
    expect(readSessionState({ v: 1, type: "session.state", ts: "x", payload: "nope" as unknown })).toEqual({
      ...NO_SESSION,
    });
  });
});

describe("createDispatcher", () => {
  it("reports session state to the caller", () => {
    const seen: SessionSummary[] = [];
    const dispatch = createDispatcher({ onSession: (s) => seen.push(s) });

    dispatch(envelope("bridge.welcome", { project_id: "p1", project_name: "Faerûn", session: LIVE }));
    expect(seen).toEqual([
      { live: true, status: "live", id: "s1", name: "Session 14", projectName: "Faerûn" },
    ]);
  });

  it("remembers the project name across later session.state frames", () => {
    const seen: SessionSummary[] = [];
    const dispatch = createDispatcher({ onSession: (s) => seen.push(s) });

    dispatch(envelope("bridge.welcome", { project_id: "p1", project_name: "Faerûn", session: null }));
    dispatch(envelope("session.state", LIVE));

    expect(seen.at(-1)).toEqual({
      live: true,
      status: "live",
      id: "s1",
      name: "Session 14",
      projectName: "Faerûn",
    });
  });

  it("follows a session going live and then ending", () => {
    const seen: SessionSummary[] = [];
    const dispatch = createDispatcher({ onSession: (s) => seen.push(s) });

    dispatch(envelope("bridge.welcome", { project_id: "p1", project_name: "Faerûn", session: null }));
    dispatch(envelope("session.state", LIVE));
    dispatch(envelope("session.state", ENDED));

    expect(seen.map((s) => s.live)).toEqual([false, true, false]);
    // …and the project name survives all three.
    expect(seen.every((s) => s.projectName === "Faerûn")).toBe(true);
  });

  it("IGNORES an unknown type silently — a module ahead of the server loses a feature, not the connection", () => {
    const onSession = vi.fn();
    const log = createLog();
    const dispatch = createDispatcher({ onSession, log });

    dispatch(envelope("audio.play", {}));
    dispatch(envelope("something.invented.next.year"));

    expect(onSession).not.toHaveBeenCalled();
    expect(log.lines.warn).toHaveLength(0);
    expect(log.lines.debug).toHaveLength(2);
  });

  it("routes dice.show and chat.post to their renderers, handing over the payload only", () => {
    const onDiceShow = vi.fn();
    const onChatPost = vi.fn();
    const dispatch = createDispatcher({ onSession: vi.fn(), onDiceShow, onChatPost });

    dispatch(envelope("dice.show", { dice: [{ sides: 20, values: [12] }] }));
    dispatch(envelope("chat.post", { text: "The gate grinds open." }));

    expect(onDiceShow).toHaveBeenCalledWith({ dice: [{ sides: 20, values: [12] }] });
    expect(onChatPost).toHaveBeenCalledWith({ text: "The gate grinds open." });
  });

  it("does not mistake a render command for session state", () => {
    const onSession = vi.fn();
    const dispatch = createDispatcher({ onSession, onDiceShow: vi.fn(), onChatPost: vi.fn() });

    dispatch(envelope("dice.show", { status: "live", id: "s1", name: "Session 14" }));

    expect(onSession).not.toHaveBeenCalled();
  });

  it("treats a render command as unknown when no renderer is wired", () => {
    const log = createLog();
    const dispatch = createDispatcher({ onSession: vi.fn(), log });

    dispatch(envelope("dice.show", { dice: [] }));
    dispatch(envelope("chat.post", { text: "hi" }));

    expect(log.lines.debug).toHaveLength(2);
    expect(log.lines.warn).toHaveLength(0);
  });

  it("keeps the socket alive when a renderer throws", () => {
    const log = createLog();
    const onSession = vi.fn();
    const dispatch = createDispatcher({
      onSession,
      log,
      onDiceShow: () => {
        throw new Error("Dice So Nice exploded");
      },
    });

    expect(() => dispatch(envelope("dice.show", {}))).not.toThrow();
    // …and the very next frame is still handled.
    dispatch(envelope("session.state", LIVE));
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(log.lines.debug).toHaveLength(1);
  });

  it("logs bridge.unsupported — the visible half of ignore-unknown, pointed our way", () => {
    const log = createLog();
    const dispatch = createDispatcher({ onSession: vi.fn(), log });
    dispatch(envelope("bridge.unsupported", { type: "roll.made.v2" }));
    expect(log.lines.warn.join(" ")).toMatch(/did not understand/i);
  });

  it("survives junk without throwing", () => {
    const dispatch = createDispatcher({ onSession: vi.fn() });
    expect(() => dispatch(null as unknown as Envelope)).not.toThrow();
    expect(() => dispatch("nope" as unknown as Envelope)).not.toThrow();
  });

  it("does not mistake an inherited property name for a command type", () => {
    // `type` is a string off the wire, so the renderer table has to be able to
    // say no to "toString" and "constructor" like it does to anything else.
    const log = createLog();
    const onDiceShow = vi.fn();
    const dispatch = createDispatcher({ onSession: vi.fn(), onDiceShow, log });

    dispatch(envelope("toString"));
    dispatch(envelope("constructor"));

    expect(onDiceShow).not.toHaveBeenCalled();
    expect(log.lines.debug.join(" ")).toMatch(/unknown command type/);
  });
});
