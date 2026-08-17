import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeInfo, Envelope, EventBatch } from "../src/protocol/types.js";
import type { PostResult } from "../src/transport/outbox.js";
import type { SessionState } from "../src/protocol/session.js";
import { FLUSH_AT_EVENTS, FLUSH_INTERVAL_MS, MAX_BATCH, MAX_QUEUE, Outbox } from "../src/transport/outbox.js";
import { createLog, deferred, FakeClock, flushMicrotasks } from "./stubs.js";

const BRIDGE: BridgeInfo = {
  world: "test-world",
  foundry: "13.346",
  system: { id: "dnd5e", version: "5.0.2" },
  module: "0.1.0",
};

function event(id: string): Envelope {
  return { v: 1, type: "roll.made", id, ts: "2026-08-17T20:14:03.000Z", payload: {} };
}

interface Harness {
  outbox: Outbox;
  clock: FakeClock;
  log: ReturnType<typeof createLog>;
  batches: EventBatch[];
  /** Set to control the next response. */
  respond: (fn: (batch: EventBatch) => Promise<PostResult>) => void;
  tokenRejections: number;
  sessions: SessionState[];
}

function harness(): Harness {
  const clock = new FakeClock();
  const log = createLog();
  const batches: EventBatch[] = [];
  const sessions: SessionState[] = [];
  let responder: (batch: EventBatch) => Promise<PostResult> = async () => ({ status: 202, body: {} });
  const state = { tokenRejections: 0 };

  const outbox = new Outbox({
    post: (batch) => {
      batches.push(structuredClone(batch));
      return responder(batch);
    },
    bridgeInfo: () => BRIDGE,
    now: () => clock.current,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    // Deterministic jitter: the *ceiling* is what the retention tests care about.
    random: () => 0.5,
    log,
    onTokenRejected: () => {
      state.tokenRejections += 1;
    },
    onSession: (session) => sessions.push(session),
  });

  return {
    outbox,
    clock,
    log,
    batches,
    sessions,
    respond: (fn) => {
      responder = fn;
    },
    get tokenRejections() {
      return state.tokenRejections;
    },
  } as Harness;
}

describe("Outbox flush triggers", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("does not send immediately — a single roll waits for the batch window", async () => {
    h.outbox.enqueue(event("a"));
    await flushMicrotasks();
    expect(h.batches).toHaveLength(0);
  });

  it("sends after the 250ms window", async () => {
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]?.events).toHaveLength(1);
  });

  it("sends immediately once 20 events are queued, without waiting", async () => {
    for (let i = 0; i < FLUSH_AT_EVENTS; i += 1) h.outbox.enqueue(event(`e${i}`));
    await flushMicrotasks();
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]?.events).toHaveLength(FLUSH_AT_EVENTS);
  });

  it("wraps the batch in the protocol envelope with bridge identity", async () => {
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.batches[0]).toMatchObject({ v: 1, bridge: BRIDGE });
  });

  it("never sends more than the server's per-batch cap in one request", async () => {
    // Hold the first batch open so a real backlog builds behind it.
    const gate = deferred<PostResult>();
    h.respond(() => gate.promise);
    for (let i = 0; i < FLUSH_AT_EVENTS; i += 1) h.outbox.enqueue(event(`first${i}`));
    await flushMicrotasks();

    h.respond(async () => ({ status: 202, body: {} }));
    for (let i = 0; i < 150; i += 1) h.outbox.enqueue(event(`e${i}`));

    gate.resolve({ status: 202, body: {} });
    await flushMicrotasks();
    // The enqueues behind the gate already armed the ordinary 250ms window.
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.batches[1]?.events).toHaveLength(MAX_BATCH);
  });

  it("drains the remainder promptly rather than waiting a full window", async () => {
    const gate = deferred<PostResult>();
    h.respond(() => gate.promise);
    for (let i = 0; i < FLUSH_AT_EVENTS; i += 1) h.outbox.enqueue(event(`first${i}`));
    await flushMicrotasks();

    h.respond(async () => ({ status: 202, body: {} }));
    for (let i = 0; i < 105; i += 1) h.outbox.enqueue(event(`e${i}`));

    gate.resolve({ status: 202, body: {} });
    await flushMicrotasks();
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    // …and the tail follows immediately after, not a window later.
    await h.clock.advanceAsync(1);

    expect(h.batches).toHaveLength(3);
    expect(h.batches[1]?.events).toHaveLength(MAX_BATCH);
    expect(h.batches[2]?.events).toHaveLength(5);
  });

  it("does not start a second request while one is in flight", async () => {
    const gate = deferred<PostResult>();
    h.respond(() => gate.promise);

    for (let i = 0; i < FLUSH_AT_EVENTS; i += 1) h.outbox.enqueue(event(`a${i}`));
    await flushMicrotasks();
    expect(h.batches).toHaveLength(1);

    for (let i = 0; i < FLUSH_AT_EVENTS; i += 1) h.outbox.enqueue(event(`b${i}`));
    await flushMicrotasks();
    expect(h.batches).toHaveLength(1);

    gate.resolve({ status: 202, body: {} });
    await flushMicrotasks();
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.batches).toHaveLength(2);
  });

  it("is a no-op when flushed with an empty queue", async () => {
    await h.outbox.flush();
    expect(h.batches).toHaveLength(0);
  });
});

