/**
 * Minimal, hand-written ambient types for the slice of Foundry this module
 * actually touches.
 *
 * Why not `fvtt-types`: it does install and typecheck cleanly under node 22,
 * but (a) it has no stable release — `latest` is a v13 *beta* and v14 lives on
 * the `beta` tag, (b) it pulls ~194 transitive packages into a repo whose entire
 * pitch is "public so you can read what it does with your token", and (c) every
 * `game.settings.register` key requires declaration-merging into its
 * `SettingConfig` interface before it will typecheck. For the ~15 API surfaces
 * below, that is a poor trade.
 *
 * The rule for this file: **describe only what we call, and describe it
 * honestly.** Everything optional is optional, because a v13 client and a v14
 * client disagree about several of these. Where the two majors differ the
 * declaration carries both shapes and the calling code narrows — see
 * `msg.author` vs `msg.user` in capture/chat.ts.
 */

declare global {
  // ---------------------------------------------------------------- documents

  interface FoundryUser {
    id: string;
    name?: string | null;
    isGM?: boolean;
    /** True on exactly one client: the one this browser is logged in as. */
    isSelf?: boolean;
    /**
     * Connected right now — Foundry's `User#active`. The difference between
     * "Robin has a character in this world" and "Robin's browser is open", and
     * only the second can be shown an image. Optional, because a plain source
     * object has no such field and absent must read as "not online".
     */
    active?: boolean;
  }

  interface FoundryDieResult {
    result: number;
    /** v13+: false on results excluded by kh/kl/dl and friends. */
    active?: boolean;
    discarded?: boolean;
    rerolled?: boolean;
  }

  interface FoundryDieTerm {
    faces?: number;
    number?: number;
    results?: FoundryDieResult[];
    /** `["kh"]`, `["kl1"]`, `["r<3"]` … Read only as advantage garnish. */
    modifiers?: string[];
  }

  interface FoundryRoll {
    formula?: string;
    total?: number | null;
    /** Only the DiceTerms, already filtered by Foundry. */
    dice?: FoundryDieTerm[];
    terms?: unknown[];
    /** dnd5e's D20Roll keeps `advantageMode`/`advantage` here. Garnish only. */
    options?: Record<string, unknown> | null;
    toJSON?(): unknown;
  }

  interface FoundrySpeaker {
    alias?: string | null;
    /** Actor *id* in practice, not a UUID — see capture/chat.ts. */
    actor?: string | null;
    token?: string | null;
    scene?: string | null;
    user?: string | null;
  }

  interface FoundryChatMessage {
    id?: string | null;
    /** v13+ document field. */
    author?: FoundryUser | string | null;
    /** v12 and earlier; still populated on many v13 builds. */
    user?: FoundryUser | string | null;
    speaker?: FoundrySpeaker | null;
    rolls?: FoundryRoll[] | null;
    content?: string | null;
    flavor?: string | null;
    whisper?: string[] | null;
    timestamp?: number | null;
    flags?: Record<string, unknown> | null;
    getFlag?(scope: string, key: string): unknown;
  }

  // ------------------------------------------------------- world documents
  //
  // Slice 3's captures. Everything below is optional, and that is not laziness:
  // these hooks hand back a v13 document, a v14 document, a synthetic actor, or
  // (on a few paths, and in every one of our tests) a plain source object. Where
  // v13 and v14 disagree the declaration carries *both* spellings and the
  // reading code narrows — see `delta` vs `actorData` and `name` vs `label`.

  /** Foundry's per-document bookkeeping. `modifiedTime` is every idempotency key's stamp. */
  interface FoundryStats {
    modifiedTime?: number | null;
    createdTime?: number | null;
  }

  /** The fields every world document shares, and the only ones capture reads. */
  interface FoundryDocument {
    id?: string | null;
    /** `Actor.abc`, `Scene.x.Token.y` … the stable cross-document handle. */
    uuid?: string | null;
    name?: string | null;
    /** `"Actor"`, `"Item"`, `"Scene"` … how capture asks "is this parent an Actor?". */
    documentName?: string | null;
    _stats?: FoundryStats | null;
    flags?: Record<string, unknown> | null;
    getFlag?(scope: string, key: string): unknown;
  }

  interface FoundryActor extends FoundryDocument {
    /** System-defined; capture only ever probes it by well-known path. */
    system?: Record<string, unknown> | null;
    /** The system's own actor type — `"npc"`, `"character"`, `"vehicle"`… */
    type?: string | null;
    /**
     * True when some non-GM user owns this actor — Foundry's own answer to "is
     * this one of the party's, or the GM's?".
     *
     * Optional here, and that is load-bearing: it is a *getter* on the Actor
     * class, so a plain source object does not have it. Absent must therefore
     * read as "not player-owned" — see `lootIsPrivate` in capture/items.ts.
     */
    hasPlayerOwner?: boolean | null;
    img?: string | null;
    /** Set on the *synthetic* actor behind an unlinked token; null on a world actor. */
    token?: FoundryTokenDocument | null;
    isToken?: boolean | null;
  }

  interface FoundryTokenDocument extends FoundryDocument {
    hidden?: boolean | null;
    /** `CONST.TOKEN_DISPOSITIONS`. */
    disposition?: number | null;
    /** v10+ image location. */
    texture?: { src?: string | null } | null;
    /** v9 and earlier; still present on some builds. */
    img?: string | null;
    actorId?: string | null;
    actorLink?: boolean | null;
    /** The synthetic actor, already carrying the delta applied. */
    actor?: FoundryActor | null;
    /**
     * A TokenDocument's parent **is** its Scene, which is how `encounter.deploy`
     * learns which map a freshly dropped token landed on.
     */
    parent?: FoundryScene | null;
    /** v11+: an unlinked token's overrides of its base actor. */
    delta?: Record<string, unknown> | null;
    /** v10 and earlier name for `delta`. Both are read; whichever is there wins. */
    actorData?: Record<string, unknown> | null;
  }

  interface FoundryItem extends FoundryDocument {
    system?: Record<string, unknown> | null;
    type?: string | null;
    img?: string | null;
    /** An Actor for loot; an unowned world item has none. */
    parent?: FoundryDocument | null;
  }

  interface FoundryActiveEffect extends FoundryDocument {
    /** v11+. */
    name?: string | null;
    /** v10 and earlier. */
    label?: string | null;
    /** v11+: a Set of status ids. v10 kept one in `flags.core.statusId`. */
    statuses?: Set<string> | string[] | null;
    parent?: FoundryDocument | null;
    disabled?: boolean | null;
  }

  interface FoundryCombatant extends FoundryDocument {
    actorId?: string | null;
    tokenId?: string | null;
    actor?: FoundryActor | null;
    token?: FoundryTokenDocument | null;
    defeated?: boolean | null;
    hidden?: boolean | null;
    initiative?: number | null;
  }

  /**
   * An `EmbeddedCollection` in Foundry, a plain array in our stubs. Read through
   * `collectionValues()`, which handles both plus the `.contents` spelling.
   */
  interface FoundryCombatantCollection extends Iterable<FoundryCombatant> {
    get?(id: string): FoundryCombatant | undefined;
    contents?: FoundryCombatant[];
    size?: number;
  }

  /**
   * A Combat. Read by capture/combat.ts and **written** by
   * commands/encounters.ts, which is why the mutators are here — and why every
   * one of them is optional and guarded at the call site: a combat that arrives
   * as a plain source object has none of them.
   */
  interface FoundryCombat extends FoundryDocument {
    round?: number | null;
    turn?: number | null;
    started?: boolean | null;
    /** True on the one combat the tracker is showing. */
    active?: boolean | null;
    /** The scene this fight is filed under. A source object may carry the bare id. */
    scene?: FoundryScene | string | null;
    /** Whose turn it is. Absent on some paths; `combatants.get(id)` is the fallback. */
    combatant?: FoundryCombatant | null;
    combatants?: FoundryCombatantCollection | FoundryCombatant[] | null;
    createEmbeddedDocuments?(embeddedName: string, data: Record<string, unknown>[]): unknown;
    /**
     * Foundry's own initiative roll, for the named combatant ids. **This module
     * never computes an initiative number** — see the header of
     * commands/encounters.ts. It asks; the system answers.
     */
    rollInitiative?(ids: string[], options?: Record<string, unknown>): unknown;
    /** Rolls for every combatant that has no initiative yet. The fallback path. */
    rollAll?(options?: Record<string, unknown>): unknown;
    /** Makes this the combat the tracker is showing. */
    activate?(options?: Record<string, unknown>): unknown;
  }

  /** `combatTurnChange`'s prior/current markers. */
  interface FoundryTurnMarker {
    round?: number | null;
    turn?: number | null;
    combatantId?: string | null;
    tokenId?: string | null;
  }

  interface FoundryScene extends FoundryDocument {
    active?: boolean | null;
  }

  // ------------------------------------------------------------- journals
  //
  // `handout.show`'s half of the world. This is the only family the module
  // *writes*, so unlike everything above these carry the mutators too — and
  // only the mutators commands/handouts.ts actually calls.

  /** One page of a journal entry. Text pages are the only kind this module writes. */
  interface FoundryJournalEntryPage extends FoundryDocument {
    /** `"text"`, `"image"`, `"pdf"`, `"video"` — a system or module may add more. */
    type?: string | null;
    /**
     * `content` is the HTML the reader is shown; `markdown` is the source, kept
     * when `format` is `CONST.JOURNAL_ENTRY_PAGE_FORMATS.MARKDOWN`. Both are
     * written together — see `handoutPageData`.
     */
    text?: { content?: string | null; markdown?: string | null; format?: number | null } | null;
    update(data: Record<string, unknown>): unknown;
  }

  /**
   * A journal entry. `pages` is an `EmbeddedCollection`, which is a Map
   * subclass — read it through a `.contents`-aware helper, never by spreading.
   */
  interface FoundryJournalEntry extends FoundryDocument {
    folder?: FoundryFolder | string | null;
    ownership?: Record<string, number> | null;
    pages?: unknown;
    update(data: Record<string, unknown>): unknown;
    createEmbeddedDocuments(embeddedName: string, data: Record<string, unknown>[]): unknown;
  }

  /** A sidebar folder. `type` names the document family it holds. */
  interface FoundryFolder extends FoundryDocument {
    type?: string | null;
    folder?: FoundryFolder | string | null;
  }

  /**
   * A `WorldCollection`. Only its iteration surface is described: the module
   * finds its own documents by flag, and Foundry's own `get`-by-id is no use for
   * that.
   */
  interface FoundryWorldCollection<T> extends Iterable<T> {
    get?(id: string): T | undefined;
    contents?: T[];
    size?: number;
  }

  /** `game.scenes`, whose one extra member is the map everyone is looking at. */
  interface FoundryScenes extends FoundryWorldCollection<FoundryScene> {
    active?: FoundryScene | null;
  }

  // -------------------------------------------------------------------- game

  interface FoundrySettings {
    register(namespace: string, key: string, data: Record<string, unknown>): void;
    get(namespace: string, key: string): unknown;
    set(namespace: string, key: string, value: unknown): Promise<unknown>;
  }

  interface FoundryUsers extends Iterable<FoundryUser> {
    get(id: string): FoundryUser | undefined;
    /** The one client the module activates on. Undefined when no GM is online. */
    activeGM?: FoundryUser | null;
  }

  interface FoundryModule {
    id?: string;
    version?: string;
    active?: boolean;
  }

  /**
   * Foundry's **own** socket — its socket.io connection back to the Foundry
   * server, and a completely different thing from `transport/socket.ts`, which
   * is this module's WebSocket out to Master of Tales. This one is how the GM's
   * client reaches the players' clients; it is available only after `ready`, and
   * only when `module.json` declares `"socket": true`.
   */
  interface FoundrySocket {
    emit(event: string, data: unknown, ack?: (...args: unknown[]) => void): void;
    on(event: string, handler: (...args: any[]) => unknown): void;
    off?(event: string, handler?: (...args: any[]) => unknown): void;
  }

  interface FoundryGame {
    ready?: boolean;
    version?: string;
    world?: { id?: string; title?: string } | null;
    system?: { id?: string; version?: string } | null;
    user?: FoundryUser | null;
    users?: FoundryUsers | null;
    settings: FoundrySettings;
    modules?: { get(id: string): FoundryModule | undefined } | null;
    i18n?: { localize(key: string): string } | null;
    /** Undefined until `ready`. Every read of it is guarded. */
    socket?: FoundrySocket | null;
    /** Every JournalEntry in the world this client may see. `handout.show`'s id map. */
    journal?: FoundryWorldCollection<FoundryJournalEntry> | null;
    /** Every Folder, of every type. Filtered to `"JournalEntry"` before use. */
    folders?: FoundryWorldCollection<FoundryFolder> | null;
    /** Every Actor in the world. `encounter.deploy`'s lookup, and the catalog's source. */
    actors?: FoundryWorldCollection<FoundryActor> | null;
    /** Every Combat. `encounter.deploy` adopts the active scene's, or makes one. */
    combats?: FoundryWorldCollection<FoundryCombat> | null;
    /** Every Scene, plus `active` — the map a deployed token lands on. */
    scenes?: FoundryScenes | null;
  }

  interface FoundryNotifications {
    info(message: string, options?: Record<string, unknown>): unknown;
    warn(message: string, options?: Record<string, unknown>): unknown;
    error(message: string, options?: Record<string, unknown>): unknown;
  }

  interface FoundryUi {
    notifications?: FoundryNotifications | null;
  }

  interface FoundryHooks {
    on(hook: string, fn: (...args: any[]) => unknown): number;
    once(hook: string, fn: (...args: any[]) => unknown): number;
    off(hook: string, id: number | ((...args: any[]) => unknown)): void;
    callAll(hook: string, ...args: unknown[]): boolean;
  }

  const game: FoundryGame;
  const ui: FoundryUi;
  const Hooks: FoundryHooks;
}

export {};
