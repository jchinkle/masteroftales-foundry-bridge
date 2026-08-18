import { describe, expect, it } from "vitest";
import { buildChatEvents } from "../src/capture/chat.js";
import {
  chatMessageData,
  createChatPostHandler,
  MAX_CHAT_LENGTH,
  planChatPost,
  resolveChatMessageClass,
} from "../src/commands/chat.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { captureContext, chatMessage, createChatMessageClass, createLog, flushMicrotasks } from "./stubs.js";

describe("planChatPost", () => {
  it("normalises the ordinary case", () => {
    expect(planChatPost({ text: "The gate grinds open.", speaker: { alias: "Narrator" } })).toEqual({
      content: "The gate grinds open.",
      alias: "Narrator",
    });
  });

  it("ESCAPES the text — Foundry renders content as HTML and MoT sends a string", () => {
    const plan = planChatPost({ text: '<img src=x onerror="alert(1)"> & <b>bold</b>' });
    expect(plan?.content).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(plan?.content).not.toContain("<img");
  });

  it("turns newlines into breaks, after escaping, so they cannot be forged", () => {
    const plan = planChatPost({ text: "One\nTwo\r\nThree" });
    expect(plan?.content).toBe("One<br>Two<br>Three");
  });

  it("trims the text and the alias", () => {
    const plan = planChatPost({ text: "  a note  ", speaker: { alias: "  GM  " } });
    expect(plan?.content).toBe("a note");
    expect(plan?.alias).toBe("GM");
  });

  it("survives a missing, null or non-string speaker", () => {
    expect(planChatPost({ text: "hi" })?.alias).toBeNull();
    expect(planChatPost({ text: "hi", speaker: null })?.alias).toBeNull();
    expect(planChatPost({ text: "hi", speaker: { alias: 7 } })?.alias).toBeNull();
    expect(planChatPost({ text: "hi", speaker: { alias: "   " } })?.alias).toBeNull();
  });

  it("caps a pathological note", () => {
    const plan = planChatPost({ text: "x".repeat(MAX_CHAT_LENGTH + 500) });
    expect(plan?.content).toHaveLength(MAX_CHAT_LENGTH);
    expect(plan?.content.endsWith("…")).toBe(true);
  });

  it("truncates the PLAIN text, so a cut cannot land inside an escape sequence", () => {
    const plan = planChatPost({ text: `${"&".repeat(MAX_CHAT_LENGTH + 10)}` });
    expect(plan?.content).not.toMatch(/&am(p)?$/);
    expect(plan?.content.endsWith("…")).toBe(true);
  });

  it("drops a payload with nothing to say", () => {
    expect(planChatPost({ text: "" })).toBeNull();
    expect(planChatPost({ text: "   " })).toBeNull();
    expect(planChatPost({ text: null })).toBeNull();
    expect(planChatPost({ text: 42 })).toBeNull();
    expect(planChatPost({})).toBeNull();
  });

  it("drops a payload that is not an object at all", () => {
    expect(planChatPost(null)).toBeNull();
    expect(planChatPost(undefined)).toBeNull();
    expect(planChatPost("a note")).toBeNull();
    expect(planChatPost(["a note"])).toBeNull();
  });

  it("is a pure function of the payload — same input, same plan", () => {
    const source = { text: "The gate grinds open.", speaker: { alias: "Narrator" } };
    expect(planChatPost(source)).toEqual(planChatPost(source));
  });
});

describe("chatMessageData", () => {
  it("stamps the origin flag", () => {
    const data = chatMessageData({ content: "hi", alias: "GM" });
    expect(data.flags).toEqual({ [MODULE_ID]: { origin: "mot" } });
    expect(data.content).toBe("hi");
    expect(data.speaker).toEqual({ alias: "GM" });
  });

  it("omits the speaker when MoT named none, so Foundry fills it in", () => {
    expect("speaker" in chatMessageData({ content: "hi", alias: null })).toBe(false);
  });
});

