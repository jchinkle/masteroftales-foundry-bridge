import { describe, expect, it } from "vitest";
import type { BridgeInfo, EventBatch } from "../src/protocol/types.js";
import { HEARTBEAT_INTERVAL_MS, Heartbeat } from "../src/transport/heartbeat.js";
import { createLog, deferred, FakeClock, flushMicrotasks } from "./stubs.js";

function bridgeInfo(users: BridgeInfo["users"] = []): BridgeInfo {
  return {
    world: "test-world",
    foundry: "13.346",
    system: { id: "dnd5e", version: "5.0.2" },
    module: "0.3.0",
    users,
  };
}

function harness(options: { fails?: boolean } = {}) {
  const clock = new FakeClock();
  const sent: EventBatch[] = [];
  const log = createLog();
  let roster: BridgeInfo["users"] = [{ id: "p1", name: "Robin", active: true, gm: false }];

  const heartbeat = new Heartbeat({
    bridgeInfo: () => bridgeInfo(roster),
    post: async (batch) => {
      sent.push(batch);
      if (options.fails) throw new Error("network down");
      return { status: 202 };
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log,
  });

  return {
    clock,
    sent,
    log,
    heartbeat,
    setRoster(next: BridgeInfo["users"]) {
      roster = next;
    },
  };
}

describe("Heartbeat", () => {
  it("beats immediately on start — the roster has to be current the moment MoT can use it", () => {
    const h = harness();
    h.heartbeat.start();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({
      v: 1,
      bridge: bridgeInfo([{ id: "p1", name: "Robin", active: true, gm: false }]),
      events: [],
    });
  });

  it("carries no events — it is a signal, not a record", () => {
    const h = harness();
    h.heartbeat.start();
    expect(h.sent[0]?.events).toEqual([]);
  });

  it("keeps beating on the interval", async () => {
    const h = harness();
    h.heartbeat.start();
    // Let the first POST settle. The fake clock fires timers synchronously, so
    // without this the interval lands while the in-flight guard is still up —
    // which cannot happen against a real 30s timer, but would make the
    // assertion below a test of the clock rather than of the heartbeat.
    await flushMicrotasks();

    // One interval at a time, with the POST allowed to settle in between —
    // which is what half a minute of wall clock does for free.
    await h.clock.advanceAsync(HEARTBEAT_INTERVAL_MS);
    expect(h.sent).toHaveLength(2);

    for (let i = 0; i < 3; i += 1) await h.clock.advanceAsync(HEARTBEAT_INTERVAL_MS);
    expect(h.sent).toHaveLength(5);
  });

  it("re-reads the roster every beat", async () => {
    const h = harness();
    h.heartbeat.start();
    await flushMicrotasks();
    h.setRoster([{ id: "p2", name: "Sam", active: true, gm: false }]);

    await h.clock.advanceAsync(HEARTBEAT_INTERVAL_MS);
    expect(h.sent[1]?.bridge.users).toEqual([{ id: "p2", name: "Sam", active: true, gm: false }]);
  });

  it("stops when the command socket goes away, and schedules nothing further", async () => {
    const h = harness();
    h.heartbeat.start();
    h.heartbeat.stop();

    await h.clock.advanceAsync(HEARTBEAT_INTERVAL_MS * 5);
    expect(h.sent).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
    expect(h.heartbeat.active).toBe(false);
  });

  it("does not accumulate timers when start is called on an already-running heartbeat", async () => {
    const h = harness();
    h.heartbeat.start();
    h.heartbeat.start();
    h.heartbeat.start();

    // The extra starts beat (a reconnect is a good moment to say hello) but must
    // not leave three interval chains behind them.
    expect(h.sent).toHaveLength(1); // the two extras were coalesced: one in flight
    await flushMicrotasks();
    await h.clock.advanceAsync(HEARTBEAT_INTERVAL_MS);
    expect(h.sent).toHaveLength(2);
  });

  it("sends at most one beat at a time — an older roster is not worth queueing", async () => {
    const clock = new FakeClock();
    const pending = deferred<unknown>();
    const sent: EventBatch[] = [];

    const heartbeat = new Heartbeat({
      bridgeInfo: () => bridgeInfo(),
      post: (batch) => {
        sent.push(batch);
        return pending.promise;
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    heartbeat.start();
    heartbeat.beat();
    heartbeat.beat();
    expect(sent).toHaveLength(1);

    pending.resolve({ status: 202 });
    await flushMicrotasks();
    heartbeat.beat();
    expect(sent).toHaveLength(2);
  });

  it("swallows a failed beat and keeps beating", async () => {
    const h = harness({ fails: true });
    h.heartbeat.start();
    await flushMicrotasks();

    expect(h.log.lines.debug).toEqual(["[masteroftales-bridge] heartbeat failed"]);
    // No backoff, no counting, no chip: the outbox is watching the same endpoint
    // and owns telling the customer. A heartbeat that also shouted would double
    // every message for one fault.
    await h.clock.advanceAsync(HEARTBEAT_INTERVAL_MS);
    expect(h.sent).toHaveLength(2);
  });

  it("survives a bridgeInfo that throws, which is a client mid-teardown", () => {
    const clock = new FakeClock();
    const log = createLog();
    const heartbeat = new Heartbeat({
      bridgeInfo: () => {
        throw new Error("game is gone");
      },
      post: async () => ({ status: 202 }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log,
    });

    expect(() => heartbeat.start()).not.toThrow();
    expect(log.lines.debug).toEqual(["[masteroftales-bridge] could not build a heartbeat"]);
  });
});
