import type { BridgeInfo, EventBatch } from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";

/**
 * A periodic "here is who is at the table" ping.
 *
 * The batch POST already carries `BridgeInfo` — world, versions, and now the
 * roster — on every request, which is what lets MoT say "last seen 3 minutes
 * ago, dnd5e 5.0.2". That works beautifully while somebody is rolling dice and
 * not at all otherwise, and "otherwise" is exactly when this feature is used: a
 * GM opening the MoT panel to push a map to their players is, by definition, at
 * a moment when nothing is happening in Foundry. Without a heartbeat the panel's
 * player pick-list would be however stale the last roll of the night left it.
 *
 * So this sends a batch with **no events in it**, on an interval and immediately
 * on connect. Which makes the two doors read as:
 *
 *   | outbox.ts   | a **record**. Must not be lost, retried, idempotent. |
 *   | heartbeat.ts| a **signal**. Perishable — a missed one is replaced by the next. |
 *
 * That difference is why this is not a method on `Outbox`. A heartbeat that
 * joined the outbox queue would be retried, backed off, counted against the
 * queue cap and — worst — replayed after a reconnect, announcing a roster that
 * was true four minutes ago as though it were now.
 *
 * Every dependency is injected, so the interval, the connect-triggered beat and
 * the swallowed failure are unit tests rather than something you time with a
 * stopwatch against a real server.
 */

/**
 * How often a connected, idle client says hello.
 *
 * 30s is chosen against the thing it is for: a GM alt-tabs to MoT, picks a
 * player, sends a map. Half a minute of staleness in a pick-list is invisible;
 * the cost is two requests a minute from an idle tab, which is less traffic than
 * the cable's own ping already generates.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatDeps {
  /** Re-read per beat: the roster is the entire point, and it changes. */
  bridgeInfo(): BridgeInfo;
  /** Sends one batch. Resolves with the status; rejects on network failure. */
  post(batch: EventBatch): Promise<unknown>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  intervalMs?: number;
  log?: { debug?(message: string, ...rest: unknown[]): void };
}

export class Heartbeat {
  private readonly deps: HeartbeatDeps;
  private readonly intervalMs: number;

  private timer: unknown = null;
  private running = false;
  private inFlight = false;

  /** Beats sent, for the tests and for anyone reading the object in a console. */
  count = 0;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  get active(): boolean {
    return this.running;
  }

  /**
   * Starts beating, **and beats once immediately**. Called when the command
   * socket reaches `connected`, which is the moment MoT starts being able to
   * send an `image.show` and therefore the moment it needs a current roster.
   *
   * Idempotent: `restart()` on a settings change can land on an already-running
   * heartbeat, and that must not accumulate timers.
   */
  start(): void {
    if (this.running) {
      this.beat();
      return;
    }
    this.running = true;
    this.beat();
    this.schedule();
  }

  /** Stops beating. Called on disconnect, on a rejected token, and at teardown. */
  stop(): void {
    this.running = false;
    this.clear();
  }

  /**
   * Sends one beat now. Public because "the roster changed" is a legitimate
   * reason to speak up early — see the `userConnected` wiring in main.ts.
   */
  beat(): void {
    // One at a time. A beat is perishable, so a second one queued behind a slow
    // request would only ever deliver older news than the one already in flight.
    if (this.inFlight) return;

    let batch: EventBatch;
    try {
      batch = { v: PROTOCOL_VERSION, bridge: this.deps.bridgeInfo(), events: [] };
    } catch (error) {
      // A client mid-teardown, where `game` has gone. Not worth a retry.
      this.deps.log?.debug?.("[masteroftales-bridge] could not build a heartbeat", error);
      return;
    }

    this.inFlight = true;
    this.count += 1;

    void Promise.resolve(this.deps.post(batch))
      .catch((error: unknown) => {
        // Deliberately silent-at-debug and deliberately **not** backed off, not
        // counted, and not surfaced on the status chip. The outbox is already
        // watching this same endpoint and is the half that owns telling the
        // customer their token is wrong; a heartbeat that also shouted would
        // double every message for one fault.
        this.deps.log?.debug?.("[masteroftales-bridge] heartbeat failed", error);
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private schedule(): void {
    this.clear();
    if (!this.running) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (!this.running) return;
      this.beat();
      this.schedule();
    }, this.intervalMs);
  }

  private clear(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}
