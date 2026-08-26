import { collectionValues } from "../capture/documents.js";
import { stripHtml, truncate } from "../capture/html.js";
import type { ActorCatalogBody } from "../protocol/actors.js";
import { actorCatalogBody } from "../protocol/actors.js";
import type { BridgeInfo } from "../protocol/types.js";
import type { CommandLog } from "./index.js";

/**
 * `encounter.deploy` — the keeper presses Deploy on a stage of a planned fight.
 *
 * **Feed Foundry, never rebuild it.** That is the whole design in four words, and
 * every decision below falls out of it. Master of Tales holds the *plan*: a fight
 * broken into stages, each stage a list of rows, each row an actor and a number.
 * The moment the plan meets a map, Foundry owns everything — the tokens, the
 * combat, the tracker, the rolls. This module's job is to carry one list across
 * the gap and then get out of the way.
 *
 * So a deploy is three beats, and the middle one is a human:
 *
 *  1. **The tray opens** (src/ui/encounterTray.ts) listing the stage's monsters,
 *     one row per plan row, each row draggable.
 *  2. **The GM drags each onto the map.** Not this module: the GM. A module that
 *     placed tokens itself would have to invent where they go, and "where the
 *     ambush stands" is the one part of an encounter that is entirely about the
 *     picture on the screen. Foundry's canvas already accepts an actor drop and
 *     already does everything that follows from one — prototype token, vision,
 *     the system's own hooks — so the tray hands it exactly the `dataTransfer`
 *     payload a drag from the actor directory would have carried.
 *  3. **Initiative is rolled** for the tokens that just landed, once they all
 *     have. The module ensures a combat exists, adds the new tokens to it, and
 *     asks Foundry to roll.
 *
 * **The wall in beat three: this module never computes an initiative number.**
 * Not a d20, not a dexterity modifier, not a tiebreak. It calls Foundry's own
 * `rollInitiative`, and how a given game system rolls initiative — advantage from
 * a feat, a group roll, alternity's whole other idea of the thing — is Foundry's
 * business and the system's, not a bridge module's. A number invented here would
 * be a number that disagrees with the character sheet on the same screen, which
 * is worse than no number at all. `initiativeTargets` picks *who* to roll for;
 * everything about *what they roll* stays on the far side of that call.
 *
 * **An actorId this world does not know is not an error.** It resolves to
 * nothing, the row shows in the tray marked unresolved, and the rest of the stage
 * deploys normally — the same shrug `image.show` takes about a target id it
 * cannot resolve. A keeper who linked a page to an actor and then deleted the
 * actor has made a mess of one row, not of the evening, and a command that
 * refused the whole stage over it would be the module having an opinion about
 * somebody else's world. The same goes for a row MoT never linked at all: it is a
 * bare name, it appears greyed with a sentence saying so, and it contributes no
 * token and no initiative entry. That is a v1 limitation and the tray says so out
 * loud rather than dropping the row and letting the keeper wonder.
 *
 * Everything with a decision in it is pure and lives above the glue line: the
 * plan, the resolution, the drag payload, the token match, the combatant data and
 * the initiative targets are all *values*, so their shapes are unit tests rather
 * than something a customer discovers at a table.
 */

// ------------------------------------------------------------------ the wire

/** One row of a stage, as MoT sends it. */
export interface EncounterEntryPayload {
  /**
   * An opaque MoT row id. Used for exactly one thing: grouping the tokens that
   * land back onto the row they came from, so the tray can count "2 of 3
   * goblins". It is **never** a user, member or role id — the bridge wire does
   * not carry those, in either direction, ever.
   */
  key?: unknown;
  /** A raw Foundry Actor id, not a uuid. Null for an unlinked one-off mook. */
  actorId?: unknown;
  name?: unknown;
  quantity?: unknown;
}

/** The `encounter.deploy` payload as MoT broadcasts it. */
export interface EncounterDeployPayload {
  encounterName?: unknown;
  stageName?: unknown;
  entries?: unknown;
  rollInitiative?: unknown;
}

// ------------------------------------------------------------------ the plan

export interface EncounterEntry {
  key: string;
  actorId: string | null;
  name: string | null;
  quantity: number;
}

