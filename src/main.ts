import { isActiveGM, isNonActiveGM } from "./activation.js";
import type { AdapterContext } from "./adapters/index.js";
import { selectAdapter } from "./adapters/index.js";
import { registerActorCapture } from "./capture/actors.js";
import type { CaptureContext } from "./capture/chat.js";
import { registerChatCapture } from "./capture/chat.js";
import { registerCombatCapture } from "./capture/combat.js";
import type { DocumentContext } from "./capture/documents.js";
import { registerItemCapture } from "./capture/items.js";
import { PriorValues } from "./capture/priorValues.js";
import { registerSceneCapture } from "./capture/scenes.js";
import type { SessionSummary } from "./commands/index.js";
import { createDispatcher, NO_SESSION } from "./commands/index.js";
import type { BridgeInfo, Envelope, EventBatch } from "./protocol/types.js";
import { MODULE_ID, MODULE_VERSION } from "./protocol/version.js";
import type { BridgeSettings } from "./settings.js";
import {
  EVENTS_PATH,
  isConfigured,
  readSettings,
  registerSettings,
  testConnection,
} from "./settings.js";
import type { PostResult } from "./transport/outbox.js";
import { Outbox } from "./transport/outbox.js";
import type { SocketLike } from "./transport/socket.js";
import { BridgeSocket } from "./transport/socket.js";
import { apiUrl, cableUrl, checkServerUrl } from "./transport/urls.js";
import { StatusChip } from "./ui/status.js";

/**
 * Module entry point and the only file that touches Foundry globals directly.
 *
 * Everything with a decision in it — the batching, the backoff, the cable state
 * machine, the roll serialisation, the loop guard — lives in a pure module with
 * a test. This file is the wiring, and it is deliberately boring.
 */

const LOG_PREFIX = "[Master of Tales]";

const log = {
  debug: (message: string, ...rest: unknown[]) => console.debug(`${LOG_PREFIX} ${message}`, ...rest),
  warn: (message: string, ...rest: unknown[]) => console.warn(`${LOG_PREFIX} ${message}`, ...rest),
  error: (message: string, ...rest: unknown[]) => console.error(`${LOG_PREFIX} ${message}`, ...rest),
};

function notify(level: "info" | "warn" | "error", message: string): void {
  // `typeof` rather than `ui?.` — `ui` is a global binding, so an optional chain
  // on it still throws a ReferenceError if Foundry has not defined it yet. This
  // is the path that reports failures; it must not be able to fail itself.
  const notifications = typeof ui === "undefined" ? null : ui?.notifications;
  if (notifications) notifications[level](`${LOG_PREFIX} ${message}`);
  else log[level === "info" ? "debug" : level](message);
}

function moduleVersion(): string {
  return game.modules?.get(MODULE_ID)?.version ?? MODULE_VERSION;
}

function bridgeInfo(): BridgeInfo {
  return {
    world: game.world?.id ?? "unknown",
    foundry: game.version ?? "unknown",
    system: {
      id: game.system?.id ?? "unknown",
      version: game.system?.version ?? "unknown",
    },
    module: moduleVersion(),
  };
}

function adapterContext(): AdapterContext {
  return {
    systemId: game.system?.id ?? "unknown",
    systemVersion: game.system?.version ?? "unknown",
  };
}

/**
 * Holds the two transports, the status chip, and the small amount of state that
 * connects them. One instance, created at `ready` on the active GM's client.
 */
class Bridge {
  private readonly chip: StatusChip;
  private readonly socket: BridgeSocket;
  private readonly outbox: Outbox;
  private readonly dispatch: (envelope: Envelope) => void;

  /**
   * The hit points and coin this client last saw, because Foundry's update
   * hooks report the new value and the diff but never the old one. Bounded —
   * see capture/priorValues.ts.
   */
  private readonly prior = new PriorValues();

  /**
   * Backs `DocumentContext.sequence`: the Date-free discriminator for documents
   * that arrive with no `_stats.modifiedTime`. A wall clock here would mint a
   * fresh idempotency key on every replay of the outbox, which is the one thing
   * idempotency keys exist to prevent.
   */
  private sequence = 0;

