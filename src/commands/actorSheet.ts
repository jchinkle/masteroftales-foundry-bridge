import type { ActorSheetBody, ActorSheetFailure } from "../protocol/actorSheet.js";
import {
  actorSheetBody,
  actorSheetFailure,
  MAX_SHEET_BYTES,
  readSheetSource,
  sheetBodyBytes,
} from "../protocol/actorSheet.js";
import type { CommandLog } from "./index.js";

/**
 * `actor.sheet.request` — Master of Tales asking this world for one creature's
 * sheet, so a keeper can fill a statblock in without typing it twice.
 *
 * It is `actors.request`'s little brother and it points the same way: the answer
 * travels *back* to MoT as a POST rather than into Foundry. The difference is
 * the argument list. A catalog request is a doorbell and its payload is ignored
 * entirely; this one names an actor and carries a correlation id, because a
 * keeper may press the button twice and MoT has to know which sheet it is
 * looking at.
 *
 * Three decisions worth stating, because each is the sort of thing a later
 * reader would tidy into a bug:
 *
 *  1. **`requestId` is opaque and echoed verbatim.** MoT minted it; this module
 *     never parses it, never invents one, and never assumes it means anything.
 *     It is emphatically not a MoT record id — the bridge wire does not carry
 *     those, in either direction, ever.
 *  2. **Nothing is interpreted.** The sheet goes home near enough raw (see
 *     protocol/actorSheet.ts). What an armour class *is* belongs to MoT's
 *     game-system registry, and a module that worked it out here would be a
 *     second implementation of 5e shipping on a different day from the first.
 *  3. **A failure is a notification and no report.** The keeper is standing in
 *     MoT with a dialog open; a request that cannot be answered has to say so on
 *     the screen they are looking at *and* leave MoT's side unresolved, rather
 *     than posting an empty sheet that would import as a blank creature over the
 *     one they already had.
 *
 * GM-side only, like every other inbound command: the bridge socket lives in one
 * browser (src/activation.ts), and so does the token the report rides on.
 */

// ------------------------------------------------------------------ the wire

/** The `actor.sheet.request` payload as MoT broadcasts it. */
export interface ActorSheetRequestPayload {
  /** Opaque correlation string. Echoed back verbatim and used for nothing else. */
  requestId?: unknown;
  /** Foundry's own actor id, straight out of the catalog this module reported. */
  actorId?: unknown;
}

// ------------------------------------------------------------------ the plan

export interface ActorSheetPlan {
  requestId: string;
  actorId: string;
}

/** Both ids are short handles. Anything longer is a payload bug. */
export const MAX_HANDLE_LENGTH = 200;

/**
 * Validates and normalises an `actor.sheet.request` payload. Null means "drop
 * this calmly": this command turns on **both** fields, unlike `actor.create`
 * which can fall back on a name. Without a `requestId` there is nothing to
 * report an answer against; without an `actorId` there is no creature to report.
 */
export function planActorSheetRequest(payload: unknown): ActorSheetPlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as ActorSheetRequestPayload;

  const requestId = handle(source.requestId);
  const actorId = handle(source.actorId);
  if (requestId === null || actorId === null) return null;

  return { requestId, actorId };
}

/**
 * A short opaque handle. Control characters are refused because these strings go
 * back on the wire; nothing here is ever parsed for meaning.
 */
function handle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_HANDLE_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

// ------------------------------------------------------------- what to say

/**
 * The reason on a notification **and** on the refusal posted home, which are
 * deliberately the same string.
 *
 * The keeper may be looking at either screen — Foundry on the second monitor,
 * Master of Tales on the first — and reading two different sentences about one
 * failure is how somebody concludes that two things went wrong.
 */
export const REASON_NO_ACTOR = "that creature is not in this world.";
export const REASON_TOO_LARGE = "that creature's sheet is too large to send.";
export const REASON_REPORT_FAILED = "Master of Tales did not accept the sheet.";
export const REASON_UNEXPECTED = "something in this world refused to be read.";

/** The notification voice: one sentence, and why. */
export function failureMessage(reason: string): string {
  return `Could not send a statblock to Master of Tales: ${reason}`;
}

// ----------------------------------------------------- the GM-side handler

