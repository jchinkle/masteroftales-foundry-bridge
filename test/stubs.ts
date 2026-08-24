/**
 * Hand-rolled stubs for the slice of Foundry this module touches, plus a
 * deterministic clock and a fake WebSocket.
 *
 * Nothing here imports Foundry, and nothing here is a mock framework. The stubs
 * are small on purpose: the moment a stub is complicated enough to have bugs,
 * the tests it supports stop being evidence.
 */

import type { SystemAdapter } from "../src/adapters/index.js";
import type { DocumentContext } from "../src/capture/documents.js";
import { PriorValues } from "../src/capture/priorValues.js";
import type { ChatMessageClass } from "../src/commands/chat.js";
import type { DiceApi } from "../src/commands/dice.js";
import type { SocketLike } from "../src/transport/socket.js";

// -------------------------------------------------------------------- clock

export interface ScheduledTimer {
  id: number;
  delay: number;
  at: number;
}

/**
 * A timer wheel with no real time in it. Every scheduled delay is recorded, so
 * a test can assert "the third retry waited no more than 8s" without sleeping.
 */
export class FakeClock {
  current = 0;
  readonly scheduled: ScheduledTimer[] = [];

  private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.current;

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.seq++;
    this.timers.set(id, { at: this.current + ms, fn });
    this.scheduled.push({ id, delay: ms, at: this.current + ms });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  /** Delays passed to setTimer, in order. The backoff assertions read this. */
  get delays(): number[] {
    return this.scheduled.map((entry) => entry.delay);
  }

  /** Runs every timer due within `ms`, in due order, advancing `current` as it goes. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      due[1].fn();
    }
    this.current = target;
  }

  /** Advances, then lets queued microtasks (awaited promises) settle. */
  async advanceAsync(ms: number): Promise<void> {
    this.advance(ms);
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** A promise a test resolves by hand — used to hold a batch "in flight". */
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ------------------------------------------------------------------- sockets

/** A WebSocket that does nothing until a test tells it to. */
export class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;

  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // --- test drivers -------------------------------------------------------

  open(): void {
    this.onopen?.({});
  }

  /** Delivers a raw cable frame, serialised the way a real server would. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  /** Network-level close: no `disconnect` frame, just the socket going away. */
  drop(): void {
    this.onclose?.({});
  }

  get lastSent(): string | undefined {
    return this.sent[this.sent.length - 1];
  }
}

export class SocketFactory {
  readonly created: FakeSocket[] = [];

