import type { Envelope } from "../protocol/types.js";
import { backoffDelay } from "./backoff.js";
import {
  isUnauthorizedDisconnect,
  parseCableFrame,
  shouldStopReconnecting,
  SUBSCRIBE_COMMAND,
} from "./cableFrames.js";
import { redactCableUrl } from "./urls.js";

/**
 * The MoT -> Foundry door: perishable commands, no acks, one socket.
 *
 * The module dials **out** — MoT never connects to a Foundry, and cannot. That
 * one constraint is why this feature works on somebody's Forge instance behind
 * CGNAT with nothing configured, and it is the reason this file exists at all.
 */

export type SocketStatus =
  /** Not started, or deliberately stopped. */
  | "idle"
  /** Socket opening, or open but no cable `welcome` yet. */
  | "connecting"
  /** Cable welcome received; commands will arrive. */
  | "connected"
  /** Lost the connection, retry scheduled. Offline is a normal state. */
  | "offline"
  /** The server refused the token. No further attempts will be made. */
  | "rejected";

/** The slice of the WebSocket API this module uses, so tests can supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface SocketDeps {
  /** Returns the current cable URL, or null when settings are incomplete. */
  url(): string | null;
  createSocket(url: string): SocketLike;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  random?(): number;
  onEnvelope(envelope: Envelope): void;
  onStatus?(status: SocketStatus, detail: SocketDetail): void;
  log?: {
    debug?(message: string, ...rest: unknown[]): void;
    warn?(message: string, ...rest: unknown[]): void;
    error?(message: string, ...rest: unknown[]): void;
  };
}

export interface SocketDetail {
  attempts: number;
  lastPingAt: number | null;
  subscriptionConfirmed: boolean;
  reason?: string | null;
}

/**
 * The server pings every ~3s. Missing four of them means the connection is dead
 * in a way `onclose` has not noticed — the classic silently-dropped NAT mapping,
 * which a laptop closing its lid produces reliably.
 */
export const STALE_AFTER_MS = 15_000;

export class BridgeSocket {
  private readonly deps: SocketDeps;
  private readonly random: () => number;

  private socket: SocketLike | null = null;
  private reconnectTimer: unknown = null;
  private staleTimer: unknown = null;

  private status: SocketStatus = "idle";
  private attempts = 0;
  private lastPingAt: number | null = null;
  private subscriptionConfirmed = false;
  private stopped = true;
  private lastReason: string | null = null;

  constructor(deps: SocketDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
  }

  get currentStatus(): SocketStatus {
    return this.status;
  }

  get detail(): SocketDetail {
    return {
      attempts: this.attempts,
      lastPingAt: this.lastPingAt,
      subscriptionConfirmed: this.subscriptionConfirmed,
      reason: this.lastReason,
    };
  }

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  /** Closes and stays closed. Called at teardown and on a rejected token. */
  stop(reason: string | null = null): void {
    this.stopped = true;
    this.lastReason = reason;
    this.clearReconnectTimer();
    this.clearStaleTimer();
    this.teardownSocket();
    this.setStatus(reason === "rejected" ? "rejected" : "idle");
  }

  /** Drop the current connection and dial again now — used after a settings change. */
  restart(): void {
    this.clearReconnectTimer();
    this.clearStaleTimer();
    this.teardownSocket();
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  // ------------------------------------------------------------------ internals

  private connect(): void {
    if (this.stopped) return;

    const url = this.deps.url();
    if (!url) {
      // No server or no token yet. Not an error — the customer has not finished
      // the setup, and retrying an unconfigured module forever helps nobody.
      this.setStatus("idle");
      return;
    }

    this.subscriptionConfirmed = false;
    this.setStatus("connecting");

    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(url);
    } catch (error) {
      this.deps.log?.debug?.(`[masteroftales-bridge] could not open ${redactCableUrl(url)}`, error);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      // A 101 upgrade proves nothing about the token — see cableFrames.ts. Stay
      // "connecting" until the cable `welcome` arrives.
      this.deps.log?.debug?.(`[masteroftales-bridge] socket open: ${redactCableUrl(url)}`);
      this.resetStaleTimer();
    };

    socket.onmessage = (event) => {
      this.resetStaleTimer();
      this.handleFrame(event?.data);
    };

    socket.onerror = () => {
      // Browsers deliberately give no detail here (it would be a cross-origin
      // information leak). `onclose` follows and does the real work.
      this.deps.log?.debug?.("[masteroftales-bridge] socket error");
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // A stale handler from a replaced socket.
      this.socket = null;
      this.clearStaleTimer();
      if (this.stopped) return;
      this.setStatus("offline");
      this.scheduleReconnect();
    };
  }