export interface EncounterPlan {
  /** Null when MoT sent nothing usable; the tray then titles itself. */
  encounterName: string | null;
  stageName: string | null;
  entries: EncounterEntry[];
  rollInitiative: boolean;
}

/** A fight's name and a stage's name are labels, not prose. */
export const MAX_ENCOUNTER_NAME_LENGTH = 120;

/** A monster's name, on a row in a tray. */
export const MAX_ENTRY_NAME_LENGTH = 120;

/**
 * The most rows one stage may carry.
 *
 * A stage is a thing a GM reads off a screen while a table waits, so sixty is
 * already well past the point where the tray stops being useful. The cap is here
 * because the list arrives off a socket and is rendered into a window, not
 * because anybody's encounter needs sixty kinds of monster in it.
 */
export const MAX_ENTRIES = 60;

/** Fifty of anything is a siege, and MoT clamps to the same number. */
export const MAX_QUANTITY = 50;

/** Row keys and actor ids are short handles. Anything longer is a payload bug. */
export const MAX_ID_LENGTH = 200;

/**
 * The key a row gets when MoT sent none, or sent one an earlier row already used.
 *
 * The tray counts placements per key, so two rows sharing one key would count
 * each other's goblins. A row's position in the stage is unique by construction,
 * which makes it the obvious fallback.
 */
export const POSITIONAL_KEY_PREFIX = "row-";

/**
 * Validates and normalises an `encounter.deploy` payload. Null means "drop this
 * calmly" — no entries array, or an entries array with nothing usable in it.
 */
export function planEncounterDeploy(payload: unknown): EncounterPlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as EncounterDeployPayload;
  if (!Array.isArray(source.entries)) return null;

  const entries: EncounterEntry[] = [];
  const keys = new Set<string>();

  for (let index = 0; index < source.entries.length; index += 1) {
    if (entries.length >= MAX_ENTRIES) break;
    const entry = planEntry(source.entries[index], index, keys);
    if (!entry) continue;
    entries.push(entry);
    keys.add(entry.key);
  }

  // A stage with nothing deployable in it is a tray with nothing in it, which is
  // a window that appears over somebody's map for no reason. Dropped instead.
  if (entries.length === 0) return null;

  return {
    encounterName: label(source.encounterName, MAX_ENCOUNTER_NAME_LENGTH),
    stageName: label(source.stageName, MAX_ENCOUNTER_NAME_LENGTH),
    entries,
    // `=== true`, and note the direction: **a missing `rollInitiative` is false.**
    // Same rule, and the same reasoning, as `planTargets` refusing to default a
    // missing `targets` to `"all"` — a field MoT failed to send must not be the
    // one that starts a fight in somebody's world. The tray alone is the harmless
    // half; a GM who wanted initiative can press Deploy again.
    rollInitiative: source.rollInitiative === true,
  };
}

/** One row, or null when there is nothing in it to put on a map. */
function planEntry(value: unknown, index: number, taken: ReadonlySet<string>): EncounterEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const source = value as EncounterEntryPayload;
  const actorId = handle(source.actorId);
  const name = label(source.name, MAX_ENTRY_NAME_LENGTH);

  // Neither a linked actor nor a name to write on a row: there is nothing here to
  // show a GM and nothing to drag. Dropped, and the rest of the stage is fine.
  if (actorId === null && name === null) return null;

  return { key: entryKey(source.key, index, taken), actorId, name, quantity: quantity(source.quantity) };
}

function entryKey(value: unknown, index: number, taken: ReadonlySet<string>): string {
  const given = handle(value);
  if (given !== null && !taken.has(given)) return given;
  return `${POSITIONAL_KEY_PREFIX}${index}`;
}

/**
 * A short opaque handle: a MoT row id or a Foundry document id.
 *
 * Control characters are refused because these strings are rendered into a window
 * on the GM's screen and compared against ids read off documents; neither reads
 * well with a newline in the middle. Nothing here goes into a URL, so the
 * refusals stop there — `handoutNodeId` is the one that has to be stricter.
 */
function handle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_ID_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/** Stripped of markup and capped. Foundry and the tray both render these as text. */
function label(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = truncate(stripHtml(value).trim(), max);
  return text === "" ? null : text;
}

/**
 * A count of monsters: a whole number, at least one, at most fifty.
 *
 * A missing or unreadable quantity is **one**, not zero: the row exists because
 * the keeper put a monster on it, and the honest reading of a broken count is
 * "at least this one".
 */
function quantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  return whole > MAX_QUANTITY ? MAX_QUANTITY : whole;
}

// ------------------------------------------------------------ resolving rows

/**
 * An Actor, as this command touches it. Four fields, and the module has no
 * business with a fifth: the tray draws a row from them and Foundry's canvas
 * does the rest from the uuid.
 */
export interface ActorLike {
  id?: string | null;
  uuid?: string | null;
  name?: string | null;
  img?: string | null;
}

/**
 * What became of a row.
 *
 * `ready` — linked to an actor this world has. Draggable, counted, rolled for.
 * `unlinked` — MoT sent no actorId. A bare name; the tray says so.
 * `unresolved` — MoT sent an actorId this world does not know.
 *
 * The last two are shown rather than dropped, and that is the point of having
 * three states instead of a boolean: a keeper looking at a greyed row with a
 * sentence under it knows what to fix, and a keeper looking at a tray with a
 * missing row does not.
 */
export type EntryState = "ready" | "unlinked" | "unresolved";

export interface ResolvedEntry {
  key: string;
  /** What the tray writes on the row. Never empty. */
  name: string;
  quantity: number;
  actorId: string | null;
  /** Foundry's drag handle. Null for anything that cannot be dragged. */
  uuid: string | null;
  img: string | null;
  state: EntryState;
}

/** When a row has neither a name of its own nor an actor to borrow one from. */
export const UNNAMED_ENTRY = "Unnamed";

/**
 * Attaches each row to the actor behind it.
 *
 * `lookup` is `game.actors.get` at the call site and a plain function here, which
 * is what makes every branch below — the missing actor, the actor with no uuid,
 * the lookup that throws on a client mid-teardown — a unit test.
 *
 * **The actor's name wins over MoT's** for a resolved row, which is the opposite
 * of the way `handout.show` breaks its tie and deliberately so. A handout's title
 * describes a page that lives in MoT; a tray row describes the thing that is
 * about to stand on the map, and that thing is the Foundry actor. A keeper who
 * renamed "Goblin" to "Goblin Sharpshooter" in their own world should read the
 * name their own world uses.
 */
export function resolveEntries(
  plan: EncounterPlan,
  lookup: (actorId: string) => ActorLike | null,
): ResolvedEntry[] {
  return plan.entries.map((entry) => {
    if (entry.actorId === null) {
      return {
        key: entry.key,
        name: entry.name ?? UNNAMED_ENTRY,
        quantity: entry.quantity,
        actorId: null,
        uuid: null,
        img: null,
        state: "unlinked",
      };
    }

    const actor = safely(lookup, entry.actorId);
    const uuid = actorUuid(actor);

    if (!actor || uuid === null) {
      return {
        key: entry.key,
        name: entry.name ?? entry.actorId,
        quantity: entry.quantity,
        actorId: entry.actorId,
        uuid: null,
        img: null,
        state: "unresolved",
      };
    }

    return {
      key: entry.key,
      name: nonEmpty(actor.name) ?? entry.name ?? entry.actorId,
      quantity: entry.quantity,
      actorId: nonEmpty(actor.id) ?? entry.actorId,
      uuid,
      img: nonEmpty(actor.img),
      state: "ready",
    };
  });
}

function safely(lookup: (actorId: string) => ActorLike | null, actorId: string): ActorLike | null {
  try {
    return lookup(actorId) ?? null;
  } catch {
    // A collection that is not there yet, on a client still booting. A row that
    // cannot be resolved is an unresolved row, never a thrown deploy.
    return null;
  }
}

/**
 * The actor's uuid, synthesised from its id when the document did not carry one.
 *
 * `Actor.<id>` is not a guess: it is exactly how Foundry spells a world actor's
 * uuid, and the shape `fromUuid` parses. Synthesising it means a plain source
 * object — which is what several Foundry paths and every one of our stubs hands
 * back — still produces a draggable row.
 */
function actorUuid(actor: ActorLike | null | undefined): string | null {
  const uuid = nonEmpty(actor?.uuid);
  if (uuid !== null) return uuid;
  const id = nonEmpty(actor?.id);
  return id === null ? null : `Actor.${id}`;
}

