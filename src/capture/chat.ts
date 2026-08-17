import type { AdapterContext, SystemAdapter } from "../adapters/index.js";
import { toExt } from "../adapters/index.js";
import { chatMessageKey, rollKey } from "../protocol/keys.js";
import type {
  ChatPostedPayload,
  Envelope,
  RollDie,
  RollMadePayload,
  Speaker,
} from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import { stripHtml, truncate } from "./html.js";
import { isBridgeOrigin } from "./loopGuard.js";

/**
 * `createChatMessage` capture.
 *
 * The hook is a core *document* hook on purpose: it fires on every client, after
 * the write, in every game system. System roll hooks (`dnd5e.rollAttack` and
 * friends) fire only on the originating client and change shape between majors.
 *
 * Everything below the hook registration is a pure function of a message-shaped
 * object, which is why the interesting half of this file is testable without a
 * Foundry running.
 */

/** Text longer than this is truncated here, well inside the server's 16KB event cap. */
export const MAX_TEXT_LENGTH = 4_000;

export interface CaptureContext {
  /** Resolves an author id to a user. Returns null when the user has been deleted. */
  resolveUser(userId: string): FoundryUser | null | undefined;
  adapter: SystemAdapter;
  adapterContext: AdapterContext;
  /** Injected clock, used only when a message carries no timestamp of its own. */
  now(): Date;
}

/**
 * One chat message in, zero or more envelopes out.
 *
 * Zero happens for three reasons, all of them deliberate:
 *   - the message is MoT's own echo (loop guard),
 *   - it has no id, so no stable idempotency key could be minted and a retry
 *     would duplicate it,
 *   - it has no rolls and no text once the HTML is stripped, which is a card or
 *     a decoration rather than something that happened at the table.
 */
export function buildChatEvents(
  message: FoundryChatMessage | null | undefined,
  context: CaptureContext,
): Envelope[] {
  if (!message) return [];
  if (isBridgeOrigin(message)) return [];

  const messageId = message.id ?? null;
  if (!messageId) return [];

  const ts = messageTimestamp(message, context.now());
  const speaker = buildSpeaker(message, context);

  const rolls = message.rolls ?? [];
  if (rolls.length > 0) {
    return rolls.map((roll, index) => {
      const payload: RollMadePayload = {
        formula: String(roll?.formula ?? ""),
        total: normalizeTotal(roll?.total),
        dice: buildDice(roll),
        // The server recomputes totals from the formula anyway, so a guessed
        // modifier would be a wrong answer nobody asked for. Slice 3's adapter
        // can fill it where the system actually knows.
        modifier: null,
        flavor: nullableText(message.flavor),
        speaker,
      };

      const envelope: Envelope<RollMadePayload> = {
        v: PROTOCOL_VERSION,
        type: "roll.made",
        id: rollKey(messageId, index, rolls.length),
        ts,
        payload,
      };

      const ext = toExt(context.adapter.rollExt(message, roll, context.adapterContext));
      if (ext) envelope.ext = ext;
      return envelope;
    });
  }

  const text = truncate(stripHtml(message.content), MAX_TEXT_LENGTH);
  if (text === "") return [];

  const payload: ChatPostedPayload = {
    text,
    speaker,
    // Whispers *are* captured — the server files them as `min_role: :editor`, so
    // a player-role member never receives them and the GM still gets the full
    // record of their own night.
    private: (message.whisper?.length ?? 0) > 0,
  };

  const envelope: Envelope<ChatPostedPayload> = {
    v: PROTOCOL_VERSION,
    type: "chat.posted",
    id: chatMessageKey(messageId),
    ts,
    payload,
  };

  const ext = toExt(context.adapter.chatExt(message, context.adapterContext));
  if (ext) envelope.ext = ext;
  return [envelope];
}

/**
 * v13 renamed `ChatMessage#user` to `#author`, and either field may hold the
 * User document or a bare id depending on how the hook was reached. All four
 * combinations are live in the wild, so all four are handled here rather than in
 * three call sites.
 */
export function authorId(message: FoundryChatMessage): string | null {
  const candidate = message.author ?? message.user ?? message.speaker?.user ?? null;
  if (!candidate) return null;
  if (typeof candidate === "string") return candidate;
  return candidate.id ?? null;
}

export function buildSpeaker(message: FoundryChatMessage, context: CaptureContext): Speaker {
  const id = authorId(message);
  const inlineUser = typeof message.author === "object" && message.author !== null ? message.author : null;
  const user = inlineUser ?? (id ? context.resolveUser(id) ?? null : null);

  return {
    // The alias is what the table actually saw above the message — a character
    // name, "GM", or a token name. It wins over the account name every time.
    name: nonEmpty(message.speaker?.alias) ?? nonEmpty(user?.name) ?? "Unknown",
    actorUuid: nonEmpty(message.speaker?.actor) ?? null,
    tokenUuid: nonEmpty(message.speaker?.token) ?? null,
    gm: user?.isGM ?? false,
  };
}

function buildDice(roll: FoundryRoll | null | undefined): RollDie[] {
  const dice = roll?.dice ?? [];
  return dice.map((die) => ({
    sides: Number(die?.faces ?? 0),
    results: (die?.results ?? []).map((result) => ({
      value: Number(result?.result ?? 0),
      // `active` is the v13+ field; `discarded` is belt and braces for terms that
      // set one and not the other. A result is kept unless something says otherwise.
      kept: result?.active !== false && result?.discarded !== true,
    })),
  }));
}

function messageTimestamp(message: FoundryChatMessage, fallback: Date): string {
  const raw = message.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return new Date(raw).toISOString();
  }
  return fallback.toISOString();
}

function normalizeTotal(total: unknown): number | null {
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

function nullableText(value: string | null | undefined): string | null {
  const text = stripHtml(value);
  return text === "" ? null : truncate(text, MAX_TEXT_LENGTH);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// ------------------------------------------------------------ hook registration

export interface ChatCaptureDeps {
  hooks: Pick<FoundryHooks, "on">;
  /** The activation gate, re-read per event — see src/activation.ts. */
  isActive(): boolean;
  context(): CaptureContext;
  emit(envelope: Envelope): void;
  log?: { debug?(message: string, ...rest: unknown[]): void };
}

/**
 * The entire Foundry-touching half of chat capture: one hook, one gate, one
 * loop. Everything with a decision in it lives above, in pure functions.
 *
 * Returns the hook id so a teardown can unregister it.
 */
export function registerChatCapture(deps: ChatCaptureDeps): number {
  return deps.hooks.on("createChatMessage", (message: FoundryChatMessage) => {
    // Checked here, on every message, rather than once at startup: `activeGM`
    // moves when a GM drops off or reconnects, and this client can be promoted
    // or demoted mid-session.
    if (!deps.isActive()) return;

    const events = buildChatEvents(message, deps.context());
    for (const event of events) deps.emit(event);
  });
}
