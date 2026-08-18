import { escapeHtmlWithBreaks, truncate } from "../capture/html.js";
import { bridgeOriginFlags } from "../capture/loopGuard.js";
import type { CommandLog } from "./index.js";
import { speakerAlias } from "./index.js";

/**
 * `chat.post` — a note MoT marked "announce" appears in Foundry chat.
 *
 * The whole feature is one `ChatMessage.create`, and the only two decisions in
 * it are worth the file: the text is **escaped, never injected** (Foundry
 * renders `content` as HTML; MoT sends a string), and the message carries the
 * origin flag so our own `createChatMessage` capture drops it instead of posting
 * it straight back to MoT as a `chat.posted`.
 */

/** A note is a paragraph, not a document. Foundry's own soft limit is far higher. */
export const MAX_CHAT_LENGTH = 4_000;

export interface ChatPostPayload {
  text?: unknown;
  speaker?: { alias?: unknown } | null;
}

export interface ChatPlan {
  /** Already escaped and newline-converted — ready to be `content`. */
  content: string;
  /** Trimmed; rendered by Foundry's own (escaping) template, so not escaped. */
  alias: string | null;
}

/**
 * Validates and normalises a `chat.post` payload. Null means "nothing to say" —
 * a missing, non-string or whitespace-only text — and is dropped calmly.
 */
export function planChatPost(payload: unknown): ChatPlan | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const source = payload as ChatPostPayload;
  if (typeof source.text !== "string") return null;

  const trimmed = source.text.trim();
  if (trimmed === "") return null;

  return {
    // Truncate the *plain* text, then escape: cutting escaped text can land
    // inside an entity and leave `&am` on the card.
    content: escapeHtmlWithBreaks(truncate(trimmed, MAX_CHAT_LENGTH)),
    alias: speakerAlias(source.speaker?.alias),
  };
}

/**
 * The `ChatMessage.create` argument. Pure, because the origin flag on it is what
 * stops the echo loop and that deserves a test of its own.
 */
export function chatMessageData(plan: ChatPlan): Record<string, unknown> {
  const data: Record<string, unknown> = { content: plan.content, flags: bridgeOriginFlags() };
  // Omitted rather than null: Foundry fills an absent speaker with the current
  // user, which is the right answer when MoT did not name one.
  if (plan.alias !== null) data.speaker = { alias: plan.alias };
  return data;
}

/** The slice of `ChatMessage` this module touches. */
export interface ChatMessageClass {
  create(data: Record<string, unknown>, options?: Record<string, unknown>): unknown;
}

/**
 * Picks the ChatMessage document class out of a global scope.
 *
 * `CONFIG.ChatMessage.documentClass` first, because that is the one Foundry
 * itself instantiates and the one a system may have subclassed; then the
 * v13-and-v14 global; then the v13+ `foundry.documents` namespace. Pure, and
 * takes the scope as an argument, for the same reason `resolveDiceApi` does.
 */
export function resolveChatMessageClass(scope: unknown): ChatMessageClass | null {
  if (!scope || typeof scope !== "object") return null;

  const global = scope as Record<string, unknown>;
  const config = global.CONFIG as { ChatMessage?: { documentClass?: unknown } } | undefined;
  const documents = (global.foundry as { documents?: Record<string, unknown> } | undefined)?.documents;

  for (const candidate of [config?.ChatMessage?.documentClass, global.ChatMessage, documents?.ChatMessage]) {
    if (typeof candidate !== "function") continue;
    const documentClass = candidate as unknown as ChatMessageClass;
    if (typeof documentClass.create === "function") return documentClass;
  }

  return null;
}

export interface ChatPostDeps {
  /** The activation gate, read per command — only the active GM posts. */
  isActive(): boolean;
  /** Resolves the Foundry ChatMessage class. Called per command, not cached. */
  chatMessage(): ChatMessageClass | null;
  log?: CommandLog;
}

/** The `chat.post` renderer, as the dispatcher wires it. Never throws. */
export function createChatPostHandler(deps: ChatPostDeps): (payload: unknown) => void {
  return (payload: unknown): void => {
    if (!deps.isActive()) return;

    const plan = planChatPost(payload);
    if (!plan) {
      deps.log?.debug?.("[masteroftales-bridge] dropping a chat.post with no text in it", payload);
      return;
    }

    const ChatMessageClass = deps.chatMessage();
    if (!ChatMessageClass) {
      deps.log?.debug?.("[masteroftales-bridge] no Foundry ChatMessage class available; dropping chat.post");
      return;
    }

    try {
      void Promise.resolve(ChatMessageClass.create(chatMessageData(plan))).catch((error: unknown) => {
        deps.log?.debug?.("[masteroftales-bridge] chat.post could not be posted", error);
      });
    } catch (error) {
      deps.log?.debug?.("[masteroftales-bridge] chat.post could not be posted", error);
    }
  };
}