/** How many tokens the GM still has to place for this stage. */
export function expectedTokenCount(entries: readonly ResolvedEntry[]): number {
  return entries.reduce((total, entry) => (entry.state === "ready" ? total + entry.quantity : total), 0);
}

// -------------------------------------------------------------- the drag

/** The `dataTransfer` payload Foundry's canvas drop handler reads for an actor. */
export interface ActorDragData {
  type: "Actor";
  uuid: string;
}

/**
 * The exact JSON a drag from Foundry's own actor directory carries, as a value.
 *
 * `{type: "Actor", uuid}` and nothing else. The canvas's drop handler reads the
 * type, resolves the uuid and builds the token from the actor's prototype — which
 * is why the tray sets *this* rather than trying to describe a token: the
 * prototype is the keeper's own configuration of what that monster looks like on
 * a map, and a module inventing token data would quietly override it.
 *
 * Null when the row has no actor behind it. A row that cannot be dragged is not
 * given a payload that would drop nothing.
 */
export function dragPayload(entry: Pick<ResolvedEntry, "uuid">): ActorDragData | null {
  return entry.uuid === null ? null : { type: "Actor", uuid: entry.uuid };
}

// --------------------------------------------------------- what landed where

/** A TokenDocument, as this command reads one. */
export interface TokenLike {
  id?: string | null;
  actorId?: string | null;
  actor?: { id?: string | null } | null;
  /** A TokenDocument's parent **is** its Scene. */
  parent?: { id?: string | null } | null;
  scene?: { id?: string | null } | string | null;
}

/** One token the GM put on the map, ready to become a combatant. */
export interface Placement {
  /** The tray row it came from, for the per-row counter. */
  key: string | null;
  tokenId: string;
  sceneId: string | null;
  actorId: string | null;
}

/**
 * Which row a freshly created token belongs to, or null.
 *
 * This is how the tray learns a token landed **without observing the drop
 * itself**. A drop is a browser event on a canvas the module does not own; a
 * `createToken` hook is Foundry telling every client what actually happened. The
 * second is the one that is true even when the GM placed the token by some other
 * route entirely — copy/paste, a macro, the actor directory — and counting those
 * is right rather than a loophole: they are on the map, so they are in the fight.
 *
 * `token.actor?.id` first, `token.actorId` second. The former is the resolved
 * document and is what a synthetic (unlinked) token's actor reports; the latter
 * is the raw field, and it is the one still readable on a plain source object or
 * on a token whose actor was deleted out from under it.
 *
 * Only `ready` rows can match. An unlinked row has no actor id, so a token could
 * only reach it by accident.
 */
export function matchPlacedToken(
  entries: readonly ResolvedEntry[],
  token: TokenLike | null | undefined,
): string | null {
  const actorId = tokenActorId(token);
  if (actorId === null) return null;

  return entries.find((entry) => entry.state === "ready" && entry.actorId === actorId)?.key ?? null;
}

/** The placement a created token makes, or null when it carried no id to add. */
export function placementFor(token: TokenLike | null | undefined, key: string | null): Placement | null {
  const tokenId = nonEmpty(token?.id);
  if (tokenId === null) return null;

  return { key, tokenId, sceneId: tokenSceneId(token), actorId: tokenActorId(token) };
}

function tokenActorId(token: TokenLike | null | undefined): string | null {
  return nonEmpty(token?.actor?.id) ?? nonEmpty(token?.actorId);
}

function tokenSceneId(token: TokenLike | null | undefined): string | null {
  const parent = nonEmpty(token?.parent?.id);
  if (parent !== null) return parent;

  const scene = token?.scene;
  if (typeof scene === "string") return nonEmpty(scene);
  return nonEmpty(scene?.id);
}

// ------------------------------------------------------------- the combat

/** A Combatant, as this command reads one. */
export interface CombatantLike {
  id?: string | null;
  tokenId?: string | null;
  /** Null or absent until somebody rolls. A number means this one already has. */
  initiative?: number | null;
}

/** A Combat, as this command touches one. Every mutator is optional; all are guarded. */
export interface CombatLike {
  id?: string | null;
  active?: boolean | null;
  /** Foundry keeps the foreign key; a source object may carry the id as a string. */
  scene?: { id?: string | null } | string | null;
  combatants?: unknown;
  createEmbeddedDocuments?(embeddedName: string, data: Record<string, unknown>[]): unknown;
  rollInitiative?(ids: string[], options?: Record<string, unknown>): unknown;
  rollAll?(options?: Record<string, unknown>): unknown;
  activate?(options?: Record<string, unknown>): unknown;
}

