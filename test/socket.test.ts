import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/protocol/types.js";
import { CHANNEL_IDENTIFIER } from "../src/transport/cableFrames.js";
import type { SocketStatus } from "../src/transport/socket.js";
import { BridgeSocket, STALE_AFTER_MS } from "../src/transport/socket.js";
import { createLog, FakeClock, SocketFactory } from "./stubs.js";

const CABLE_URL = "wss://mot.example/bridge/cable?token=mtb_test";

function harness(options: { url?: string | null; random?: () => number } = {}) {
  const clock = new FakeClock();
  const factory = new SocketFactory();
  const log = createLog();
  const envelopes: Envelope[] = [];
  const statuses: SocketStatus[] = [];

  const socket = new BridgeSocket({
    url: () => (options.url === undefined ? CABLE_URL : options.url),
    createSocket: factory.create,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => clock.current,
    random: options.random ?? (() => 0.5),
    onEnvelope: (envelope) => envelopes.push(envelope),
    onStatus: (status) => statuses.push(status),
    log,
  });

  return { socket, clock, factory, log, envelopes, statuses };
}

/** A channel data frame, the shape ActionCable actually puts on the wire. */
function dataFrame(envelope: Partial<Envelope>): unknown {
  return { identifier: CHANNEL_IDENTIFIER, message: { v: 1, ts: "2026-08-17T20:00:00Z", payload: {}, ...envelope } };
}

describe("BridgeSocket handshake", () => {
  it("opens the cable URL on start", () => {
    const h = harness();
    h.socket.start();
    expect(h.factory.created).toHaveLength(1);
    expect(h.factory.last.url).toBe(CABLE_URL);
    expect(h.socket.currentStatus).toBe("connecting");
  });

  it("stays 'connecting' after the 101 upgrade — a successful upgrade proves nothing about the token", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    expect(h.socket.currentStatus).toBe("connecting");
  });

  it("subscribes to BridgeChannel on the cable welcome, and only then reports connected", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });

    expect(JSON.parse(h.factory.last.lastSent ?? "{}")).toEqual({
      command: "subscribe",
      identifier: CHANNEL_IDENTIFIER,
    });
    expect(h.socket.currentStatus).toBe("connected");
  });

  it("does not dial at all when settings are incomplete", () => {
    const h = harness({ url: null });
    h.socket.start();
    expect(h.factory.created).toHaveLength(0);
    expect(h.socket.currentStatus).toBe("idle");
  });
});

describe("BridgeSocket frame ordering", () => {
  /**
   * The finding from the Rails spike, and the single most important test in this
   * file: `bridge.welcome` is transmitted from `BridgeChannel#subscribed`, which
   * runs *before* ActionCable queues the `confirm_subscription`. Gating message
   * handling on confirmation would drop the session state on every connect —
   * intermittently, and only against a real server.
   */
  it("delivers bridge.welcome that arrives BEFORE confirm_subscription", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });

    h.factory.last.receive(dataFrame({ type: "bridge.welcome", payload: { project_id: "p1" } }));
    expect(h.envelopes).toHaveLength(1);
    expect(h.envelopes[0]?.type).toBe("bridge.welcome");
    expect(h.socket.detail.subscriptionConfirmed).toBe(false);

    h.factory.last.receive({ type: "confirm_subscription", identifier: CHANNEL_IDENTIFIER });
    expect(h.socket.detail.subscriptionConfirmed).toBe(true);
    expect(h.socket.currentStatus).toBe("connected");
  });

  it("also handles the ordinary ordering", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    h.factory.last.receive({ type: "confirm_subscription", identifier: CHANNEL_IDENTIFIER });
    h.factory.last.receive(dataFrame({ type: "session.state", payload: { live: true } }));
    expect(h.envelopes).toHaveLength(1);
  });

  it("ignores an unknown frame type without dropping the connection", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    h.factory.last.receive({ type: "something_added_in_rails_9" });
    h.factory.last.receive("not json");
    expect(h.socket.currentStatus).toBe("connected");
    expect(h.envelopes).toHaveLength(0);
  });
});

describe("BridgeSocket liveness", () => {
  it("records pings as liveness and does not treat them as commands", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    h.factory.last.receive({ type: "ping", message: 1_755_468_000 });

    expect(h.envelopes).toHaveLength(0);
    expect(h.socket.detail.lastPingAt).toBe(1_755_468_000_000);
  });

  it("stays connected as long as pings keep arriving", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });

    for (let i = 0; i < 20; i += 1) {
      h.clock.advance(3_000);
      h.factory.last.receive({ type: "ping", message: 1_000 + i });
    }
    expect(h.socket.currentStatus).toBe("connected");
    expect(h.factory.created).toHaveLength(1);
  });

  it("recycles a socket that has gone quiet — the dropped-NAT case onclose never sees", () => {
    const h = harness();
    h.socket.start();
    const first = h.factory.last;
    first.open();
    first.receive({ type: "welcome" });

    h.clock.advance(STALE_AFTER_MS + 1);

    expect(first.closed).toBe(true);
    expect(h.socket.currentStatus).toBe("offline");

    h.clock.advance(60_000);
    expect(h.factory.created.length).toBeGreaterThan(1);
  });
});