describe("Outbox bounded queue", () => {
  it("holds exactly 500 outstanding events without dropping anything", () => {
    const h = harness();
    h.respond(() => new Promise<PostResult>(() => {})); // never resolves
    for (let i = 0; i < MAX_QUEUE; i += 1) h.outbox.enqueue(event(`e${i}`));
    expect(h.outbox.dropped).toBe(0);
    expect(h.outbox.state.queued).toBe(MAX_QUEUE);
  });

  it("drops the OLDEST past the cap and counts every drop", async () => {
    const h = harness();
    const gate = deferred<PostResult>();
    h.respond(() => gate.promise);

    // 510 events with the network wedged: 20 go in flight, 490 queue behind
    // them, and the cap on *outstanding* events forces ten out.
    for (let i = 0; i < MAX_QUEUE + 10; i += 1) h.outbox.enqueue(event(`e${i}`));
    await flushMicrotasks();

    expect(h.outbox.dropped).toBe(10);
    expect(h.outbox.state.queued).toBe(MAX_QUEUE);

    // The in-flight batch is untouched — dropping under it is the bug this
    // separation exists to prevent.
    expect(h.batches[0]?.events.map((e) => e.id)).toEqual(
      Array.from({ length: FLUSH_AT_EVENTS }, (_unused, i) => `e${i}`),
    );

    // What went is the oldest *queued* run, e20..e29, and the next batch off the
    // queue therefore starts at e30.
    gate.resolve({ status: 202, body: {} });
    await flushMicrotasks();
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.batches[1]?.events[0]?.id).toBe(`e${FLUSH_AT_EVENTS + 10}`);
  });

  it("says so in the log when it drops, because silence here looks like working", () => {
    const h = harness();
    h.respond(() => new Promise<PostResult>(() => {}));
    for (let i = 0; i < MAX_QUEUE + 1; i += 1) h.outbox.enqueue(event(`e${i}`));
    expect(h.log.lines.warn.join(" ")).toMatch(/outbox full/i);
  });
});

