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
import { createActorCreateHandler, resolveActorApi } from "./commands/actorCreate.js";
import type { PlaceableActor } from "./commands/actorPlace.js";
import { createActorPlaceHandler, resolveCanvas } from "./commands/actorPlace.js";
import { createChatPostHandler, resolveChatMessageClass } from "./commands/chat.js";
import { createDiceShowHandler, resolveDiceApi } from "./commands/dice.js";
import type { ActorLike, EncounterPlan, Placement, ResolvedEntry } from "./commands/encounters.js";
import {
  createActorsRequestHandler,
  createEncounterDeployHandler,
  deployInitiative,
  resolveCombatApi,
} from "./commands/encounters.js";
import type { HandoutResponse } from "./commands/handouts.js";
import { createHandoutShowHandler, resolveJournalApi } from "./commands/handouts.js";
import type { ImagePlan, ImageShowSocketEvent } from "./commands/images.js";
import {
  createImageShowHandler,
  createImageSocketListener,
  renderImagePopout,
  resolveImagePopout,
  SOCKET_CHANNEL,
} from "./commands/images.js";
import type { SessionSummary } from "./commands/index.js";
import { createDispatcher, NO_SESSION } from "./commands/index.js";
import { resolveFilePicker } from "./commands/tokenImages.js";
import type { ActorCatalogBody, ActorCreationBody } from "./protocol/actors.js";
import { resolveAssetBase } from "./protocol/actors.js";
import { readRoster } from "./protocol/roster.js";
import type { BridgeInfo, Envelope, EventBatch } from "./protocol/types.js";
import { MODULE_ID, MODULE_VERSION } from "./protocol/version.js";
import type { BridgeSettings } from "./settings.js";
import {
  ACTOR_CREATIONS_PATH,
  ACTORS_PATH,
  EVENTS_PATH,
  handoutPath,
  isConfigured,
  readSettings,
  registerSettings,
  testConnection,
} from "./settings.js";
import type { PostResult } from "./transport/outbox.js";
import { Outbox } from "./transport/outbox.js";
import { Heartbeat } from "./transport/heartbeat.js";
import type { SocketLike } from "./transport/socket.js";
import { BridgeSocket } from "./transport/socket.js";
import { apiUrl, cableUrl, checkServerUrl } from "./transport/urls.js";
import { EncounterTray } from "./ui/encounterTray.js";
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

/**
 * The identity block on every batch **and** every heartbeat — which makes it the
 * roster's delivery vehicle. Re-read per send rather than built once, because
 * `users` is the half of it that changes during a session: somebody logs in, a
 * player's laptop sleeps, a new user is created mid-game.
 */
