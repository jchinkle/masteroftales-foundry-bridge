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
  }

  interface FoundryRoll {
    formula?: string;
    total?: number | null;
    /** Only the DiceTerms, already filtered by Foundry. */
    dice?: FoundryDieTerm[];
    terms?: unknown[];
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