  create = (url: string): SocketLike => {
    const socket = new FakeSocket(url);
    this.created.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.created[this.created.length - 1];
    if (!socket) throw new Error("no socket has been created");
    return socket;
  }
}

// ---------------------------------------------------------------- game stubs

export interface StubUser {
  id: string;
  name?: string | null;
  isGM?: boolean;
  isSelf?: boolean;
  /**
   * Connected right now. **Left exactly as given** — no default is applied, so a
   * roster test that says nothing about `active` asserts the production
   * reading's "absent means offline" rule rather than a stub's opinion.
   */
  active?: boolean;
}

export interface StubGameOptions {
  users?: StubUser[];
  /** id of the user Foundry considers the active GM, if any. */
  activeGMId?: string | null;
  worldId?: string;
  systemId?: string;
  systemVersion?: string;
  foundryVersion?: string;
  moduleVersion?: string;
  settings?: Record<string, unknown>;
}

export interface RegisteredSetting {
  namespace: string;
  key: string;
  data: Record<string, unknown>;
}

export interface StubGame {
  version: string;
  world: { id: string };
  system: { id: string; version: string };
  user: StubUser | null;
  users: {
    get(id: string): StubUser | undefined;
    activeGM: StubUser | null;
    [Symbol.iterator](): Iterator<StubUser>;
  };
  settings: {
    register(namespace: string, key: string, data: Record<string, unknown>): void;
    get(namespace: string, key: string): unknown;
    set(namespace: string, key: string, value: unknown): Promise<unknown>;
  };
  modules: { get(id: string): { id: string; version: string } | undefined };
  /** Test-only handles. */
  registered: RegisteredSetting[];
  store: Map<string, unknown>;
}

export function createGame(options: StubGameOptions = {}): StubGame {
  const users = options.users ?? [{ id: "gm1", name: "Jeremy", isGM: true, isSelf: true }];
  const self = users.find((user) => user.isSelf) ?? null;
  const activeGM = options.activeGMId === null ? null : users.find((u) => u.id === options.activeGMId) ?? users.find((u) => u.isGM) ?? null;

  const registered: RegisteredSetting[] = [];
  const store = new Map<string, unknown>(Object.entries(options.settings ?? {}));

  return {
    version: options.foundryVersion ?? "13.346",
    world: { id: options.worldId ?? "test-world" },
    system: { id: options.systemId ?? "dnd5e", version: options.systemVersion ?? "5.0.2" },
    user: self,
    users: {
      get: (id) => users.find((user) => user.id === id),
      activeGM,
      [Symbol.iterator]: () => users[Symbol.iterator](),
    },
    settings: {
      register(namespace, key, data) {
        registered.push({ namespace, key, data });
        const storeKey = `${namespace}.${key}`;
        if (!store.has(storeKey)) store.set(storeKey, data.default);
      },
      get(namespace, key) {
        return store.get(`${namespace}.${key}`);
      },
      async set(namespace, key, value) {
        store.set(`${namespace}.${key}`, value);
        return value;
      },
    },
    modules: {
      get: (id) => (id ? { id, version: options.moduleVersion ?? "0.1.0" } : undefined),
    },
    registered,
    store,
  };
}

export interface StubHooks {
  on(hook: string, fn: (...args: any[]) => unknown): number;
  once(hook: string, fn: (...args: any[]) => unknown): number;
  off(hook: string, id: number): void;
  /** Test-only: fire every handler registered for `hook`. */
  emit(hook: string, ...args: unknown[]): void;
  handlers: Map<string, Array<(...args: any[]) => unknown>>;
}

export function createHooks(): StubHooks {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  let seq = 1;

  const add = (hook: string, fn: (...args: any[]) => unknown): number => {
    const list = handlers.get(hook) ?? [];
    list.push(fn);
    handlers.set(hook, list);
    return seq++;
  };

  return {
    handlers,
    on: add,
    once: add,
    off() {
      /* not needed by any test yet */
    },
    emit(hook, ...args) {
      for (const fn of handlers.get(hook) ?? []) fn(...args);
    },
  };
}

export interface StubUi {
  notifications: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** Test-only: everything the module tried to tell the customer. */
  messages: { info: string[]; warn: string[]; error: string[] };
}

export function createUi(): StubUi {
  const messages = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    messages,
    notifications: {
      info: (message) => void messages.info.push(message),
      warn: (message) => void messages.warn.push(message),
      error: (message) => void messages.error.push(message),
    },
  };
}