/** A Scene, as far as this command cares: the thing combats are filed under. */
export interface SceneLike {
  id?: string | null;
}

/**
 * The `createEmbeddedDocuments("Combatant", …)` argument, as a value.
 *
 * Deduped by token id, because `createToken` can reach this module more than once
 * for one token on a bad night (a re-render, a duplicate hook registration) and
 * two combatants for one goblin is a fight where one goblin acts twice.
 *
 * `hidden: false` is written explicitly rather than left to whatever Foundry's
 * schema defaults to this major, so the value is pinned by a test. Note what it
 * does and does not mean: it is the *tracker row's* visibility, not the token's.
 * A GM who dropped the ambush in as hidden tokens still has hidden tokens — that
 * flag lives on the token and this module does not touch it.
 *
 * `sceneId` is passed through even when null: a combat created for the active
 * scene already knows which scene it is, and a null here reads as "the combat's
 * own" rather than as a lie about which map the token is on.
 */
export function combatantData(placements: readonly Placement[]): Record<string, unknown>[] {
  const data: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const placement of placements) {
    const tokenId = nonEmpty(placement?.tokenId);
    if (tokenId === null || seen.has(tokenId)) continue;
    seen.add(tokenId);
    data.push({ tokenId, sceneId: placement.sceneId, actorId: placement.actorId, hidden: false });
  }

  return data;
}

/**
 * Which combatants to roll for: the ones standing on the tokens just placed, and
 * **only the ones that have no initiative yet**.
 *
 * That second half is the whole reason this is a function rather than a spread.
 * A stage is often deployed into a fight that is already running — reinforcements
 * arriving in round three, which is exactly what a staged encounter is *for* — and
 * a combat that is already running has a party in it who rolled at the top. A
 * re-roll would reshuffle the turn order under a table mid-round, and it would do
 * it silently. That is precisely the surprise this must not spring: initiative,
 * once rolled, belongs to the person who rolled it.
 *
 * The token id filter is what keeps it honest in the other direction too — a
 * monster the GM added by hand a minute ago is not this stage's business either.
 */
export function initiativeTargets(
  combat: CombatLike | null | undefined,
  tokenIds: readonly string[],
): string[] {
  const wanted = new Set<string>();
  for (const tokenId of tokenIds) {
    const trimmed = nonEmpty(tokenId);
    if (trimmed !== null) wanted.add(trimmed);
  }
  if (wanted.size === 0) return [];

  const ids: string[] = [];
  for (const combatant of collectionValues<CombatantLike>(combat?.combatants)) {
    if (!combatant || typeof combatant !== "object") continue;

    const id = nonEmpty(combatant.id);
    if (id === null || ids.includes(id)) continue;

    const tokenId = nonEmpty(combatant.tokenId);
    if (tokenId === null || !wanted.has(tokenId)) continue;

    // Already rolled. Left alone — see the paragraph above.
    if (typeof combatant.initiative === "number" && Number.isFinite(combatant.initiative)) continue;

    ids.push(id);
  }

  return ids;
}

// -------------------------------------------------------------- foundry glue

/** The one class this command constructs. Everything else it reads off the world. */
export interface CombatApi {
  Combat: { create(data: Record<string, unknown>): unknown };
}

/**
 * Picks the Combat class out of a global scope, namespaced spelling first.
 *
 * Same discipline, and the same reason, as `resolveImagePopout` and
 * `resolveJournalApi`: on v13 both spellings exist and the bare global is a
 * deprecated alias, so the namespace is asked first and the version question is
 * answered by *where the class was found* rather than by parsing `game.version`.
 * Taking the scope as an argument makes the one thing a laptop cannot verify —
 * which spelling a real v13 or v14 client has — a table of cases in a test.
 *
 * There is deliberately no `CONST` on this API. Nothing on the deploy path reads
 * a Foundry constant: `hidden: false` is a literal (see `combatantData`) and
 * everything else is a document field. An unused constant table here would be a
 * thing to keep in step for no reason.
 */