describe("BridgeSocket auth failure", () => {
  it("STOPS reconnecting on an unauthorized disconnect and surfaces 'rejected'", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    // The socket upgraded fine; the refusal comes as a frame afterwards.
    h.factory.last.receive({ type: "disconnect", reason: "unauthorized", reconnect: false });

    expect(h.socket.currentStatus).toBe("rejected");
    expect(h.statuses).toContain("rejected");
    expect(h.log.lines.error.join(" ")).toMatch(/token rejected/i);

    h.clock.advance(10 * 60_000);
    expect(h.factory.created).toHaveLength(1);
  });

  it("STOPS on a rejected subscription — the token resolved to no project", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    h.factory.last.receive({ type: "reject_subscription", identifier: CHANNEL_IDENTIFIER });

    expect(h.socket.currentStatus).toBe("rejected");
    h.clock.advance(10 * 60_000);
    expect(h.factory.created).toHaveLength(1);
  });

  it("does NOT stop for a server restart — that would take every customer offline until they reloaded", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    h.factory.last.receive({ type: "disconnect", reason: "server_restart" });
    h.factory.last.drop();

    expect(h.socket.currentStatus).toBe("offline");
    h.clock.advance(60_000);
    expect(h.factory.created.length).toBeGreaterThan(1);
  });
});

describe("BridgeSocket reconnection", () => {
  it("goes offline and retries after a network close", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    h.factory.last.drop();

    expect(h.socket.currentStatus).toBe("offline");
    h.clock.advance(60_000);
    expect(h.factory.created).toHaveLength(2);
  });

  it("backs off exponentially, with full jitter, under the 30s cap", () => {
    const h = harness({ random: () => 0.5 });
    h.socket.start();

    // Never opened, so no liveness timers exist: every delay here is a reconnect.
    for (let i = 0; i < 8; i += 1) {
      h.factory.last.drop();
      h.clock.advance(60_000);
    }

    // random pinned at 0.5, so each delay is half its ceiling.
    expect(h.clock.delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    for (const delay of h.clock.delays) expect(delay).toBeLessThanOrEqual(30_000);
  });

  it("applies real jitter rather than a fixed schedule", () => {
    const values = [0.1, 0.9].map((r) => {
      const h = harness({ random: () => r });
      h.socket.start();
      h.factory.last.drop();
      return h.clock.delays[0];
    });
    expect(values).toEqual([100, 900]);
  });

  it("RESETS the backoff on a successful welcome, not merely on the socket opening", () => {
    const h = harness();
    h.socket.start();

    // Three failed cycles push the ceiling up.
    for (let i = 0; i < 3; i += 1) {
      h.factory.last.drop();
      h.clock.advance(60_000);
    }
    expect(h.socket.detail.attempts).toBe(3);

    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    expect(h.socket.detail.attempts).toBe(0);

    // The next failure therefore starts from the bottom of the range again.
    const before = h.clock.delays.length;
    h.factory.last.drop();
    const next = h.clock.delays.slice(before).filter((d) => d !== STALE_AFTER_MS)[0];
    expect(next).toBe(500);
  });

  it("does not reset the backoff for a server that accepts TCP and dies", () => {
    const h = harness();
    h.socket.start();
    for (let i = 0; i < 3; i += 1) {
      h.factory.last.open(); // opens, but never sends a cable welcome
      h.factory.last.drop();
      h.clock.advance(60_000);
    }
    expect(h.socket.detail.attempts).toBe(3);
  });

  it("ignores a close event from a socket it has already replaced", () => {
    const h = harness();
    h.socket.start();
    const stale = h.factory.last;
    h.socket.restart();
    const created = h.factory.created.length;

    stale.drop();
    h.clock.advance(60_000);
    // The stale handler must not have scheduled its own reconnect on top.
    expect(h.factory.created).toHaveLength(created);
  });
});

describe("BridgeSocket lifecycle", () => {
  it("stop() closes the socket and stays closed", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.socket.stop();

    expect(h.socket.currentStatus).toBe("idle");
    h.clock.advance(10 * 60_000);
    expect(h.factory.created).toHaveLength(1);
  });

  it("restart() drops the old socket and dials again immediately", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    h.factory.last.receive({ type: "welcome" });
    const first = h.factory.last;

    h.socket.restart();
    expect(first.closed).toBe(true);
    expect(h.factory.created).toHaveLength(2);
    expect(h.socket.currentStatus).toBe("connecting");
  });

  it("survives a createSocket that throws, and retries", () => {
    const clock = new FakeClock();
    const log = createLog();
    let attempts = 0;
    const socket = new BridgeSocket({
      url: () => CABLE_URL,
      createSocket: () => {
        attempts += 1;
        throw new Error("SecurityError: mixed content");
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.current,
      random: () => 0.5,
      onEnvelope: () => {},
      log,
    });

    socket.start();
    expect(attempts).toBe(1);
    clock.advance(60_000);
    expect(attempts).toBeGreaterThan(1);
  });

  it("never logs the token", () => {
    const h = harness();
    h.socket.start();
    h.factory.last.open();
    const everything = [...h.log.lines.debug, ...h.log.lines.warn, ...h.log.lines.error].join(" ");
    expect(everything).not.toContain("mtb_test");
    expect(everything).toContain("<redacted>");
  });
});