/** Collects the module's log output so a test can assert it said something useful. */
export function createLog(): {
  debug(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  lines: { debug: string[]; warn: string[]; error: string[] };
} {
  const lines = { debug: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    lines,
    debug: (message) => void lines.debug.push(message),
    warn: (message) => void lines.warn.push(message),
    error: (message) => void lines.error.push(message),
  };
}

// ------------------------------------------------------------ document stubs

export interface StubDieOptions {
  faces: number;
  results: Array<number | { result: number; active?: boolean; discarded?: boolean }>;
}

export function die(options: StubDieOptions): FoundryDieTerm {
  return {
    faces: options.faces,
    number: options.results.length,
    results: options.results.map((entry) =>
      typeof entry === "number" ? { result: entry, active: true } : { active: true, ...entry },
    ),
  };
}

export function roll(formula: string, total: number, dice: FoundryDieTerm[] = []): FoundryRoll {
  return { formula, total, dice };
}

export interface StubMessageOptions {
  id?: string | null;
  author?: FoundryUser | string | null;
  user?: FoundryUser | string | null;
  speaker?: FoundrySpeaker | null;
  rolls?: FoundryRoll[] | null;
  content?: string | null;
  flavor?: string | null;
  whisper?: string[] | null;
  timestamp?: number | null;
  flags?: Record<string, unknown> | null;
}

export function chatMessage(options: StubMessageOptions = {}): FoundryChatMessage {
  // `=== undefined` rather than `??` throughout: several tests need to pass an
  // explicit null (an absent author, a null whisper list) and have it survive.
  return {
    id: options.id === undefined ? "msg1" : options.id,
    author: options.author === undefined ? "gm1" : options.author,
    user: options.user === undefined ? null : options.user,
    speaker: options.speaker === undefined ? { alias: "Tharivol" } : options.speaker,
    rolls: options.rolls === undefined ? null : options.rolls,
    content: options.content === undefined ? "" : options.content,
    flavor: options.flavor === undefined ? null : options.flavor,
    whisper: options.whisper === undefined ? [] : options.whisper,
    timestamp: options.timestamp === undefined ? Date.UTC(2026, 7, 17, 20, 14, 3) : options.timestamp,
    flags: options.flags === undefined ? {} : options.flags,
  };
}

/** An adapter that garnishes nothing — the generic case, inline. */
export function nullAdapter(): SystemAdapter {
  return {
    id: "*",
    rollExt: () => undefined,
    chatExt: () => undefined,
    actorExt: () => undefined,
    currency: () => undefined,
  };
}

/** A capture context wired to a stub game, for `buildChatEvents`. */
export function captureContext(
  overrides: Partial<import("../src/capture/chat.js").CaptureContext> = {},
  g: StubGame = createGame(),
): import("../src/capture/chat.js").CaptureContext {
  return {
    resolveUser: (userId: string) => (g.users.get(userId) as FoundryUser | undefined) ?? null,
    adapter: nullAdapter(),
    adapterContext: { systemId: g.system.id, systemVersion: g.system.version },
    now: () => new Date("2026-08-17T00:00:00.000Z"),
    ...overrides,
  };
}

// --------------------------------------------------- outbound command stubs
//
// Slice 4 renders *into* Foundry, so these stubs stand in for the classes the
// module constructs rather than the documents it reads. They model the two rules
// real Foundry enforces and that a naive fake would let us get away with
// breaking: `Roll.fromTerms` refuses a mix of evaluated and unevaluated terms,
// and it derives the formula from the terms it was given.

/** One `RollTerm`. `_evaluated` starts false, exactly as a fresh one does. */
export class FakeTerm {
  _evaluated = false;

  constructor(
    readonly kind: "Die" | "OperatorTerm" | "NumericTerm",
    readonly data: Record<string, unknown>,
  ) {}
}

export interface FakeChatCall {
  data: Record<string, unknown>;
  options?: Record<string, unknown> | undefined;
}

export class FakeRoll {
  _evaluated = false;
  _total: number | undefined = undefined;
  _formula: string;

  /** Every `toMessage` call, so a test can read the flags and the speaker. */
  readonly messages: FakeChatCall[] = [];

  constructor(
    readonly terms: FakeTerm[],
    formula: string,
  ) {
    this._formula = formula;
  }

  toMessage(data: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    this.messages.push({ data, options });
    return Promise.resolve({ id: "chat1" });
  }
}

/** What Foundry's own `Roll.getFormula` would produce from these terms. */
function fakeFormula(terms: FakeTerm[]): string {
  return terms
    .map((term) => {
      if (term.kind === "Die") return `${String(term.data.number)}d${String(term.data.faces)}`;
      if (term.kind === "OperatorTerm") return String(term.data.operator);
      return String(term.data.number);
    })
    .join(" ");
}

export interface FakeDiceApi {
  api: DiceApi;
  /** Every term constructed, in order. */
  terms: FakeTerm[];
  /** Every roll `fromTerms` produced. */
  rolls: FakeRoll[];
  /** The last roll, for the common single-command test. */
  readonly lastRoll: FakeRoll | undefined;
}

export interface FakeDiceApiOptions {
  /** Make `Roll.fromTerms` throw, the way a system with a stricter Roll would. */
  fromTermsThrows?: boolean;
  /** Make `toMessage` reject, the way a Foundry mid-teardown does. */
  toMessageRejects?: boolean;
}

export function createDiceApi(options: FakeDiceApiOptions = {}): FakeDiceApi {
  const terms: FakeTerm[] = [];
  const rolls: FakeRoll[] = [];

  const record = <T extends FakeTerm>(term: T): T => {
    terms.push(term);
    return term;
  };

  class Die extends FakeTerm {
    constructor(data: Record<string, unknown>) {
      super("Die", data);
      record(this);
    }
  }
  class OperatorTerm extends FakeTerm {
    constructor(data: Record<string, unknown>) {
      super("OperatorTerm", data);
      record(this);
    }
  }
  class NumericTerm extends FakeTerm {
    constructor(data: Record<string, unknown>) {
      super("NumericTerm", data);
      record(this);
    }
  }

  const api: DiceApi = {
    Die,
    OperatorTerm,
    NumericTerm,
    Roll: {
      fromTerms(given: object[]) {
        if (options.fromTermsThrows) throw new Error("this system's Roll does not accept those terms");

        const list = given as FakeTerm[];
        // Foundry's own guard, reproduced verbatim in spirit: a roll is either
        // wholly evaluated or wholly unevaluated, never half.
        const evaluated = list.filter((term) => term._evaluated).length;
        if (evaluated !== 0 && evaluated !== list.length) {
          throw new Error("You can only call Roll.fromTerms with an array of terms which are either all evaluated, or none evaluated");
        }

        const roll = new FakeRoll(list, fakeFormula(list));
        if (options.toMessageRejects) {
          roll.toMessage = () => Promise.reject(new Error("no chat log"));
        }
        rolls.push(roll);
        return roll;
      },
    },
  };

  return {
    api,
    terms,
    rolls,
    get lastRoll() {
      return rolls[rolls.length - 1];
    },
  };
}

export interface FakeChatMessages {
  ChatMessage: ChatMessageClass;
  /** Every `ChatMessage.create` call. */
  created: FakeChatCall[];
}

export function createChatMessageClass(options: { rejects?: boolean } = {}): FakeChatMessages {
  const created: FakeChatCall[] = [];

  // A *function*, because `resolveChatMessageClass` looks for a constructor
  // carrying a static `create` — which is what a Foundry document class is.
  function ChatMessage(): void {
    /* never constructed; documents are made through `create` */
  }
  ChatMessage.create = (data: Record<string, unknown>, opts?: Record<string, unknown>): Promise<unknown> => {
    created.push({ data, options: opts });
    return options.rejects ? Promise.reject(new Error("no chat log")) : Promise.resolve({ id: "chat1" });
  };

  return { ChatMessage: ChatMessage as unknown as ChatMessageClass, created };
}

// ------------------------------------------------- foundry's own module socket

/**
 * Foundry's socket.io connection, as `image.show` uses it — and note the one
 * behaviour a naive fake would get wrong and that the whole feature turns on:
 * **`emit` does not deliver to the emitter.** The GM's own copy of the image
 * comes from a separate local render, and a stub that echoed would hide the bug
 * where that render is missing.
 */
export interface FakeModuleSocket {
  socket: { emit(event: string, data: unknown): void; on(event: string, handler: (data: unknown) => void): void };
  /** Everything emitted, in order. */
  emitted: Array<{ event: string; data: unknown }>;
  /** Handlers registered per channel. */
  handlers: Map<string, Array<(data: unknown) => void>>;
  /** Test-only: deliver a payload to this client's listeners, as the server would. */
  deliver(event: string, data: unknown): void;
}

export function createModuleSocket(options: { emitThrows?: boolean } = {}): FakeModuleSocket {
  const emitted: Array<{ event: string; data: unknown }> = [];
  const handlers = new Map<string, Array<(data: unknown) => void>>();

  return {
    emitted,
    handlers,
    socket: {
      emit(event, data) {
        if (options.emitThrows) throw new Error("socket is not connected");
        // Serialised and revived, because Foundry's really is — a payload that
        // only survives by reference would pass a test and fail at a table.
        emitted.push({ event, data: JSON.parse(JSON.stringify(data)) as unknown });
      },
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    },
    deliver(event, data) {
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
  };
}

// ------------------------------------------------------------- ImagePopout

export interface FakePopout {
  args: unknown[];
  rendered: boolean[];
}

export interface FakeImagePopout {
  /** A v13+ scope: the class lives at `foundry.applications.apps.ImagePopout`. */
  v13Scope: Record<string, unknown>;
  /** A v12-era scope: the bare global only. */
  legacyScope: Record<string, unknown>;
  /** Every popout constructed, in order, with the exact argument list it got. */
  popouts: FakePopout[];
  readonly last: FakePopout | undefined;
}

export interface FakeImagePopoutOptions {
  /** Make the constructor throw, the way a Foundry mid-teardown does. */
  constructorThrows?: boolean;
  /** Make `render` reject, for the unhandled-rejection guard. */
  renderRejects?: boolean;
}

export function createImagePopout(options: FakeImagePopoutOptions = {}): FakeImagePopout {
  const popouts: FakePopout[] = [];

  class ImagePopout {
    readonly self: FakePopout;

    constructor(...args: unknown[]) {
      if (options.constructorThrows) throw new Error("no application layer");
      this.self = { args, rendered: [] };
      popouts.push(this.self);
    }

    render(force?: boolean): Promise<unknown> {
      this.self.rendered.push(force === true);
      return options.renderRejects ? Promise.reject(new Error("no canvas")) : Promise.resolve(this);
    }
  }

  return {
    popouts,
    v13Scope: { foundry: { applications: { apps: { ImagePopout } } }, ImagePopout },
    legacyScope: { ImagePopout },
    get last() {
      return popouts[popouts.length - 1];
    },
  };
}

// ------------------------------------------------------- world document stubs

/**
 * The `_stats.modifiedTime` every document stub carries, and therefore the
 * discriminator in every expected idempotency key. Same instant as the chat
 * stub's timestamp, so `ts` reads identically across every family:
 * `2026-08-17T20:14:03.000Z`.
 */
export const STUB_MTIME = Date.UTC(2026, 7, 17, 20, 14, 3);

export interface StubDocumentOptions {
  id?: string | null;
  uuid?: string | null;
  name?: string | null;
  /** Set to null to model a document Foundry wrote no `_stats` for. */
  modifiedTime?: number | null;
  flags?: Record<string, unknown> | null;
}

/**
 * The fields every document stub shares. `=== undefined` rather than `??`
 * throughout, because several tests need to pass an explicit null — a document
 * with no uuid, a token with no mtime — and have it survive.
 */
function baseDocument(options: StubDocumentOptions, documentName: string, defaultId: string) {
  const id = options.id === undefined ? defaultId : options.id;
  return {
    id,
    uuid: options.uuid === undefined ? `${documentName}.${id}` : options.uuid,
    name: options.name === undefined ? null : options.name,
    documentName,
    _stats: options.modifiedTime === null ? null : { modifiedTime: options.modifiedTime ?? STUB_MTIME },
    flags: options.flags === undefined ? {} : options.flags,
  };
}

export interface StubActorOptions extends StubDocumentOptions {
  system?: Record<string, unknown> | null;
  img?: string | null;
  /** Set for the *synthetic* actor behind an unlinked token. */
  token?: FoundryTokenDocument | null;
  /**
   * Whether a non-GM user owns this actor. **Defaults to false** — a stub actor
   * is an NPC unless a test says so, which is the same direction the production
   * reading errs in. A test that forgets to think about ownership therefore gets
   * the private answer rather than the leaky one.
   */
  hasPlayerOwner?: boolean | null;
}

export function actorDocument(options: StubActorOptions = {}): FoundryActor {
  return {
    ...baseDocument({ name: "Tharivol", ...options }, "Actor", "actor1"),
    system: options.system === undefined ? null : options.system,
    img: options.img === undefined ? null : options.img,
    token: options.token === undefined ? null : options.token,
    hasPlayerOwner: options.hasPlayerOwner === undefined ? false : options.hasPlayerOwner,
  };
}

/** A player character — owned by somebody at the table, so their loot is public. */
export function playerActor(options: StubActorOptions = {}): FoundryActor {
  return actorDocument({ hasPlayerOwner: true, ...options });
}

export interface StubTokenOptions extends StubDocumentOptions {
  hidden?: boolean | null;
  disposition?: number | null;
  texture?: { src?: string | null } | null;
  img?: string | null;
  actor?: FoundryActor | null;
  /** v11+ unlinked override. */
  delta?: Record<string, unknown> | null;
  /** v10 spelling of the same thing. */
  actorData?: Record<string, unknown> | null;
}

export function tokenDocument(options: StubTokenOptions = {}): FoundryTokenDocument {
  const id = options.id === undefined ? "token1" : options.id;
  return {
    ...baseDocument({ name: "Goblin", ...options, id }, "Token", "token1"),
    // Real token uuids are scene-scoped, and several assertions depend on the
    // shape rather than just the value.
    uuid: options.uuid === undefined ? `Scene.scene1.Token.${id}` : options.uuid,
    hidden: options.hidden === undefined ? false : options.hidden,
    disposition: options.disposition === undefined ? -1 : options.disposition,
    texture: options.texture === undefined ? null : options.texture,
    img: options.img === undefined ? null : options.img,
    actor: options.actor === undefined ? null : options.actor,
    delta: options.delta === undefined ? null : options.delta,
    actorData: options.actorData === undefined ? null : options.actorData,
  };
}

export interface StubItemOptions extends StubDocumentOptions {
  system?: Record<string, unknown> | null;
  parent?: FoundryDocument | null;
}

export function itemDocument(options: StubItemOptions = {}): FoundryItem {
  return {
    ...baseDocument({ name: "Potion of Healing", ...options }, "Item", "item1"),
    system: options.system === undefined ? null : options.system,
    parent: options.parent === undefined ? actorDocument() : options.parent,
  };
}

export interface StubEffectOptions extends StubDocumentOptions {
  /** v10 spelling. Only set it when testing that path. */
  label?: string | null;
  statuses?: Set<string> | string[] | null;
  parent?: FoundryDocument | null;
}

export function activeEffect(options: StubEffectOptions = {}): FoundryActiveEffect {
  return {
    ...baseDocument({ name: "Poisoned", ...options }, "ActiveEffect", "effect1"),
    label: options.label === undefined ? null : options.label,
    statuses: options.statuses === undefined ? null : options.statuses,
    parent: options.parent === undefined ? actorDocument() : options.parent,
  };
}

export interface StubCombatantOptions extends StubDocumentOptions {
  actor?: FoundryActor | null;
  token?: FoundryTokenDocument | null;
  actorId?: string | null;
  tokenId?: string | null;
  defeated?: boolean | null;
}

export function combatant(options: StubCombatantOptions = {}): FoundryCombatant {
  return {
    ...baseDocument({ name: "Goblin", ...options }, "Combatant", "combatant1"),
    actor: options.actor === undefined ? null : options.actor,
    token: options.token === undefined ? null : options.token,
    actorId: options.actorId === undefined ? null : options.actorId,
    tokenId: options.tokenId === undefined ? null : options.tokenId,
    defeated: options.defeated === undefined ? null : options.defeated,
  };
}

export interface StubCombatOptions extends StubDocumentOptions {
  round?: number | null;
  turn?: number | null;
  /** A plain array, which is what `collectionValues` is expected to cope with. */
  combatants?: FoundryCombatant[] | FoundryCombatantCollection | null;
  combatant?: FoundryCombatant | null;
}

export function combatDocument(options: StubCombatOptions = {}): FoundryCombat {
  return {
    ...baseDocument({ name: null, ...options }, "Combat", "combat1"),
    round: options.round === undefined ? 1 : options.round,
    turn: options.turn === undefined ? 0 : options.turn,
    combatants: options.combatants === undefined ? [] : options.combatants,
    combatant: options.combatant === undefined ? null : options.combatant,
  };
}

export interface StubSceneOptions extends StubDocumentOptions {
  active?: boolean | null;
}

export function sceneDocument(options: StubSceneOptions = {}): FoundryScene {
  return {
    ...baseDocument({ name: "Vallaki", ...options }, "Scene", "scene1"),
    active: options.active === undefined ? true : options.active,
  };
}

/**
 * A `DocumentContext` for the slice 3 builders.
 *
 * The `sequence` is a plain counter and the clock is fixed, so a test that
 * exercises the no-mtime fallback gets `s1`, `s2`, … rather than something that
 * changes between runs — which is exactly the property the production
 * implementation is required to have.
 */
export function documentContext(overrides: Partial<DocumentContext> = {}): DocumentContext {
  let seq = 0;
  return {
    adapter: nullAdapter(),
    adapterContext: { systemId: "dnd5e", systemVersion: "5.0.2" },
    prior: new PriorValues(),
    sequence: () => (seq += 1),
    now: () => new Date("2026-08-17T00:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------- journals
//
// `handout.show`'s stubs, and the one behaviour a naive fake would get wrong:
// **a Foundry collection is a Map subclass**, so these expose `.contents` and
// iterate documents rather than `[id, doc]` pairs — which is exactly the trap
// `values()` in commands/handouts.ts exists to avoid. They also model the two
// document rules the write path depends on: `update` *merges* rather than
// replaces (Foundry's own ownership semantics, and the reason a player keeps a
// letter they were handed last session), and `create` returns the document.

export interface FakePageOptions {
  name?: string | null;
  type?: string;
  text?: { markdown?: string; content?: string; format?: number };
}

/** A `JournalEntryPage`. Ids are minted here; Foundry mints them server-side. */
let pageSequence = 0;

export class FakeJournalPage {
  readonly id = `page${(pageSequence += 1)}`;
  name: string | null = null;
  type = "text";
  text: { markdown?: string; content?: string; format?: number } = {};

  /** Every `update` call, exactly as it arrived. */
  readonly updates: Record<string, unknown>[] = [];

  constructor(data: Record<string, unknown> = {}) {
    this.apply(data);
  }

  update(data: Record<string, unknown>): Promise<unknown> {
    this.updates.push(data);
    this.apply(data);
    return Promise.resolve(this);
  }

  private apply(data: Record<string, unknown>): void {
    if (typeof data.name === "string") this.name = data.name;
    if (typeof data.type === "string") this.type = data.type;
    if (data.text && typeof data.text === "object") Object.assign(this.text, data.text);
  }
}

/** A `JournalEntry`, pages and all. */
export class FakeJournalEntry {
  name: string | null = null;
  flags: Record<string, unknown> = {};
  ownership: Record<string, number> = {};
  folder: string | null = null;

  readonly pages: FakeCollection<FakeJournalPage>;
  readonly updates: Record<string, unknown>[] = [];

  constructor(
    readonly id: string,
    data: Record<string, unknown> = {},
  ) {
    const pages = Array.isArray(data.pages) ? (data.pages as Record<string, unknown>[]) : [];
    this.pages = new FakeCollection(pages.map((page) => new FakeJournalPage(page)));
    this.apply(data);
  }

  update(data: Record<string, unknown>): Promise<unknown> {
    this.updates.push(data);
    this.apply(data);
    return Promise.resolve(this);
  }

  createEmbeddedDocuments(embeddedName: string, data: Record<string, unknown>[]): Promise<unknown> {
    if (embeddedName !== "JournalEntryPage") throw new Error(`no such embedded document: ${embeddedName}`);
    const created = data.map((page) => new FakeJournalPage(page));
    for (const page of created) this.pages.push(page);
    return Promise.resolve(created);
  }

  private apply(data: Record<string, unknown>): void {
    if (typeof data.name === "string") this.name = data.name;
    if (typeof data.folder === "string") this.folder = data.folder;
    // Merged, never replaced — Foundry's own update semantics for both of these.
    if (data.flags && typeof data.flags === "object") Object.assign(this.flags, data.flags);
    if (data.ownership && typeof data.ownership === "object") {
      Object.assign(this.ownership, data.ownership as Record<string, number>);
    }
  }
}

/** A `Folder`. */
export class FakeFolder {
  name: string | null = null;
  type: string | null = null;
  flags: Record<string, unknown> = {};

  constructor(
    readonly id: string,
    data: Record<string, unknown> = {},
  ) {
    if (typeof data.name === "string") this.name = data.name;
    if (typeof data.type === "string") this.type = data.type;
    if (data.flags && typeof data.flags === "object") Object.assign(this.flags, data.flags);
  }
}

/**
 * A Foundry collection: a Map keyed by id, with the documented `.contents`
 * array accessor. Spreading it yields `[id, doc]` pairs, exactly as the real
 * thing does — which is the whole reason this is a Map and not an array.
 */
export class FakeCollection<T extends { id: string }> extends Map<string, T> {
  constructor(documents: T[] = []) {
    super(documents.map((doc) => [doc.id, doc]));
  }

  get contents(): T[] {
    return [...this.values()];
  }

  push(doc: T): void {
    this.set(doc.id, doc);
  }
}

export interface FakeJournalOptions {
  /** Entries already in the world. */
  entries?: FakeJournalEntry[];
  /** Folders already in the world, of any type. */
  folders?: FakeFolder[];
  /** Leave false to model a Foundry whose markdown converter moved. */
  converter?: boolean;
  /** Make `JournalEntry.create` resolve to null, the way a refused create does. */
  createReturnsNull?: boolean;
  /** Make `Journal.show` reject, the way a client mid-teardown does. */
  showRejects?: boolean;
}

export interface FakeJournalShow {
  doc: unknown;
  options: Record<string, unknown>;
}

export interface FakeJournal {
  /** A v13/v14 scope: the classes live under `foundry.documents…`. */
  v13Scope: Record<string, unknown>;
  /** A v12-era scope: bare globals only. */
  legacyScope: Record<string, unknown>;
  /** `game.journal` and `game.folders`, as the handler reads them. */
  world: { entries(): unknown; folders(): unknown };
  entries: FakeCollection<FakeJournalEntry>;
  folders: FakeCollection<FakeFolder>;
  /** Every `Journal.show`, in order. */
  shown: FakeJournalShow[];
  /** Every `JournalEntry.create` / `Folder.create` argument, in order. */
  createdEntries: Record<string, unknown>[];
  createdFolders: Record<string, unknown>[];
  /**
   * Anything that reached the **deprecated bare globals** on the v13 scope. Must
   * stay empty: on v13 both spellings exist, and reaching for the global first
   * is the mistake this bucket is here to catch.
   */
  decoyed: string[];
}

/** The markdown Foundry's own converter would make of this — near enough for a test. */
function fakeMakeHtml(markdown: string): string {
  return `<p>${markdown.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`;
}

export function createJournal(options: FakeJournalOptions = {}): FakeJournal {
  const entries = new FakeCollection<FakeJournalEntry>(options.entries ?? []);
  const folders = new FakeCollection<FakeFolder>(options.folders ?? []);
  const shown: FakeJournalShow[] = [];
  const createdEntries: Record<string, unknown>[] = [];
  const createdFolders: Record<string, unknown>[] = [];
  const decoyed: string[] = [];

  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}${(sequence += 1)}`;

  function Journal(): void {
    /* never constructed */
  }
  Journal.show = (doc: unknown, showOptions: Record<string, unknown>): Promise<unknown> => {
    shown.push({ doc, options: showOptions });
    return options.showRejects ? Promise.reject(new Error("no application layer")) : Promise.resolve(doc);
  };

  function JournalEntry(): void {
    /* never constructed */
  }
  JournalEntry.create = (data: Record<string, unknown>): Promise<unknown> => {
    createdEntries.push(data);
    if (options.createReturnsNull) return Promise.resolve(null);
    const entry = new FakeJournalEntry(nextId("entry"), data);
    entries.push(entry);
    return Promise.resolve(entry);
  };

  function Folder(): void {
    /* never constructed */
  }
  Folder.create = (data: Record<string, unknown>): Promise<unknown> => {
    createdFolders.push(data);
    const folder = new FakeFolder(nextId("folder"), data);
    folders.push(folder);
    return Promise.resolve(folder);
  };

  const decoy = (name: string, method: string): Record<string, unknown> => {
    const stub = (): void => undefined;
    (stub as unknown as Record<string, unknown>)[method] = (): Promise<unknown> => {
      decoyed.push(name);
      return Promise.resolve(null);
    };
    return stub as unknown as Record<string, unknown>;
  };

  const CONST = {
    JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1, MARKDOWN: 2 },
    DOCUMENT_OWNERSHIP_LEVELS: { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
  };

  const markdownSheet = { _converter: { makeHtml: fakeMakeHtml } };
  const sheets = options.converter === false ? {} : { MarkdownJournalPageSheet: markdownSheet };

  return {
    entries,
    folders,
    shown,
    createdEntries,
    createdFolders,
    decoyed,
    world: { entries: () => entries, folders: () => folders },
    v13Scope: {
      foundry: {
        documents: { collections: { Journal }, JournalEntry, Folder },
        appv1: { sheets },
        CONST,
      },
      // The deprecated aliases a real v13 also carries. Resolution must never
      // reach these.
      Journal: decoy("Journal", "show"),
      JournalEntry: decoy("JournalEntry", "create"),
      Folder: decoy("Folder", "create"),
      CONST,
    },
    legacyScope: {
      Journal,
      JournalEntry,
      Folder,
      CONST,
      ...(options.converter === false ? {} : { MarkdownJournalPageSheet: markdownSheet }),
    },
  };
}