  private settings: BridgeSettings;
  private session: SessionSummary = { ...NO_SESSION };
  private tokenRejected = false;

  constructor() {
    this.settings = readSettings();

    this.chip = new StatusChip({ onClick: () => void this.runTest() });

    this.dispatch = createDispatcher({
      log,
      onSession: (summary) => {
        this.session = summary;
        this.refreshChip();
      },
    });

    this.socket = new BridgeSocket({
      url: () => {
        const check = checkServerUrl(this.settings.serverUrl);
        if (!check.ok || this.settings.apiToken === "" || !this.settings.enabled) return null;
        return cableUrl(check.normalized ?? this.settings.serverUrl, this.settings.apiToken);
      },
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimer: (handle) => globalThis.clearTimeout(handle as number),
      now: () => Date.now(),
      onEnvelope: (envelope) => this.dispatch(envelope),
      onStatus: (status) => {
        if (status === "rejected") this.tokenRejected = true;
        // Off the socket we do not *know* the session state — so we forget it
        // rather than keeping a stale claim (a `live: false` sitting next to a
        // `status: "live"` would be a lie about a thing we simply cannot see).
        // A reconnect re-announces it via `bridge.welcome`, and until then the
        // chip reads grey anyway. The project name survives; it does not change.
        if (status !== "connected") {
          this.session = { ...NO_SESSION, projectName: this.session.projectName };
        }
        this.refreshChip();
      },
      log,
    });

    this.outbox = new Outbox({
      post: (batch) => this.postBatch(batch),
      bridgeInfo,
      now: () => Date.now(),
      setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimer: (handle) => globalThis.clearTimeout(handle as number),
      onTokenRejected: () => {
        this.tokenRejected = true;
        this.socket.stop("rejected");
        notify("error", "Bridge token rejected. Check the API token in module settings.");
        this.refreshChip();
      },
      // Every 202 reports the project's current session, so the chip stays
      // truthful even when the command socket is the half that is wedged. The
      // project name is preserved: only `bridge.welcome` ever carries it.
      onSession: (session) => {
        this.session = { ...session, projectName: this.session.projectName };
        this.refreshChip();
      },
      onStateChange: () => this.refreshChip(),
      log,
    });
  }

  start(): void {
    // The hook ids are discarded: nothing unregisters them, because the only way
    // out of a Foundry world is a page reload, which takes the hooks with it.
    //
    // Every family shares one gate and one emit. There are deliberately **no
    // per-family capture toggles in module settings** — the toggles live in
    // MoT's own settings panel, the server drops what a project switched off
    // with a `capture_disabled` receipt, and the outbox treats that receipt as
    // silently normal. Two switches for one behaviour is a support conversation
    // that opens with "but I turned it off", and only the server can change its
    // mind about a family without asking a customer to update a module.
    const isActive = (): boolean => isActiveGM(game) && this.settings.enabled && !this.tokenRejected;
    const emit = (envelope: Envelope): void => this.outbox.enqueue(envelope);

    registerChatCapture({
      hooks: Hooks,
      isActive,
      context: (): CaptureContext => ({
        resolveUser: (userId) => game.users?.get(userId) ?? null,
        adapter: selectAdapter(game.system?.id),
        adapterContext: adapterContext(),
        now: () => new Date(),
      }),
      emit,
      log,
    });

    const documents = {
      hooks: Hooks,
      isActive,
      context: (): DocumentContext => ({
        // Re-selected per event rather than cached: a world can have its system
        // updated under a running client, and the adapter is cheap to pick.
        adapter: selectAdapter(game.system?.id),
        adapterContext: adapterContext(),
        prior: this.prior,
        sequence: () => (this.sequence += 1),
        now: () => new Date(),
      }),
      emit,
      log,
    };

    registerCombatCapture(documents);
    registerActorCapture(documents);
    registerItemCapture(documents);
    registerSceneCapture(documents);

    this.chip.render();
    this.reconfigure();
  }