export interface ActorSheetDeps {
  /**
   * The activation gate, read per command. Only the active GM answers: two GM
   * clients answering one press would POST two sheets against one request, and
   * the second would be dropped by MoT as an id it has already spent.
   */
  isActive(): boolean;
  /** `game.actors.get(actorId)`, or null. Called per command, never cached. */
  lookupActor(actorId: string): unknown;
  /** `game.system.id`. Read per command like every other global. */
  systemId(): string;
  /**
   * Which item types are worth sending, from the system adapter. Null keeps
   * everything, which is what a system this module has never met answers.
   */
  itemTypes(): readonly string[] | null;
  /**
   * `POST /api/v1/bridge/actor_sheets`, with the bearer token. Takes either
   * shape — the sheet, or the refusal that goes in its place.
   */
  report(body: ActorSheetBody | ActorSheetFailure): Promise<unknown>;
  /** A Foundry ui notification, in the module's own voice. */
  notify(level: "info" | "warn" | "error", message: string): void;
  log?: CommandLog;
}

/**
 * The `actor.sheet.request` handler, as the dispatcher wires it.
 *
 * Returns synchronously — the dispatcher is synchronous, and a command carrying
 * a network round trip must not hold up the next frame off the socket. Nothing
 * here ever throws into the dispatcher, and nothing here ever leaves an
 * unhandled rejection.
 */
export function createActorSheetHandler(deps: ActorSheetDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planActorSheetRequest(payload);
    if (!plan) {
      // No ids means no answer can be matched to this request. Dropped quietly
      // rather than notified: nobody at this table asked for it.
      deps.log?.debug?.("[masteroftales-bridge] dropping an actor.sheet.request with no ids in it");
      return;
    }

    void run(deps, plan).catch((error: unknown) => {
      deps.log?.warn?.("[masteroftales-bridge] could not send an actor sheet to Master of Tales", error);
      announce(deps, "error", failureMessage(REASON_UNEXPECTED));
    });
  };
}

async function run(deps: ActorSheetDeps, plan: ActorSheetPlan): Promise<void> {
  const source = readSheetSource(deps.lookupActor(plan.actorId));
  if (source === null) {
    // The catalog MoT picked from is a snapshot; the actor may have been
    // deleted since.
    deps.log?.warn?.(`[masteroftales-bridge] no actor ${plan.actorId} in this world`);
    await refuse(deps, plan, REASON_NO_ACTOR);
    return;
  }

  const body = actorSheetBody(source, {
    requestId: plan.requestId,
    actorId: plan.actorId,
    systemId: deps.systemId(),
    itemTypes: deps.itemTypes(),
  });

  // The trimmer takes descriptions and then whole items; a `system` object
  // alone over the cap is the sheet it cannot save. Posting it anyway would be
  // a server refusal MoT can only report as a timeout, so the refusal is sent
  // in its place — same door, honest reason.
  if (sheetBodyBytes(body) > MAX_SHEET_BYTES) {
    deps.log?.warn?.(`[masteroftales-bridge] actor ${plan.actorId} is too large to send`);
    await refuse(deps, plan, REASON_TOO_LARGE);
    return;
  }

  try {
    await deps.report(body);
  } catch (error) {
    deps.log?.warn?.("[masteroftales-bridge] Master of Tales refused an actor sheet", error);
    announce(deps, "error", failureMessage(REASON_REPORT_FAILED));
    return;
  }

  deps.log?.debug?.(`[masteroftales-bridge] sent the sheet for actor ${plan.actorId}`);
}

/**
 * A failure the keeper can see **wherever they are looking**: a toast on this
 * screen, and an answer posted home so the dialog they are actually watching
 * says the same sentence instead of spinning for twelve seconds.
 *
 * The post is best-effort. If it cannot get through, the toast has already
 * happened and MoT's own timeout is the fallback it always was — this path must
 * not be able to throw, because it is the path that reports trouble.
 */
async function refuse(deps: ActorSheetDeps, plan: ActorSheetPlan, reason: string): Promise<void> {
  announce(deps, "error", failureMessage(reason));

  try {
    await deps.report(actorSheetFailure(plan.requestId, plan.actorId, reason));
  } catch (error) {
    deps.log?.debug?.("[masteroftales-bridge] could not tell Master of Tales why", error);
  }
}

/**
 * A notification that cannot itself become the failure — `commands/actorCreate.ts`'s
 * rule, and this is the other path that *reports* trouble.
 */
function announce(deps: ActorSheetDeps, level: "info" | "warn" | "error", message: string): void {
  try {
    deps.notify(level, message);
  } catch (error) {
    deps.log?.debug?.("[masteroftales-bridge] could not show a notification", error);
  }
}