describe("resolveChatMessageClass", () => {
  const configured = Object.assign(function Configured() {}, { create: () => Promise.resolve(null) });
  const global = Object.assign(function Global() {}, { create: () => Promise.resolve(null) });

  it("prefers CONFIG.ChatMessage.documentClass — the one a system may have subclassed", () => {
    const resolved = resolveChatMessageClass({
      CONFIG: { ChatMessage: { documentClass: configured } },
      ChatMessage: global,
    });
    expect(resolved).toBe(configured);
  });

  it("falls back to the global, then to the v13+ documents namespace", () => {
    expect(resolveChatMessageClass({ ChatMessage: global })).toBe(global);
    expect(resolveChatMessageClass({ foundry: { documents: { ChatMessage: global } } })).toBe(global);
  });

  it("returns null off a Foundry", () => {
    expect(resolveChatMessageClass(null)).toBeNull();
    expect(resolveChatMessageClass("nope")).toBeNull();
    expect(resolveChatMessageClass({})).toBeNull();
    // Something named ChatMessage that cannot create a message is not one.
    expect(resolveChatMessageClass({ ChatMessage: function Bare() {} })).toBeNull();
  });
});

describe("createChatPostHandler", () => {
  it("creates one chat message from the given alias", async () => {
    const chat = createChatMessageClass();
    const render = createChatPostHandler({ isActive: () => true, chatMessage: () => chat.ChatMessage });

    render({ text: "The gate grinds open.", speaker: { alias: "Narrator" } });
    await flushMicrotasks();

    expect(chat.created).toHaveLength(1);
    expect(chat.created[0]?.data).toEqual({
      content: "The gate grinds open.",
      speaker: { alias: "Narrator" },
      flags: { [MODULE_ID]: { origin: "mot" } },
    });
  });

  it("does NOTHING on a client that is not the active GM", () => {
    const chat = createChatMessageClass();
    const render = createChatPostHandler({ isActive: () => false, chatMessage: () => chat.ChatMessage });
    render({ text: "The gate grinds open." });
    expect(chat.created).toHaveLength(0);
  });

  it("drops a malformed payload calmly, at debug volume", () => {
    const chat = createChatMessageClass();
    const log = createLog();
    const render = createChatPostHandler({ isActive: () => true, chatMessage: () => chat.ChatMessage, log });

    render({ text: "" });
    render(null);
    render({ speaker: { alias: "GM" } });

    expect(chat.created).toHaveLength(0);
    expect(log.lines.debug).toHaveLength(3);
    expect(log.lines.warn).toHaveLength(0);
  });

  it("drops the command when there is no Foundry to post it with", () => {
    const log = createLog();
    const render = createChatPostHandler({ isActive: () => true, chatMessage: () => null, log });
    expect(() => render({ text: "hi" })).not.toThrow();
    expect(log.lines.debug).toHaveLength(1);
  });

  it("swallows a create rejection rather than leaving it unhandled", async () => {
    const chat = createChatMessageClass({ rejects: true });
    const log = createLog();
    const render = createChatPostHandler({ isActive: () => true, chatMessage: () => chat.ChatMessage, log });

    render({ text: "hi" });
    await flushMicrotasks();
    expect(log.lines.debug).toHaveLength(1);
  });
});

describe("the echo guard on chat.post", () => {
  it("does not capture the chat message chat.post just created", () => {
    const chat = createChatMessageClass();
    const render = createChatPostHandler({ isActive: () => true, chatMessage: () => chat.ChatMessage });
    render({ text: "The gate grinds open.", speaker: { alias: "Narrator" } });

    const created = chat.created[0]?.data ?? {};
    const echoed = chatMessage({
      flags: created.flags as Record<string, unknown>,
      content: created.content as string,
    });

    expect(buildChatEvents(echoed, captureContext())).toEqual([]);
  });

  it("still captures the same sentence typed by a human", () => {
    const typed = chatMessage({ flags: {}, content: "The gate grinds open." });
    expect(buildChatEvents(typed, captureContext())).toHaveLength(1);
  });
});