function bridgeInfo(): BridgeInfo {
  return {
    world: game.world?.id ?? "unknown",
    foundry: game.version ?? "unknown",
    system: {
      id: game.system?.id ?? "unknown",
      version: game.system?.version ?? "unknown",
    },
    module: moduleVersion(),
    users: readRoster(game.users),
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
  private readonly heartbeat: Heartbeat;
  private readonly dispatch: (envelope: Envelope) => void;

  /**
   * Sends this world's actor catalog. Held as a field rather than left inside the
   * dispatcher because it is called from two places: on `actors.request`, and
   * once at activation — see `start()`.
   */
  private readonly announceActors: () => void;

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

    // Gated on `isConfigured` as well as the activation gate, unlike every other
    // command: this one is the only path that starts a request *we* chose to
    // make, so a world with no token pasted into it should stay silent rather
    // than posting a catalog at the default server to be told no.
    this.announceActors = createActorsRequestHandler({
      isActive: () => this.isActive() && isConfigured(this.settings),
      actors: () => game.actors,
      // Read per request rather than once at construction. The route prefix is
      // fixed for the life of a client, but `resolveAssetBase` also reads
      // `location`, and a module constructed before `ready` is exactly the case
      // that would cache a null and then report every portrait as absent.
      assetBase: () => resolveAssetBase(globalThis),
      bridgeInfo,
      post: (body) => this.postActors(body),
      log,
    });

    this.dispatch = createDispatcher({
      log,
      onSession: (summary) => {
        this.session = summary;
        this.refreshChip();
      },
      // Slice 4's two render commands. Both are gated on the *same* `isActive`
      // the captures use — read per command, never cached — because a command
      // rendered on every connected client would put one chat message on the
      // table per open browser. The Foundry classes are resolved per command
      // too: cheap, and tolerant of a client that is still booting.
      onDiceShow: createDiceShowHandler({
        isActive: () => this.isActive(),
        api: () => resolveDiceApi(globalThis),
        log,
      }),
      onChatPost: createChatPostHandler({
        isActive: () => this.isActive(),
        chatMessage: () => resolveChatMessageClass(globalThis),
        log,
      }),
      // The odd one out, and the comment above is only half true of it. It is
      // gated on the same `isActive` — one client must own the re-broadcast, or
      // a two-GM table opens every picture twice — but the *rendering* it causes
      // happens on every targeted client, through the listener registered at
      // `init` below. See commands/images.ts.
      onImageShow: createImageShowHandler({
        isActive: () => this.isActive(),
        emit: (event) => emitToClients(event),
        selfId: () => game.user?.id ?? null,
        renderLocal: (plan) => renderLocally(plan),
        log,
      }),
      // Back to one client for this one, and more firmly than the others: the
      // handout's content is fetched over the bridge token, which is
      // client-scoped and therefore exists in exactly one browser. Foundry
      // replicates the journal entry that comes out of it, and `Journal.show`
      // does the pushing — so there is no module-socket half here at all.
      onHandoutShow: createHandoutShowHandler({
        isActive: () => this.isActive(),
        fetch: (nodeId) => this.fetchHandout(nodeId),
        api: () => resolveJournalApi(globalThis),
        world: () => ({ entries: () => game.journal, folders: () => game.folders }),
        log,
      }),
      // Slice 6's pair. `encounter.deploy` is the least Foundry-touching command
      // in the whole table at the moment it arrives: it opens a window on this
      // one screen and then waits for a human. Everything that reaches the table
      // happens later, as the GM drags — see `openEncounterTray` below.
      onEncounterDeploy: createEncounterDeployHandler({
        isActive: () => this.isActive(),
        lookupActor: (actorId) => (game.actors?.get?.(actorId) as ActorLike | undefined) ?? null,
        openTray: (plan, entries) => openEncounterTray(plan, entries),
        log,
      }),
      // And its companion, which points the other way entirely: the answer is a
      // POST back to MoT rather than anything rendered here.
      onActorsRequest: () => this.announceActors(),
      // Slice 7, and the only command that points *both* ways: a creature
      // invented in MoT becomes a real Actor in this world — picture and all,
      // written into the world's own data directory so it outlives the bridge —
      // and the id Foundry gave it is POSTed home. Every Foundry class it needs
      // is resolved per command rather than cached, like the rest.
      onActorCreate: createActorCreateHandler({
        isActive: () => this.isActive(),
        files: () => resolveFilePicker(globalThis),
        actors: () => resolveActorApi(globalThis),
        // `game.documentTypes` is the world's own answer, which includes types a
        // module added; the system's table is the fallback for a client where the
        // former has not been built yet. See `defaultActorType`.
        actorTypes: () => game.documentTypes?.Actor ?? game.system?.documentTypes?.Actor,
        report: (body) => this.postActorCreation(body),
        // The one command with a failure the keeper must see rather than read in
        // a console: they are standing in MoT waiting for the creature.
        notify,
        log,
      }),
      // Slice 7's other half, and the quietest command in the table: one token
      // for a creature this world already has, onto the scene *this* screen is
      // showing, centred where the GM is looking. No combat, no initiative, and
      // no answer home — the token appearing is the answer. `canvas` is read per
      // command like every other global here, because the scene changes.
      onActorPlace: createActorPlaceHandler({
        isActive: () => this.isActive(),
        lookupActor: (actorId) => (game.actors?.get?.(actorId) as PlaceableActor | undefined) ?? null,
        canvas: () => resolveCanvas(globalThis),
        files: () => resolveFilePicker(globalThis),
        notify,
        log,
      }),
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
        // The roster matters exactly when MoT can send commands, so the
        // heartbeat lives and dies with the command socket rather than running
        // on its own clock. `start()` beats once immediately, which is what
        // makes the pick-list correct the moment the panel can use it.
        if (status === "connected") this.heartbeat.start();
        else this.heartbeat.stop();
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

    this.heartbeat = new Heartbeat({
      bridgeInfo,
      post: (batch) => this.postBatch(batch),
      setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimer: (handle) => globalThis.clearTimeout(handle as number),
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
    const isActive = (): boolean => this.isActive();
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

    // Somebody joining or leaving is the one roster change worth not waiting a
    // heartbeat for: a player alt-tabs into the game *because* the GM said they
    // were about to show them something. `beat()` is a no-op while one is
    // already in flight, so a whole party logging in at once is one extra POST.
    Hooks.on("userConnected", () => this.heartbeat.beat());

    this.chip.render();
    this.reconfigure();

    // The catalog, once, now that the world is up and this client is the one
    // answering for it. MoT can ask again whenever it likes (`actors.request`),
    // but a keeper who opens the encounter planner the moment their Foundry
    // finishes loading should find a pick-list already there.
    this.announceActors();
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

  /**
   * One handout's player-safe content. Same headers as `postBatch`, same token,
   * pointed at a GET — and the same contract as every other transport in this
   * file: it reports what happened rather than throwing, except where the
   * network itself refused, which `commands/handouts.ts` catches.
   */
  private async fetchHandout(nodeId: string): Promise<HandoutResponse> {
    const check = checkServerUrl(this.settings.serverUrl);
    if (!check.ok) throw new Error(check.reason ?? "Invalid server URL");

    const response = await fetch(apiUrl(check.normalized ?? this.settings.serverUrl, handoutPath(nodeId)), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`,
        Accept: "application/json",
      },
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A 404 from a server that predates this command is HTML from a proxy as
      // often as it is JSON. The status is the part that matters.
    }

    return { status: response.status, body };
  }

  /**
   * This world's actor catalog. The only POST in this file that is not a record
   * of the night, and the only one whose success is a `204` with nothing in it —
   * so, unlike `postBatch`, there is no body to read and a non-2xx is simply
   * thrown for `createActorsRequestHandler` to log.
   */
  private async postActors(body: ActorCatalogBody): Promise<void> {
    const check = checkServerUrl(this.settings.serverUrl);
    if (!check.ok) throw new Error(check.reason ?? "Invalid server URL");

    const response = await fetch(apiUrl(check.normalized ?? this.settings.serverUrl, ACTORS_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Master of Tales refused the actor catalog (HTTP ${response.status})`);
    }
  }

  /**
   * The answer to one `actor.create`: the creature exists here now, and this is
   * its Foundry id. Same token, same headers, same shape of failure as
   * `postActors` — a non-2xx is thrown for the handler to turn into the one
   * notification the keeper needs (the actor is real; only the answer went
   * astray).
   */
  private async postActorCreation(body: ActorCreationBody): Promise<void> {
    const check = checkServerUrl(this.settings.serverUrl);
    if (!check.ok) throw new Error(check.reason ?? "Invalid server URL");

    const response = await fetch(apiUrl(check.normalized ?? this.settings.serverUrl, ACTOR_CREATIONS_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Master of Tales refused the new actor's id (HTTP ${response.status})`);
    }
  }

  /**
   * The one gate, shared by every capture and by both render commands.
   *
   * Re-evaluated per event rather than once at `ready`: `activeGM` moves when a
   * GM drops off the wifi, and this client can be promoted or demoted mid-
   * session in either direction. See src/activation.ts.
   */
  private isActive(): boolean {
    return isActiveGM(game) && this.settings.enabled && !this.tokenRejected;
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

// ---------------------------------------------------------- the image path
//
// Three small functions, kept together because they are the only place in this
// file where "the active GM does the work" stops being true. The bridge socket
// still arrives on one client — but an ImagePopout is a *window*, and a window
// is client-local, so the work has to be finished on every screen that was
// targeted. See commands/images.ts for the whole argument.

/** Puts the event on Foundry's module socket. Reaches every other client, never this one. */
function emitToClients(event: ImageShowSocketEvent): void {
  const socket = game.socket;
  if (!socket) {
    log.debug("no Foundry socket available; image.show reached this client only");
    return;
  }
  socket.emit(SOCKET_CHANNEL, event);
}

/** Opens the popout on *this* machine. Foundry does not echo `emit` to the sender. */
function renderLocally(plan: ImagePlan): void {
  const api = resolveImagePopout(globalThis);
  if (!api) {
    log.debug("no Foundry ImagePopout class available; dropping the local image.show");
    return;
  }
  if (!renderImagePopout(plan, api)) log.debug("could not open an image popout", plan);
}

// ------------------------------------------------------ the encounter path
//
// The other place in this file where a command does not finish when it returns —
// though for a different reason than the image path's. There the work has to
// finish on other people's machines; here it finishes when a human has dragged
// six goblins onto a map, which may be thirty seconds later or never.

/**
 * The one open tray, or null.
 *
 * **One at a time, and the old one is closed rather than left up.** Two trays
 * means two `createToken` listeners, and a token dropped for stage three would be
 * counted by stage two as well — which would put it in the tracker twice and roll
 * for it twice. Closing is also what takes the old hook off; see
 * ui/encounterTray.ts.
 */
let encounterTray: EncounterTray | null = null;

function openEncounterTray(plan: EncounterPlan, entries: ResolvedEntry[]): void {
  encounterTray?.close();

  const tray = new EncounterTray({
    plan,
    entries,
    hooks: Hooks,
    rollInitiative: (placements) => void rollEncounterInitiative(placements),
    log,
  });

  encounterTray = tray;
  tray.open();
}

/**
 * Adds what the GM just placed to the scene's combat and asks Foundry to roll.
 *
 * Everything with a decision in it is in `deployInitiative`; this is the wiring
 * plus the one failure the customer can do something about (a Foundry with no
 * Combat class reachable, which means a client that is not finished booting).
 */
async function rollEncounterInitiative(placements: Placement[]): Promise<void> {
  const api = resolveCombatApi(globalThis);
  if (!api) {
    log.warn("no Foundry Combat class available; the tokens are placed but no initiative was rolled");
    return;
  }

  try {
    const outcome = await deployInitiative(
      api,
      { combats: () => game.combats, activeScene: () => game.scenes?.active ?? null },
      placements,
      log,
    );
    log.debug(`encounter deployed: ${outcome.added} combatants added, ${outcome.rolled} rolled`);
  } catch (error) {
    log.warn("could not roll initiative for the deployed tokens", error);
  }
}

/**
 * The listener every client registers — player, second GM, active GM alike.
 *
 * **Not gated on `isActiveGM`.** This is the one registration in the module that
 * must run on the idle path, and the idle path is the one that returns early
 * three lines into the `ready` hook below. Putting it inside `Bridge` would make
 * the feature work exactly as well as showing the picture on the GM's monitor.
 *
 * Called from both `init` and `ready` and guarded, because `game.socket` is
 * established before `init` on current majors but that is an implementation
 * detail of Foundry's boot order rather than a promise, and the cost of being
 * wrong about it is a feature that silently does nothing for players.
 */
let imageListenerRegistered = false;

function registerImageListener(): void {
  if (imageListenerRegistered) return;

  const socket = game.socket;
  if (!socket || typeof socket.on !== "function") return;

  socket.on(
    SOCKET_CHANNEL,
    createImageSocketListener({
      selfId: () => game.user?.id ?? null,
      api: () => resolveImagePopout(globalThis),
      log,
    }),
  );

  imageListenerRegistered = true;
}

Hooks.once("init", () => {
  registerSettings({
    onChange: () => bridge?.reconfigure(),
    notify,
  });
  registerImageListener();
});

Hooks.once("ready", () => {
  // Before the activation gate, deliberately — every client needs this, and the
  // gate below returns.
  registerImageListener();

  if (!isActiveGM(game)) {
    // The idle path, and by far the most common one: every player's client, plus
    // any second GM. Says so once, at debug volume, and then does nothing at all
    // beyond listening for images.
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