export function resolveCombatApi(scope: unknown): CombatApi | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const documents = (global.foundry as { documents?: Record<string, unknown> } | undefined)?.documents;

  for (const candidate of [documents?.Combat, global.Combat]) {
    if (typeof candidate !== "function") continue;
    if (typeof (candidate as unknown as Record<string, unknown>).create === "function") {
      return { Combat: candidate as unknown as CombatApi["Combat"] };
    }
  }

  return null;
}

/** The two halves of the world this command reads, as `handout.show` reads its own. */
export interface CombatWorld {
  /** `game.combats`. */
  combats(): unknown;
  /** `game.scenes?.active`, or null on a client with no scene up. */
  activeScene(): SceneLike | null;
}

/**
 * The fight already running on this scene, if there is one.
 *
 * An `active` combat wins over a merely-present one: a scene can hold several
 * encounters in Foundry's tracker and exactly one of them is the one the tracker
 * is showing, which is the one the GM means.
 *
 * With **no active scene** only an active combat is adopted, never "the first
 * combat in the world". A client with no scene up cannot tell which map a token
 * landed on, and quietly filing reinforcements into an unrelated fight is worse
 * than making a new one.
 */
export function findSceneCombat(collection: unknown, sceneId: string | null): CombatLike | null {
  const combats = collectionValues<CombatLike>(collection).filter(
    (combat) => combat && typeof combat === "object",
  );

  if (sceneId === null) return combats.find((combat) => combat.active === true) ?? null;

  const here = combats.filter((combat) => combatSceneId(combat) === sceneId);
  return here.find((combat) => combat.active === true) ?? here[0] ?? null;
}

function combatSceneId(combat: CombatLike | null | undefined): string | null {
  const scene = combat?.scene;
  if (typeof scene === "string") return nonEmpty(scene);
  return nonEmpty(scene?.id);
}

/** The `Combat.create` argument. `scene` is omitted rather than nulled when there is none. */
export function combatData(sceneId: string | null): Record<string, unknown> {
  return sceneId === null ? {} : { scene: sceneId };
}

/**
 * The scene's combat, made if it was not there.
 *
 * A new combat is `activate()`d so it becomes the one the tracker is showing —
 * otherwise the GM watches initiative get rolled into a tab they are not looking
 * at. The call is guarded because it is a method on the *document*, and a
 * `create` that resolved to something without one is a client mid-teardown rather
 * than a reason to lose the tokens already on the map.
 */
export async function ensureCombat(
  api: CombatApi,
  world: CombatWorld,
  log?: CommandLog,
): Promise<CombatLike | null> {
  const sceneId = nonEmpty(world.activeScene()?.id);

  const existing = findSceneCombat(world.combats(), sceneId);
  if (existing) return existing;

  const created = ((await api.Combat.create(combatData(sceneId))) as CombatLike | null) ?? null;
  if (!created) return null;

  if (typeof created.activate === "function") {
    try {
      await created.activate();
    } catch (error) {
      log?.debug?.("[masteroftales-bridge] could not activate the new combat", error);
    }
  }

  return created;
}

/** What `deployInitiative` did, for the log line and for the tests. */
export interface DeployOutcome {
  added: number;
  rolled: number;
}

/**
 * Adds the placed tokens to the scene's combat and asks Foundry to roll for them.
 *
 * The only impure function in the file, and every object it hands Foundry came
 * from a pure builder above. Read the last two branches carefully, because they
 * are the wall this whole file is built around: `rollInitiative(ids)` and
 * `rollAll()` are **Foundry's** methods, and what they produce is whatever the
 * game system says initiative is. This module chooses who rolls. It never chooses
 * what they rolled.
 *
 * `rollAll()` is the fallback rather than the first choice because it rolls for
 * every combatant without an initiative, which on a mid-fight deploy is the same
 * set plus anyone the GM had deliberately left unrolled.
 */
