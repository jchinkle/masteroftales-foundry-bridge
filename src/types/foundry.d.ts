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

  interface FoundryCombat extends FoundryDocument {
    round?: number | null;
    turn?: number | null;
    started?: boolean | null;
    /** Whose turn it is. Absent on some paths; `combatants.get(id)` is the fallback. */
    combatant?: FoundryCombatant | null;
    combatants?: FoundryCombatantCollection | FoundryCombatant[] | null;
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