  /** Re-read settings and reconnect. Called on every settings change. */
  reconfigure(): void {
    this.settings = readSettings();
    this.tokenRejected = false;
    this.outbox.resume();

    if (!isConfigured(this.settings)) {
      this.socket.stop();
      this.session = { ...NO_SESSION };
      this.refreshChip();
      return;
    }

    this.socket.restart();
    this.refreshChip();
  }

  async runTest(): Promise<void> {
    const outcome = await testConnection(readSettings());
    notify(outcome.ok ? "info" : "error", outcome.message);
  }

  private async postBatch(batch: EventBatch): Promise<PostResult> {
    const check = checkServerUrl(this.settings.serverUrl);
    if (!check.ok) throw new Error(check.reason ?? "Invalid server URL");

    const response = await fetch(apiUrl(check.normalized ?? this.settings.serverUrl, EVENTS_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(batch),
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 202 with an empty body is legal; so is a 502 of HTML from a proxy.
    }

    return { status: response.status, body, retryAfter: response.headers.get("Retry-After") };
  }

  private refreshChip(): void {
    const state = this.outbox.state;
    this.chip.update({
      socket: this.socket.currentStatus,
      session: this.session,
      tokenRejected: this.tokenRejected || state.tokenRejected,
      queued: state.queued,
      dropped: state.dropped,
    });
  }
}

let bridge: Bridge | null = null;

Hooks.once("init", () => {
  registerSettings({
    onChange: () => bridge?.reconfigure(),
    notify,
  });
});

Hooks.once("ready", () => {
  if (!isActiveGM(game)) {
    // The idle path, and by far the most common one: every player's client, plus
    // any second GM. Says so once, at debug volume, and then does nothing at all.
    const why = isNonActiveGM(game)
      ? "another GM is the active GM on this world"
      : "this client is not the active GM";
    console.info(`${LOG_PREFIX} bridge idle — ${why}.`);
    return;
  }

  bridge = new Bridge();
  bridge.start();
  console.info(`${LOG_PREFIX} bridge active (module ${moduleVersion()}, Foundry ${game.version ?? "?"}).`);
});

/**
 * A "Test connection" button, injected into the module's own section of the
 * Configure Settings sheet.
 *
 * Injected via the render hook rather than registered as a settings *menu*
 * because `game.settings.registerMenu` wants a FormApplication/ApplicationV2
 * subclass, and those base classes are exactly the part of the API that moved
 * between v13 and v14. A button appended to a DOM node we found by id is dull
 * and works in both.
 *
 * The `html` argument is jQuery on v13 and a plain HTMLElement on v14, so both
 * are unwrapped here.
 */
Hooks.on("renderSettingsConfig", (_app: unknown, html: unknown) => {
  const root = unwrapElement(html);
  if (!root) return;

  const tokenInput = root.querySelector<HTMLElement>(`[name="${MODULE_ID}.apiToken"]`);
  const anchor = tokenInput?.closest<HTMLElement>(".form-group");
  if (!anchor || anchor.querySelector(`.${MODULE_ID}-test`)) return;

  const button = anchor.ownerDocument.createElement("button");
  button.type = "button";
  button.className = `${MODULE_ID}-test`;
  button.textContent = "Test connection";
  button.style.marginTop = "4px";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      // Read straight from the form so the customer can test what they just
      // typed without saving first — which is the only order anyone tries.
      const outcome = await testConnection(readFormSettings(root));
      notify(outcome.ok ? "info" : "error", outcome.message);
    } finally {
      button.disabled = false;
    }
  });

  anchor.appendChild(button);
});

function unwrapElement(html: unknown): HTMLElement | null {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  const jquery = html as { 0?: unknown };
  return jquery[0] instanceof HTMLElement ? jquery[0] : null;
}

function readFormSettings(root: HTMLElement): BridgeSettings {
  const saved = readSettings();
  const field = (key: string): string | null => {
    const input = root.querySelector<HTMLInputElement>(`[name="${MODULE_ID}.${key}"]`);
    return input ? input.value : null;
  };
  return {
    serverUrl: field("serverUrl") ?? saved.serverUrl,
    apiToken: field("apiToken") ?? saved.apiToken,
    enabled: saved.enabled,
  };
}