export async function deployInitiative(
  api: CombatApi,
  world: CombatWorld,
  placements: readonly Placement[],
  log?: CommandLog,
): Promise<DeployOutcome> {
  const data = combatantData(placements);
  if (data.length === 0) return { added: 0, rolled: 0 };

  const combat = await ensureCombat(api, world, log);
  if (!combat || typeof combat.createEmbeddedDocuments !== "function") {
    log?.warn?.("[masteroftales-bridge] no combat to deploy into; the tokens are placed but unrolled");
    return { added: 0, rolled: 0 };
  }

  await combat.createEmbeddedDocuments("Combatant", data);

  const targets = initiativeTargets(
    combat,
    data.map((row) => String(row.tokenId)),
  );
  if (targets.length === 0) return { added: data.length, rolled: 0 };

  if (typeof combat.rollInitiative === "function") {
    await combat.rollInitiative(targets);
  } else if (typeof combat.rollAll === "function") {
    await combat.rollAll();
  } else {
    log?.warn?.("[masteroftales-bridge] this Foundry's Combat cannot roll initiative; the tokens are in the tracker");
    return { added: data.length, rolled: 0 };
  }

  return { added: data.length, rolled: targets.length };
}

// ------------------------------------------------------ the GM-side handler

export interface EncounterDeployDeps {
  /**
   * The activation gate, read per command. Only the active GM opens a tray — a
   * two-GM table would otherwise get one tray per GM screen for one press, and
   * both of them would count the same tokens landing.
   */
  isActive(): boolean;
  /** `game.actors.get`, called per row. */
  lookupActor(actorId: string): ActorLike | null;
  /** Opens the tray. See src/ui/encounterTray.ts. */
  openTray(plan: EncounterPlan, entries: ResolvedEntry[]): void;
  log?: CommandLog;
}

/**
 * The `encounter.deploy` handler, as the dispatcher wires it.
 *
 * Returns synchronously and throws nothing: the work it starts is a window
 * opening and a hook being registered, and everything expensive happens later, on
 * the GM's own timing, as they drag.
 */
export function createEncounterDeployHandler(deps: EncounterDeployDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planEncounterDeploy(payload);
    if (!plan) {
      deps.log?.debug?.("[masteroftales-bridge] dropping an encounter.deploy with nothing deployable in it", payload);
      return;
    }

    const entries = resolveEntries(plan, (actorId) => deps.lookupActor(actorId));

    try {
      deps.openTray(plan, entries);
    } catch (error) {
      // A tray that would not open is a stage the GM places by hand. Never an
      // exception into the dispatcher, which also has to keep delivering session
      // state for the rest of the night.
      deps.log?.warn?.("[masteroftales-bridge] could not open the encounter tray", error);
    }
  };
}

// ----------------------------------------------------- the actor catalog

export interface ActorsRequestDeps {
  /**
   * The activation gate again, and here it is load-bearing in a second way:
   * **only the active GM answers.** The catalog POST rides the bridge token,
   * which is client-scoped and lives in exactly one browser — and two GMs each
   * posting five hundred rows for one request would be two writes of the same
   * list.
   */
  isActive(): boolean;
  /** `game.actors`, read per request. */
  actors(): unknown;
  /** The same identity block every batch and heartbeat carries. */
  bridgeInfo(): BridgeInfo;
  /** `POST /api/v1/bridge/actors`, with the bearer token. */
  post(body: ActorCatalogBody): Promise<unknown>;
  log?: CommandLog;
}

/**
 * The `actors.request` handler — MoT asking for this world's actor catalog.
 *
 * **The payload is ignored entirely, whatever it contains.** It is a doorbell.
 * Filtering, paging or searching a catalog of at most five hundred rows is the
 * server's job, done once, over a list it already has, rather than a protocol
 * this module has to keep in step across two repos shipping on different days.
 *
 * Fire-and-forget, like every other handler here: the dispatcher is synchronous
 * and must not wait on a POST, and a catalog that could not be delivered is a
 * picker with a stale list in it — worth a warning, never worth an exception.
 */
export function createActorsRequestHandler(deps: ActorsRequestDeps): (payload?: unknown) => void {
  return (): void => {
    if (!deps.isActive()) return;

    let body: ActorCatalogBody;
    try {
      body = actorCatalogBody(deps.actors(), deps.bridgeInfo());
    } catch (error) {
      // A client mid-teardown, where `game` has gone.
      deps.log?.debug?.("[masteroftales-bridge] could not build the actor catalog", error);
      return;
    }

    void Promise.resolve(deps.post(body)).catch((error: unknown) => {
      deps.log?.warn?.("[masteroftales-bridge] could not send the actor catalog to Master of Tales", error);
    });
  };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