describe("Outbox receipts (202)", () => {
  /** The real 202 body: four parallel arrays plus the current session. */
  const receipt = (over: Record<string, unknown> = {}) => ({
    session: null,
    accepted: [],
    duplicate: [],
    dropped: [],
    rejected: [],
    ...over,
  });

  it("counts every receipt array", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 202,
      body: receipt({
        accepted: [{ id: "a", entryId: "e1" }, { id: "b", entryId: "e2" }],
        duplicate: [{ id: "c", entryId: "e0" }],
        dropped: [{ id: "d", code: "no_live_session" }],
        rejected: [{ id: "e", code: "missing_type", message: "An event needs a `type`" }],
      }),
    }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.outbox.state.receipts).toEqual({ accepted: 2, duplicate: 1, dropped: 1, rejected: 1 });
  });

  it("treats a DUPLICATE as a quiet ack — it is what a healthy reconnect produces", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 202,
      body: receipt({ duplicate: [{ id: "fvtt:msg:x", entryId: "e1" }] }),
    }));

    h.outbox.enqueue(event("fvtt:msg:x"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.outbox.state.queued).toBe(0);
    expect(h.outbox.state.receipts.duplicate).toBe(1);
    // A replayed outbox must not look like a fault in anybody's console.
    expect(h.log.lines.warn).toHaveLength(0);
    expect(h.log.lines.error).toHaveLength(0);
  });

  it("says NOTHING about a no_live_session drop — the most common outcome there is", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 202,
      body: receipt({ dropped: [{ id: "a", code: "no_live_session" }] }),
    }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.outbox.state.queued).toBe(0);
    expect(h.outbox.state.consecutiveFailures).toBe(0);
    expect(h.log.lines.warn).toHaveLength(0);
    expect(h.log.lines.error).toHaveLength(0);
  });

  it("notes an unknown_type drop with its code, but not as an error", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 202,
      body: receipt({ dropped: [{ id: "fvtt:combat:c1:2:0", code: "unknown_type" }] }),
    }));

    h.outbox.enqueue(event("fvtt:combat:c1:2:0"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    // This module being ahead of that server is not a bug in this module.
    const line = h.log.lines.warn.join(" ");
    expect(line).toMatch(/unknown_type/);
    expect(line).toMatch(/fvtt:combat:c1:2:0/);
    expect(h.log.lines.error).toHaveLength(0);
  });

  it("logs every REJECTED event loudly, with its code and the server's sentence", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 202,
      body: receipt({
        rejected: [
          { id: "fvtt:msg:x", code: "payload_too_large", message: "An event carries at most 16384 bytes" },
        ],
      }),
    }));

    h.outbox.enqueue(event("fvtt:msg:x"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    const line = h.log.lines.error.join(" ");
    expect(line).toMatch(/fvtt:msg:x/);
    expect(line).toMatch(/payload_too_large/);
    expect(line).toMatch(/16384/);
  });

  it("reports a rejection that carried no id, rather than dropping it silently", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 202,
      body: receipt({ rejected: [{ id: null, code: "missing_id", message: "An event needs an `id`" }] }),
    }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.log.lines.error.join(" ")).toMatch(/missing_id/);
  });

  it("acks the batch however the receipts came back", async () => {
    const h = harness();
    h.respond(async () => ({ status: 202, body: receipt({ rejected: [{ id: "a", code: "missing_type" }] }) }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    // A rejected event is a module bug to fix, never a batch to resend.
    expect(h.outbox.state.queued).toBe(0);
    expect(h.outbox.state.consecutiveFailures).toBe(0);
  });

  // --- the 202 as a session-state signal -----------------------------------

  it("reads the session out of the receipt — the POST path is a state signal too", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 202,
      body: receipt({ session: { status: "live", id: "s1", name: "Session 12" } }),
    }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.sessions).toEqual([{ live: true, status: "live", id: "s1", name: "Session 12" }]);
  });

  it("reports `session: null` as nothing live", async () => {
    const h = harness();
    h.respond(async () => ({ status: 202, body: receipt({ dropped: [{ id: "a", code: "no_live_session" }] }) }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.sessions).toEqual([{ live: false, status: null, id: null, name: null }]);
  });

  it("does NOT report a session when the body carried no session key at all", async () => {
    const h = harness();
    h.respond(async () => ({ status: 202, body: { accepted: [{ id: "a", entryId: "e1" }] } }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    // Absent must not blank a chip that a `bridge.welcome` just set correctly.
    expect(h.sessions).toEqual([]);
  });

  it("survives a 202 with no body at all", async () => {
    const h = harness();
    h.respond(async () => ({ status: 202, body: null }));
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.outbox.state.queued).toBe(0);
    expect(h.sessions).toEqual([]);
  });

  it("survives receipt arrays that are missing or the wrong type", async () => {
    const h = harness();
    h.respond(async () => ({ status: 202, body: { session: null, accepted: "nope" } }));
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.outbox.state.queued).toBe(0);
    expect(h.outbox.state.receipts).toEqual({});
  });
});