  private handleFrame(data: unknown): void {
    const frame = parseCableFrame(data);

    switch (frame.kind) {
      case "welcome":
        // The cable handshake, not the channel greeting. Subscribe now.
        this.send(SUBSCRIBE_COMMAND);
        // Backoff resets **here**, on a real welcome — not on `onopen`. A server
        // that accepts TCP and immediately dies would otherwise reset the backoff
        // every cycle and produce a hot reconnect loop that looks like a DoS.
        this.attempts = 0;
        this.lastReason = null;
        this.setStatus("connected");
        return;

      case "ping":
        this.lastPingAt = frame.at !== null ? frame.at * 1000 : this.deps.now();
        return;

      case "confirm_subscription":
        // Recorded for diagnostics only. Nothing waits on it — see the `message`
        // case below for why that matters.
        this.subscriptionConfirmed = true;
        return;

      case "reject_subscription":
        // `BridgeChannel#subscribed` calls `reject` when the connection carries
        // no project — i.e. the token resolved to nothing. Same user-visible
        // meaning as an unauthorized disconnect.
        this.deps.log?.error?.("[masteroftales-bridge] server rejected the bridge subscription");
        this.stop("rejected");
        return;

      case "disconnect":
        if (isUnauthorizedDisconnect(frame)) {
          this.deps.log?.error?.(
            `[masteroftales-bridge] bridge token rejected by the server (${frame.reason}); not reconnecting`,
          );
          this.stop("rejected");
          return;
        }
        if (shouldStopReconnecting(frame)) {
          this.deps.log?.warn?.(`[masteroftales-bridge] server closed the connection (${frame.reason})`);
          this.stop(frame.reason);
          return;
        }
        // `server_restart` and friends: let the close handler back us off.
        this.deps.log?.debug?.(`[masteroftales-bridge] server disconnect (${frame.reason}), will retry`);
        return;

      case "message":
        // **Deliberately not gated on `subscriptionConfirmed`.** The Rails spike
        // established that `bridge.welcome` — the channel's own greeting, carrying
        // the current session state — arrives BEFORE `confirm_subscription`,
        // because `ActionCable::Channel#subscribed` transmits during the
        // subscription callback and the confirmation is queued after it. Waiting
        // for confirmation would drop the single most useful message on every
        // connect, intermittently and only in production.
        this.deps.onEnvelope(frame.envelope);
        return;

      case "unknown":
      default:
        this.deps.log?.debug?.("[masteroftales-bridge] ignoring unrecognised cable frame", frame);
    }
  }

  private send(data: string): void {
    try {
      this.socket?.send(data);
    } catch (error) {
      this.deps.log?.debug?.("[masteroftales-bridge] send failed", error);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;

    const delay = backoffDelay(this.attempts, this.random);
    this.attempts += 1;
    this.setStatus("offline");

    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private resetStaleTimer(): void {
    this.clearStaleTimer();
    this.staleTimer = this.deps.setTimer(() => {
      this.staleTimer = null;
      this.deps.log?.debug?.("[masteroftales-bridge] no cable traffic; recycling the socket");
      // Close it ourselves; `onclose` runs the normal offline + backoff path.
      this.teardownSocket();
      if (!this.stopped) {
        this.setStatus("offline");
        this.scheduleReconnect();
      }
    }, STALE_AFTER_MS);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer === null) return;
    this.deps.clearTimer(this.staleTimer);
    this.staleTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.deps.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardownSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closing. Nothing to do and nothing worth logging.
    }
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatus?.(status, this.detail);
  }
}
