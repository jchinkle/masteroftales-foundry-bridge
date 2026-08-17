import { describe, expect, it } from "vitest";
import { carriesSession, NO_SESSION_STATE, parseSessionState } from "../src/protocol/session.js";

/**
 * The exact object `Bridge::Commands.session_state` emits, which arrives on four
 * different surfaces. These fixtures are copied from the server, not invented.
 */
const LIVE = { status: "live", id: "01J9-live", name: "Session 12" };
const ENDED = { status: "ended", id: "01J9-live", name: "Session 12" };
const PLANNED = { status: "planned", id: "01J9-next", name: "Session 13" };

describe("parseSessionState", () => {
  it("reads a live session", () => {
    expect(parseSessionState(LIVE)).toEqual({
      live: true,
      status: "live",
      id: "01J9-live",
      name: "Session 12",
    });
  });

  it("treats null as nothing live — the state a table spends most of its week in", () => {
    expect(parseSessionState(null)).toEqual(NO_SESSION_STATE);
    expect(parseSessionState(undefined)).toEqual(NO_SESSION_STATE);
  });

  /**
   * The one that would be easy to get backwards. When a session *ends*, the
   * server broadcasts the session that just changed — a populated object with
   * `status: "ended"`, not a null. Deciding liveness by the object's presence
   * would leave the chip green all night after the game finished.
   */
  it("is NOT live for an ended session, which arrives populated rather than null", () => {
    const state = parseSessionState(ENDED);
    expect(state.live).toBe(false);
    expect(state.status).toBe("ended");
    expect(state.name).toBe("Session 12");
  });

  it("is not live for a planned session", () => {
    expect(parseSessionState(PLANNED).live).toBe(false);
    expect(parseSessionState(PLANNED).status).toBe("planned");
  });

  it("rejects a status it does not recognise rather than guessing at it", () => {
    const state = parseSessionState({ status: "paused", id: "x", name: "y" });
    expect(state.status).toBeNull();
    expect(state.live).toBe(false);
  });

  it("does not treat a legacy `live: true` boolean as live — status is the contract", () => {
    expect(parseSessionState({ live: true, name: "Session 12" }).live).toBe(false);
  });

  it("trims and nulls empty strings", () => {
    expect(parseSessionState({ status: "live", id: " x ", name: "  " })).toEqual({
      live: true,
      status: "live",
      id: "x",
      name: null,
    });
  });

  it("survives junk without throwing", () => {
    expect(parseSessionState("nope")).toEqual(NO_SESSION_STATE);
    expect(parseSessionState(42)).toEqual(NO_SESSION_STATE);
    expect(parseSessionState({})).toEqual(NO_SESSION_STATE);
  });
});

describe("carriesSession", () => {
  it("tells an explicit null apart from an absent key", () => {
    // `"session": null` means nothing is live. A body with no `session` key at
    // all — a 202 with an empty body — must leave the chip alone.
    expect(carriesSession({ session: null })).toBe(true);
    expect(carriesSession({ session: LIVE })).toBe(true);
    expect(carriesSession({ accepted: [] })).toBe(false);
    expect(carriesSession(null)).toBe(false);
    expect(carriesSession(undefined)).toBe(false);
  });
});