describe("Outbox failure handling", () => {
  it("RETAINS the batch on 5xx and retries with backoff", async () => {
    const h = harness();
    let attempts = 0;
    h.respond(async () => {
      attempts += 1;
      return attempts === 1 ? { status: 503 } : { status: 202, body: {} };
    });

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.outbox.state.queued).toBe(1);
    expect(h.outbox.state.consecutiveFailures).toBe(1);

    await h.clock.advanceAsync(1_000);
    expect(attempts).toBe(2);
    expect(h.outbox.state.queued).toBe(0);
    expect(h.outbox.state.consecutiveFailures).toBe(0);
  });

  it("RETAINS the batch on a network-level failure", async () => {
    const h = harness();
    h.respond(async () => {
      throw new Error("Failed to fetch");
    });

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.outbox.state.queued).toBe(1);
    expect(h.outbox.state.consecutiveFailures).toBe(1);
    // Offline is a normal state: no error dialog, just a debug line.
    expect(h.log.lines.error).toHaveLength(0);
  });

  it("backs off further on each consecutive failure, staying under the cap", async () => {
    const h = harness();
    h.respond(async () => ({ status: 500 }));

    h.outbox.enqueue(event("a"));
    for (let i = 0; i < 12; i += 1) await h.clock.advanceAsync(60_000);

    expect(h.outbox.state.consecutiveFailures).toBeGreaterThan(5);
    for (const delay of h.clock.delays) expect(delay).toBeLessThanOrEqual(30_000);
    // random() is pinned to 0.5, so each ceiling shows up as exactly half of it.
    expect(h.clock.delays).toContain(500);
    expect(h.clock.delays).toContain(15_000);
  });

  it("STOPS and flags the token on 401, quoting the server's code", async () => {
    const h = harness();
    h.respond(async () => ({
      status: 401,
      body: {
        error: {
          code: "bridge_unauthenticated",
          message: "This bridge token is not valid for any project.",
        },
      },
    }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.outbox.state.tokenRejected).toBe(true);
    expect(h.outbox.state.stopped).toBe(true);
    expect(h.tokenRejections).toBe(1);
    expect(h.log.lines.error.join(" ")).toMatch(/token/i);
    expect(h.log.lines.error.join(" ")).toMatch(/bridge_unauthenticated/);

    // Nothing further is sent or even queued.
    const before = h.batches.length;
    h.outbox.enqueue(event("b"));
    await h.clock.advanceAsync(60_000);
    expect(h.batches).toHaveLength(before);
  });

  it("treats 403 the same way as 401", async () => {
    const h = harness();
    h.respond(async () => ({ status: 403 }));
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.outbox.state.tokenRejected).toBe(true);
  });

  it("HONOURS Retry-After on 429 instead of using its own backoff", async () => {
    const h = harness();
    let attempts = 0;
    h.respond(async () => {
      attempts += 1;
      return attempts === 1 ? { status: 429, retryAfter: "5" } : { status: 202, body: {} };
    });

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.clock.delays).toContain(5_000);

    // Still waiting at 4.9s…
    await h.clock.advanceAsync(4_900);
    expect(attempts).toBe(1);
    // …and away at 5s.
    await h.clock.advanceAsync(200);
    expect(attempts).toBe(2);
    expect(h.outbox.state.queued).toBe(0);
  });

  it("falls back to ordinary backoff on a 429 with no usable Retry-After", async () => {
    const h = harness();
    h.respond(async () => ({ status: 429, retryAfter: "whenever" }));
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.outbox.state.queued).toBe(1);
    expect(h.clock.delays).toContain(500);
  });

  it("DISCARDS a 422 batch loudly, quoting the server's code, rather than looping on it", async () => {
    const h = harness();
    // The real batch-level failure body. Only the envelope can fail the request;
    // anything narrower comes back as a per-event receipt on a 202.
    h.respond(async () => ({
      status: 422,
      body: {
        error: {
          code: "unsupported_protocol_version",
          message: "This server speaks bridge protocol v1 and the batch says v2",
        },
      },
    }));

    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);

    expect(h.outbox.state.queued).toBe(0);
    expect(h.outbox.dropped).toBe(1);
    const line = h.log.lines.error.join(" ");
    expect(line).toMatch(/422/);
    expect(line).toMatch(/unsupported_protocol_version/);
    expect(line).toMatch(/speaks bridge protocol v1/);

    const sent = h.batches.length;
    await h.clock.advanceAsync(60_000);
    expect(h.batches).toHaveLength(sent);
  });

  it("discards invalid_batch and batch_too_large the same way", async () => {
    for (const code of ["invalid_batch", "batch_too_large"]) {
      const h = harness();
      h.respond(async () => ({ status: 422, body: { error: { code, message: `${code} happened` } } }));
      h.outbox.enqueue(event("a"));
      await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
      expect(h.outbox.state.queued).toBe(0);
      expect(h.log.lines.error.join(" ")).toMatch(new RegExp(code));
    }
  });
});

describe("Outbox lifecycle", () => {
  it("ignores enqueues after stop()", async () => {
    const h = harness();
    h.outbox.stop();
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(10_000);
    expect(h.batches).toHaveLength(0);
    expect(h.outbox.state.queued).toBe(0);
  });

  it("resume() clears the rejection flag and drains what was already queued", async () => {
    const h = harness();
    h.respond(async () => ({ status: 401 }));
    h.outbox.enqueue(event("a"));
    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.outbox.state.tokenRejected).toBe(true);
    expect(h.outbox.state.queued).toBe(1);

    h.respond(async () => ({ status: 202, body: {} }));
    h.outbox.resume();
    expect(h.outbox.state.tokenRejected).toBe(false);

    await h.clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(h.outbox.state.queued).toBe(0);
  });

  it("reports state changes so the status chip can follow along", async () => {
    const clock = new FakeClock();
    const onStateChange = vi.fn();
    const outbox = new Outbox({
      post: async () => ({ status: 202, body: {} }),
      bridgeInfo: () => BRIDGE,
      now: () => clock.current,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onStateChange,
    });

    outbox.enqueue(event("a"));
    expect(onStateChange).toHaveBeenCalled();
    await clock.advanceAsync(FLUSH_INTERVAL_MS);
    expect(onStateChange.mock.calls.at(-1)?.[0]).toMatchObject({ queued: 0, inFlight: false });
  });
});
