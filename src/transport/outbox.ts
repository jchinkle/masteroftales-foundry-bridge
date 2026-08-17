import type { SessionState } from "../protocol/session.js";
import { carriesSession, parseSessionState } from "../protocol/session.js";
import type { ApiErrorBody, BatchResponse, BridgeInfo, Envelope, EventBatch } from "../protocol/types.js";
import { NO_LIVE_SESSION } from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import { backoffDelay, parseRetryAfter } from "./backoff.js";

/**
 * The Foundry -> MoT door. A record, not a signal: it must not be lost, it must
 * survive a reconnect, and a duplicate is a lie in somebody's session log.
 *
 * Hence HTTP rather than the socket — a status code is an ack, and retries are
 * free because every envelope carries a sender-computed idempotency key.
 *
 * The whole class is driven by injected `post`/`now`/timer/`random`, so every
 * branch below (the 429, the 5xx retention, the bounded drop) is a unit test
 * rather than a thing you hope works at 9pm on somebody else's server.
 */

/** 250ms or 20 events, whichever comes first. Small enough that a roll feels instant. */
export const FLUSH_INTERVAL_MS = 250;
export const FLUSH_AT_EVENTS = 20;

/** The server's own per-batch cap. Sending more is a guaranteed `rejected`. */
export const MAX_BATCH = 100;

/**
 * Bounded, because a module that grows an unbounded array in a browser tab left
 * open for nine hours is a memory leak with extra steps. Past this we drop the
 * *oldest* — the newest events are the ones still worth having — and count it.
 */
export const MAX_QUEUE = 500;

export interface PostResult {
  status: number;
  body?: unknown;
  /** Raw `Retry-After` header, if the response carried one. */
  retryAfter?: string | null;
}

export type TimerHandle = unknown;

export interface OutboxDeps {
  /** Resolves with the response. Rejects only for network-level failure. */
  post(batch: EventBatch): Promise<PostResult>;
  /** Re-read per batch: the system version can change under a running world. */
  bridgeInfo(): BridgeInfo;
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  random?(): number;
  log?: OutboxLog;
  /** Called when the server says 401. The transport stops; the UI turns red. */
  onTokenRejected?(): void;
  /**
   * Every 202 carries the project's current session state, so the POST path is a
   * session-state signal in its own right — a module whose socket is wedged still
   * learns that a session started. Called only when the body actually carried a
   * `session` key, so a bodyless 202 cannot blank the chip.
   */
  onSession?(session: SessionState): void;
  onStateChange?(state: OutboxState): void;
}

export interface OutboxLog {
  debug?(message: string, ...rest: unknown[]): void;
  warn?(message: string, ...rest: unknown[]): void;
  error?(message: string, ...rest: unknown[]): void;
}

export interface OutboxState {
  queued: number;
  dropped: number;
  inFlight: boolean;
  consecutiveFailures: number;
  tokenRejected: boolean;
  stopped: boolean;
  /** Counts of each receipt status seen since start; the status tooltip reads this. */
  receipts: Record<string, number>;
}

export class Outbox {
  private readonly deps: OutboxDeps;
  private readonly random: () => number;

  private queue: Envelope[] = [];
  /** The batch currently being POSTed. Held here, not in `queue` — see `flush()`. */
  private inFlightBatch: Envelope[] = [];
  private timer: TimerHandle | null = null;
  private inFlight = false;
  private stopped = false;
  private tokenRejected = false;
  private consecutiveFailures = 0;
  private droppedCount = 0;
  private receiptCounts: Record<string, number> = {};

  constructor(deps: OutboxDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
  }

  get state(): OutboxState {
    return {
      // Outstanding, not merely waiting: an in-flight batch is still unconfirmed
      // and the chip should say so.
      queued: this.queue.length + this.inFlightBatch.length,
      dropped: this.droppedCount,
      inFlight: this.inFlight,
      consecutiveFailures: this.consecutiveFailures,
      tokenRejected: this.tokenRejected,
      stopped: this.stopped,
      receipts: { ...this.receiptCounts },
    };
  }

  /** Total events discarded because the queue was full. Surfaced in the status tooltip. */
  get dropped(): number {
    return this.droppedCount;
  }

