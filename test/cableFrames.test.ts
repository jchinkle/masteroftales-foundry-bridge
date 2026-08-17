import { describe, expect, it } from "vitest";
import {
  CHANNEL_IDENTIFIER,
  isUnauthorizedDisconnect,
  parseCableFrame,
  shouldStopReconnecting,
  SUBSCRIBE_COMMAND,
} from "../src/transport/cableFrames.js";

describe("channel identifier", () => {
  it("is the JSON string ActionCable matches subscriptions by", () => {
    expect(CHANNEL_IDENTIFIER).toBe('{"channel":"BridgeChannel"}');
  });

  it("names the channel Rails actually mounts", () => {
    expect(JSON.parse(SUBSCRIBE_COMMAND)).toEqual({
      command: "subscribe",
      identifier: '{"channel":"BridgeChannel"}',
    });
  });
});

describe("parseCableFrame", () => {
  it("parses the cable welcome", () => {
    expect(parseCableFrame('{"type":"welcome"}')).toEqual({ kind: "welcome" });
  });

  it("parses a ping and converts its epoch seconds", () => {
    expect(parseCableFrame('{"type":"ping","message":1755468000}')).toEqual({ kind: "ping", at: 1755468000 });
  });

  it("parses a ping with no usable timestamp", () => {
    expect(parseCableFrame('{"type":"ping"}')).toEqual({ kind: "ping", at: null });
  });

  it("parses subscription confirmation and rejection", () => {
    expect(parseCableFrame({ type: "confirm_subscription", identifier: CHANNEL_IDENTIFIER })).toEqual({
      kind: "confirm_subscription",
      identifier: CHANNEL_IDENTIFIER,
    });
    expect(parseCableFrame({ type: "reject_subscription", identifier: CHANNEL_IDENTIFIER })).toEqual({
      kind: "reject_subscription",
      identifier: CHANNEL_IDENTIFIER,
    });
  });

  it("parses the unauthorized disconnect, which arrives AFTER a successful 101 upgrade", () => {
    expect(parseCableFrame('{"type":"disconnect","reason":"unauthorized","reconnect":false}')).toEqual({
      kind: "disconnect",
      reason: "unauthorized",
      reconnect: false,
    });
  });

  it("treats an omitted `reconnect` as true, the way ActionCable means it", () => {
    expect(parseCableFrame('{"type":"disconnect","reason":"server_restart"}')).toEqual({
      kind: "disconnect",
      reason: "server_restart",
      reconnect: true,
    });
  });

  it("parses a channel data frame into the bridge envelope", () => {
    const frame = parseCableFrame(
      JSON.stringify({
        identifier: CHANNEL_IDENTIFIER,
        message: { v: 1, type: "bridge.welcome", payload: { project_id: "p1" } },
      }),
    );
    expect(frame.kind).toBe("message");
    if (frame.kind !== "message") throw new Error("unreachable");
    expect(frame.envelope.type).toBe("bridge.welcome");
    expect(frame.identifier).toBe(CHANNEL_IDENTIFIER);
  });

  it("accepts an already-parsed object as well as a JSON string", () => {
    expect(parseCableFrame({ type: "welcome" })).toEqual({ kind: "welcome" });
  });

  it("never throws on junk — an unparseable frame is just unknown", () => {
    expect(parseCableFrame("not json at all").kind).toBe("unknown");
    expect(parseCableFrame("").kind).toBe("unknown");
    expect(parseCableFrame(null).kind).toBe("unknown");
    expect(parseCableFrame(42).kind).toBe("unknown");
    expect(parseCableFrame('{"type":"something_new_in_rails_9"}').kind).toBe("unknown");
    expect(parseCableFrame('{"identifier":"x","message":"a string"}').kind).toBe("unknown");
  });
});

describe("disconnect classification", () => {
  it("treats unauthorized and invalid_request as a rejected token", () => {
    expect(isUnauthorizedDisconnect(parseCableFrame({ type: "disconnect", reason: "unauthorized", reconnect: false }))).toBe(true);
    expect(isUnauthorizedDisconnect(parseCableFrame({ type: "disconnect", reason: "invalid_request", reconnect: false }))).toBe(true);
  });

  it("does NOT treat a server restart as a rejected token", () => {
    const frame = parseCableFrame({ type: "disconnect", reason: "server_restart" });
    expect(isUnauthorizedDisconnect(frame)).toBe(false);
    // …and it must be retried, or a MoT deploy would take every customer offline
    // until they reloaded Foundry by hand.
    expect(shouldStopReconnecting(frame)).toBe(false);
  });

  it("stops reconnecting whenever the server says reconnect: false", () => {
    expect(shouldStopReconnecting(parseCableFrame({ type: "disconnect", reason: "whatever", reconnect: false }))).toBe(true);
  });

  it("classifies non-disconnect frames as neither", () => {
    expect(isUnauthorizedDisconnect(parseCableFrame({ type: "welcome" }))).toBe(false);
    expect(shouldStopReconnecting(parseCableFrame({ type: "welcome" }))).toBe(false);
  });
});
