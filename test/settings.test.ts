import { describe, expect, it, vi } from "vitest";
import { MODULE_ID } from "../src/protocol/version.js";
import {
  DEFAULT_SERVER_URL,
  describeHandshake,
  isConfigured,
  readSettings,
  registerSettings,
  SETTINGS,
  testConnection,
} from "../src/settings.js";
import { createGame } from "./stubs.js";

describe("registerSettings", () => {
  function register() {
    const game = createGame();
    registerSettings({ onChange: vi.fn(), notify: vi.fn() }, game);
    return game;
  }

  it("registers all three settings under the module's namespace", () => {
    const game = register();
    expect(game.registered.map((s) => s.key)).toEqual([SETTINGS.serverUrl, SETTINGS.apiToken, SETTINGS.enabled]);
    expect(game.registered.every((s) => s.namespace === MODULE_ID)).toBe(true);
  });

  /**
   * The single most important assertion in this file. A world-scoped token is
   * readable from every player's browser console, the server cannot detect the
   * mistake, and no amount of documentation undoes it.
   */
  it("registers the API token as CLIENT scope, never world", () => {
    const game = register();
    const token = game.registered.find((s) => s.key === SETTINGS.apiToken);
    expect(token?.data.scope).toBe("client");
  });

  it("says in the hint what a leaked token could do, so a customer can judge for themselves", () => {
    const game = register();
    const hint = String(game.registered.find((s) => s.key === SETTINGS.apiToken)?.data.hint);
    expect(hint).toMatch(/console/i);
    expect(hint).toMatch(/live session/i);
  });

  it("keeps the server URL world-scoped, which is safe and saves every GM retyping it", () => {
    const game = register();
    expect(game.registered.find((s) => s.key === SETTINGS.serverUrl)?.data.scope).toBe("world");
    expect(game.registered.find((s) => s.key === SETTINGS.enabled)?.data.scope).toBe("world");
  });

  it("explains the https requirement in the server URL hint", () => {
    const game = register();
    const hint = String(game.registered.find((s) => s.key === SETTINGS.serverUrl)?.data.hint);
    expect(hint).toMatch(/https/);
    expect(hint).toMatch(/localhost/);
  });

  it("defaults to the production server and to enabled", () => {
    const game = register();
    expect(game.settings.get(MODULE_ID, SETTINGS.serverUrl)).toBe(DEFAULT_SERVER_URL);
    expect(game.settings.get(MODULE_ID, SETTINGS.enabled)).toBe(true);
    expect(game.settings.get(MODULE_ID, SETTINGS.apiToken)).toBe("");
  });

  it("notifies and reconnects when an invalid server URL is entered", () => {
    const game = createGame();
    const onChange = vi.fn();
    const notify = vi.fn();
    registerSettings({ onChange, notify }, game);

    const urlSetting = game.registered.find((s) => s.key === SETTINGS.serverUrl);
    (urlSetting?.data.onChange as (v: string) => void)("http://example.com");

    expect(notify).toHaveBeenCalledWith("error", expect.stringMatching(/mixed content/i));
    expect(onChange).toHaveBeenCalled();
  });

  it("does not complain about a valid URL", () => {
    const game = createGame();
    const notify = vi.fn();
    registerSettings({ onChange: vi.fn(), notify }, game);
    const urlSetting = game.registered.find((s) => s.key === SETTINGS.serverUrl);
    (urlSetting?.data.onChange as (v: string) => void)("https://mot.example");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("readSettings", () => {
  it("reads and trims what the customer pasted", () => {
    const game = createGame({
      settings: {
        [`${MODULE_ID}.${SETTINGS.serverUrl}`]: "  https://mot.example  ",
        [`${MODULE_ID}.${SETTINGS.apiToken}`]: " mtb_abc\n",
        [`${MODULE_ID}.${SETTINGS.enabled}`]: true,
      },
    });
    expect(readSettings(game)).toEqual({
      serverUrl: "https://mot.example",
      apiToken: "mtb_abc",
      enabled: true,
    });
  });

  it("treats an unset enabled flag as enabled", () => {
    const game = createGame();
    expect(readSettings(game).enabled).toBe(true);
  });
});

describe("isConfigured", () => {
  it("is true only with an enabled module, a token and a usable URL", () => {
    expect(isConfigured({ serverUrl: "https://mot.example", apiToken: "mtb_a", enabled: true })).toBe(true);
  });

  it("is false without a token, disabled, or with an unusable URL", () => {
    expect(isConfigured({ serverUrl: "https://mot.example", apiToken: "", enabled: true })).toBe(false);
    expect(isConfigured({ serverUrl: "https://mot.example", apiToken: "mtb_a", enabled: false })).toBe(false);
    expect(isConfigured({ serverUrl: "http://example.com", apiToken: "mtb_a", enabled: true })).toBe(false);
  });
});

describe("describeHandshake", () => {
  /** The exact 200 body the server sends: {project, session|null, protocol}. */
  const ok = (over: Record<string, unknown> = {}) => ({
    project: { id: "p1", name: "The Shattered Realms" },
    session: { status: "live", id: "s1", name: "Session 12" },
    protocol: { v: 1 },
    ...over,
  });

  it("names the project and the live session on success", () => {
    const outcome = describeHandshake(200, ok());
    expect(outcome.ok).toBe(true);
    // Reading the project's name back is what makes the test a test: the most
    // likely mistake is a right-looking token for the wrong world.
    expect(outcome.message).toContain("The Shattered Realms");
    expect(outcome.message).toContain("Session 12");
  });

  it("reports no live session as SUCCESS, not failure", () => {
    const outcome = describeHandshake(200, ok({ session: null }));
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("The Shattered Realms");
    expect(outcome.message).toMatch(/no session is live/i);
  });

  it("reports an ended session as no live session, though it arrives populated", () => {
    const outcome = describeHandshake(200, ok({ session: { status: "ended", id: "s1", name: "Session 12" } }));
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toMatch(/no session is live/i);
  });

  it("reports a planned session as no live session", () => {
    const outcome = describeHandshake(200, ok({ session: { status: "planned", id: "s2", name: "Next week" } }));
    expect(outcome.message).toMatch(/no session is live/i);
  });

  it("FAILS the test on a protocol version mismatch, where the customer is looking", () => {
    // Otherwise a mismatch surfaces hours later as every event being refused,
    // with nothing anywhere pointing at the cause.
    const outcome = describeHandshake(200, ok({ protocol: { v: 2 } }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/v2/);
    expect(outcome.message).toMatch(/update the module/i);
  });

  it("ignores a missing protocol block rather than calling it a mismatch", () => {
    expect(describeHandshake(200, ok({ protocol: null })).ok).toBe(true);
  });

  it("copes with a 200 carrying nothing useful", () => {
    const outcome = describeHandshake(200, null);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toMatch(/connected/i);
  });

  it("quotes the server's own sentence on a 422", () => {
    const outcome = describeHandshake(422, { error: { code: "invalid_batch", message: "A batch needs events" } });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("A batch needs events");
  });

  it("explains a rejected token in words a customer can act on", () => {
    const outcome = describeHandshake(401, null);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/mtb_/);
    expect(outcome.message).toMatch(/revoked/i);
  });

  it("tells a wrong URL apart from a wrong token", () => {
    expect(describeHandshake(404, null).message).toMatch(/server URL/i);
  });

  it("has a sentence for rate limits and server errors", () => {
    expect(describeHandshake(429, null).message).toMatch(/rate limited/i);
    expect(describeHandshake(500, null).message).toMatch(/HTTP 500/);
    expect(describeHandshake(418, null).ok).toBe(false);
  });
});

describe("testConnection", () => {
  const SETTINGS_OK = { serverUrl: "https://mot.example", apiToken: "mtb_abc", enabled: true };

  it("sends a Bearer token to the handshake endpoint", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const fetchImpl = async (url: string, init?: Record<string, unknown>) => {
      calls.push([url, init]);
      return {
        status: 200,
        json: async () => ({ project: { id: "p1", name: "Faerûn" }, session: null, protocol: { v: 1 } }),
      };
    };

    const outcome = await testConnection(SETTINGS_OK, fetchImpl);

    expect(calls[0]?.[0]).toBe("https://mot.example/api/v1/bridge/handshake");
    expect(calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer mtb_abc" },
    });
    expect(outcome.ok).toBe(true);
  });

  it("normalises a pasted URL with a path before calling", async () => {
    const calls: string[] = [];
    await testConnection({ ...SETTINGS_OK, serverUrl: "https://mot.example/projects/42/" }, async (url) => {
      calls.push(url);
      return { status: 200, json: async () => ({}) };
    });
    expect(calls[0]).toBe("https://mot.example/api/v1/bridge/handshake");
  });

  it("refuses an http:// server without making a request at all", async () => {
    const fetchImpl = vi.fn();
    const outcome = await testConnection({ ...SETTINGS_OK, serverUrl: "http://mot.example" }, fetchImpl as never);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/mixed content/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for a token before making a request", async () => {
    const fetchImpl = vi.fn();
    const outcome = await testConnection({ ...SETTINGS_OK, apiToken: "" }, fetchImpl as never);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/mtb_/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a network failure into a sentence, not an exception", async () => {
    const outcome = await testConnection(SETTINGS_OK, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("https://mot.example");
    expect(outcome.message).toContain("Failed to fetch");
  });

  it("copes with a non-JSON error body", async () => {
    const outcome = await testConnection(SETTINGS_OK, async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/HTTP 502/);
  });
});