  enqueue(event: Envelope): void {
    if (this.stopped) return;

    this.queue.push(event);
    this.enforceCap();
    this.notify();

    // The size trigger only fires when it can actually send. If a batch is
    // already in flight, fall through to the timer — otherwise a busy combat
    // round could leave the tail of the queue with nothing scheduled to drain it.
    if (this.queue.length >= FLUSH_AT_EVENTS && !this.inFlight) {
      void this.flush();
    } else {
      this.scheduleFlush(FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Sends one batch if there is anything to send and nothing already in flight.
   * Safe to call at any time; it is its own no-op when it should be.
   */
  async flush(): Promise<void> {
    if (this.stopped || this.inFlight || this.queue.length === 0) return;

    this.clearTimer();
    this.inFlight = true;

    // Taken *out* of the queue, not copied from it. If it stayed, an overflow
    // drop during the request would shift the queue under us and the
    // splice-on-success would then discard the wrong events — a silent, rare,
    // unreproducible loss of exactly the lines a GM would notice missing.
    this.inFlightBatch = this.queue.splice(0, MAX_BATCH);
    this.notify();

    const batch: EventBatch = {
      v: PROTOCOL_VERSION,
      bridge: this.deps.bridgeInfo(),
      events: this.inFlightBatch,
    };

    try {
      const result = await this.deps.post(batch);
      this.handleResult(result);
    } catch (error) {
      // Network-level failure: Foundry is open, MoT is not reachable. Offline is
      // a normal state, so this is a debug line and a backoff, not an error dialog.
      this.deps.log?.debug?.("[masteroftales-bridge] batch failed to send", error);
      this.retainAndBackOff(null);
    } finally {
      this.inFlight = false;
      this.notify();
    }
  }

  /** Stops sending. Called on 401 and at world teardown. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.notify();
  }

  /** Clears the rejection flag and resumes — the settings pane calls this after a token change. */
  resume(): void {
    this.stopped = false;
    this.tokenRejected = false;
    this.consecutiveFailures = 0;
    this.notify();
    if (this.queue.length > 0) this.scheduleFlush(FLUSH_INTERVAL_MS);
  }

  // ------------------------------------------------------------------ internals

  private handleResult(result: PostResult): void {
    const { status } = result;
    const sentCount = this.inFlightBatch.length;

    if (status >= 200 && status < 300) {
      this.inFlightBatch = [];
      this.consecutiveFailures = 0;
      this.processReceipts(result.body);
      // More waiting? Go again promptly rather than after the full interval.
      if (this.queue.length > 0) this.scheduleFlush(0);
      return;
    }

    if (status === 401 || status === 403) {
      // The token is wrong or revoked. Retrying cannot fix that, and hammering a
      // stranger's server with a bad credential is exactly what the per-IP
      // failed-auth counter on the other end is there to punish.
      //
      // The batch goes back on the queue: the customer pastes a fresh key, calls
      // `resume()`, and the night's events go through rather than evaporating.
      this.tokenRejected = true;
      this.returnInFlightToQueue();
      this.deps.log?.error?.(
        "[masteroftales-bridge] server rejected the bridge token; stopping. Check the API token in module settings. " +
          this.errorDetail(result.body),
      );
      this.stop();
      this.deps.onTokenRejected?.();
      return;
    }

    if (status === 429) {
      const retryMs = parseRetryAfter(result.retryAfter, this.deps.now());
      this.deps.log?.warn?.(`[masteroftales-bridge] rate limited; retrying in ${retryMs ?? "backoff"}ms`);
      this.retainAndBackOff(retryMs);
      return;
    }

    if (status >= 500) {
      this.retainAndBackOff(null);
      return;
    }

    // Any other 4xx is a **batch**-level failure — the only kind this endpoint
    // answers with a non-2xx. In practice a 422 carrying
    // `unsupported_protocol_version`, `invalid_batch` or `batch_too_large`.
    // Retrying an identical body would loop forever, so the batch is dropped —
    // loudly, with the server's code, because silence would look like working.
    this.inFlightBatch = [];
    this.droppedCount += sentCount;
    this.deps.log?.error?.(
      `[masteroftales-bridge] server refused a batch with HTTP ${status}; discarded ${sentCount} event(s). ` +
        this.errorDetail(result.body),
    );
    if (this.queue.length > 0) this.scheduleFlush(0);
  }

  /**
   * The 202 body: four parallel receipt arrays plus the current session state.
   *
   * The log volume here is chosen deliberately, because this runs on every batch
   * all night:
   *
   *   - `accepted` and `duplicate` are both **acks**. A duplicate is what a
   *     reconnect that replayed its outbox is *supposed* to produce, so it is
   *     counted and otherwise silent. Warning on it would mean a healthy
   *     reconnect looked like a fault.
   *   - `dropped` with `no_live_session` is the single most common outcome this
   *     module will ever see — Foundry open on a Tuesday, nobody playing. Silent.
   *   - `dropped` with any other code (today: `unknown_type`) is a note, not a
   *     fault: it means this module is ahead of that server.
   *   - `rejected` is the module's bug list and is the only one that gets an
   *     error line, with the code and the server's sentence.
   */
  private processReceipts(body: unknown): void {
    if (!body || typeof body !== "object") return;
    const response = body as BatchResponse;

    this.countReceipts("accepted", response.accepted);
    this.countReceipts("duplicate", response.duplicate);

    const dropped = Array.isArray(response.dropped) ? response.dropped : [];
    this.countReceipts("dropped", dropped);
    for (const receipt of dropped) {
      if (receipt?.code === NO_LIVE_SESSION) continue;
      this.deps.log?.warn?.(
        `[masteroftales-bridge] event dropped: ${receipt?.id ?? "(no id)"} (${receipt?.code ?? "no code"})`,
      );
    }

    const rejected = Array.isArray(response.rejected) ? response.rejected : [];
    this.countReceipts("rejected", rejected);
    for (const receipt of rejected) {
      this.deps.log?.error?.(
        `[masteroftales-bridge] event rejected: ${receipt?.id ?? "(no id)"} (${receipt?.code ?? "no code"}) ${receipt?.message ?? ""}`.trim(),
      );
    }

    // Absent is not the same as null: a 202 with no body at all must leave the
    // chip alone, while `"session": null` genuinely means nothing is live.
    if (carriesSession(response)) this.deps.onSession?.(parseSessionState(response.session));
  }

  private countReceipts(status: string, receipts: unknown): void {
    if (!Array.isArray(receipts) || receipts.length === 0) return;
    this.receiptCounts[status] = (this.receiptCounts[status] ?? 0) + receipts.length;
  }

  /** Pulls the server's `{error: {code, message}}` out of any non-2xx body. */
  private errorDetail(body: unknown): string {
    const error = (body as ApiErrorBody | null | undefined)?.error;
    if (!error) return "";
    return `${error.code ?? "no code"}: ${error.message ?? ""}`.trim();
  }

  /** Puts the batch back at the head of the queue and schedules another attempt. */
  private retainAndBackOff(explicitDelayMs: number | null): void {
    this.returnInFlightToQueue();
    this.consecutiveFailures += 1;
    const delay = explicitDelayMs ?? backoffDelay(this.consecutiveFailures - 1, this.random);
    this.scheduleFlush(delay);
  }

  /** Order matters: a retried batch is older than everything still waiting. */
  private returnInFlightToQueue(): void {
    if (this.inFlightBatch.length === 0) return;
    this.queue.unshift(...this.inFlightBatch);
    this.inFlightBatch = [];
    this.enforceCap();
  }

  /**
   * The bound is on *outstanding* events, in flight included — otherwise a stuck
   * request would let the real ceiling drift to 600.
   */
  private enforceCap(): void {
    const outstanding = this.queue.length + this.inFlightBatch.length;
    if (outstanding <= MAX_QUEUE) return;

    const overflow = outstanding - MAX_QUEUE;
    this.queue.splice(0, overflow);
    this.droppedCount += overflow;
    this.deps.log?.warn?.(
      `[masteroftales-bridge] outbox full (${MAX_QUEUE}); dropped ${overflow} oldest event(s), ${this.droppedCount} total`,
    );
  }

  private scheduleFlush(ms: number): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private notify(): void {
    this.deps.onStateChange?.(this.state);
  }
}
