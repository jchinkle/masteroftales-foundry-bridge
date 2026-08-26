import { parseSessionState } from "./protocol/session.js";
import type { HandshakeResult } from "./protocol/types.js";
import { MODULE_ID, PROTOCOL_VERSION } from "./protocol/version.js";
import { apiUrl, checkServerUrl } from "./transport/urls.js";

/**
 * Module settings, and the one security decision a customer cannot make for
 * themselves: **the token is client-scope.**
 *
 * A world-scoped setting is readable from every player's browser console. The
 * server has no way to detect the mistake and no way to fix it. So the scope is
 * pinned here, said again in the setting's hint, and said a third time in the
 * README — because a customer pasting a credential into someone else's software
 * deserves to know exactly where it lands.
 */

export const SETTINGS = {
  serverUrl: "serverUrl",
  apiToken: "apiToken",
  enabled: "enabled",
} as const;

export const DEFAULT_SERVER_URL = "https://masteroftales.com";

/** Batch ingest. The one endpoint that carries the actual record. */
export const EVENTS_PATH = "/api/v1/bridge/events";

/**
 * Test Connection. Singular, and a GET: it is "who am I", it changes nothing a
 * customer can observe, and it is pressed repeatedly by somebody debugging their
 * settings pane. (The design doc's prose sketched `POST /handshakes`; that was
 * drift — the server routes `get "handshake"` and the doc is being corrected.)
 */
export const HANDSHAKE_PATH = "/api/v1/bridge/handshake";

/**
 * One handout's player-safe content, by MoT node id.
 *
 * The only endpoint this module *reads* a project's own writing from, and the
 * reason it is a fetch rather than a fatter bridge command: a page is prose, the
 * command socket carries session state and dice, and a letter three screens long
 * has no business travelling down it just so the module can decide whether to
 * write it. The bridge command carries the id; this carries the words.
 *
 * `encodeURIComponent` on top of `planHandoutShow`'s own refusal of slashes and
 * whitespace — belt and braces, and cheap.
 */
export function handoutPath(nodeId: string): string {
  return `/api/v1/bridge/handouts/${encodeURIComponent(nodeId)}`;
}

/**
 * This world's actor catalog. The one endpoint the module **pushes a list** to
 * rather than a record — see protocol/actors.ts for why it is a POST out instead
 * of a GET in (nothing ever connects *into* a customer's Foundry), and why it is
 * not simply hung off `BridgeInfo` like the roster is.
 *
 * Answers `204 No Content`: there is nothing to say back about a pick-list.
 */
export const ACTORS_PATH = "/api/v1/bridge/actors";

export interface BridgeSettings {
  serverUrl: string;
  apiToken: string;
  enabled: boolean;
}

export function readSettings(g: Pick<FoundryGame, "settings"> = game): BridgeSettings {
  return {
    serverUrl: String(g.settings.get(MODULE_ID, SETTINGS.serverUrl) ?? "").trim(),
    apiToken: String(g.settings.get(MODULE_ID, SETTINGS.apiToken) ?? "").trim(),
    enabled: g.settings.get(MODULE_ID, SETTINGS.enabled) !== false,
  };
}

/** True when there is enough configuration to try connecting at all. */
export function isConfigured(settings: BridgeSettings): boolean {
  return settings.enabled && settings.apiToken !== "" && checkServerUrl(settings.serverUrl).ok;
}

export interface RegisterSettingsDeps {
  /** Called when any setting changes; the module reconnects with the new values. */
  onChange(): void;
  notify?(level: "info" | "warn" | "error", message: string): void;
}

export function registerSettings(deps: RegisterSettingsDeps, g: Pick<FoundryGame, "settings"> = game): void {
  g.settings.register(MODULE_ID, SETTINGS.serverUrl, {
    name: "Master of Tales server",
    hint:
      "The base URL of your Master of Tales server, e.g. https://masteroftales.com. " +
      "Must be https:// — a Foundry served over https cannot open an insecure connection, " +
      "and the browser blocks it silently. http:// is accepted for localhost only.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SERVER_URL,
    onChange: (value: string) => {
      const check = checkServerUrl(value);
      if (!check.ok) deps.notify?.("error", `Master of Tales: ${check.reason}`);
      deps.onChange();
    },
  });

  g.settings.register(MODULE_ID, SETTINGS.apiToken, {
    name: "Bridge API token",
    hint:
      "The mtb_… key from your project's settings in Master of Tales. " +
      "Stored per-client (this browser only), never in the world — a world-scoped setting is " +
      "readable from every player's console. A player who obtained this key could post fake " +
      "lines into this project's live session log; it grants nothing else.",
    // The single most important line in this file. See the module header.
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: () => deps.onChange(),
  });

  g.settings.register(MODULE_ID, SETTINGS.enabled, {
    name: "Enable the bridge",
    hint: "Turn off to stop sending anything to Master of Tales without clearing your settings.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => deps.onChange(),
  });
}

// ------------------------------------------------------------------- handshake

export interface TestOutcome {
  ok: boolean;
  message: string;
}

/**
 * Turns a handshake response into the sentence the customer reads. Pure, because
 * this is the one call a customer makes before anything works and the wording of
 * each failure is the whole value of the button.
 *
 * The success body is
 * `{project: {id, name}, session: {status, id, name} | null, protocol: {v}}`.
 * Reading the project's **name** back is what makes the test a test: the single
 * most likely mistake is pasting a right-looking token for the wrong world, and
 * a green tick saying only "OK" would confirm it.
 */
export function describeHandshake(status: number, body: unknown): TestOutcome {
  if (status === 200 || status === 201) {
    const result = (body ?? {}) as HandshakeResult;
    const project = nonEmpty(result.project?.name);
    const session = parseSessionState(result.session);

    const where = project ? `Connected to "${project}".` : "Connected.";
    const what = session.live
      ? `Logging to the live session${session.name ? ` "${session.name}"` : ""}.`
      : "No session is live right now — start one and rolls will begin logging.";

    // A protocol mismatch would otherwise present as every event coming back
    // rejected, hours later, with nothing pointing at the cause. This is the one
    // moment a customer is looking straight at the answer.
    const serverProtocol = result.protocol?.v;
    if (typeof serverProtocol === "number" && serverProtocol !== PROTOCOL_VERSION) {
      return {
        ok: false,
        message:
          `${where} But this server speaks bridge protocol v${serverProtocol} and this module speaks ` +
          `v${PROTOCOL_VERSION}. Update the module (or the server) — events would be refused.`,
      };
    }

    return { ok: true, message: `${where} ${what}` };
  }

  if (status === 401 || status === 403) {
    return {
      ok: false,
      message:
        "The server refused this token. Check that you pasted the whole mtb_… key and that it " +
        "has not been revoked in your project settings.",
    };
  }

  if (status === 400 || status === 422) {
    // Batch-shaped codes cannot reach a GET, so this is a server that changed
    // its mind about the request. Surface its own words rather than inventing.
    const detail = nonEmpty((body as { error?: { message?: string } } | null)?.error?.message);
    return { ok: false, message: detail ?? `The server refused the request (HTTP ${status}).` };
  }

  if (status === 404) {
    return {
      ok: false,
      message: "Reached the server, but it has no bridge endpoint there. Check the server URL.",
    };
  }

  if (status === 429) {
    return { ok: false, message: "Rate limited. Wait a moment and try again." };
  }

  if (status >= 500) {
    return { ok: false, message: `The Master of Tales server returned an error (HTTP ${status}). Try again shortly.` };
  }

  return { ok: false, message: `Unexpected response from the server (HTTP ${status}).` };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/** Runs Test Connection. Never throws — a network failure is an outcome, not an exception. */
export async function testConnection(
  settings: BridgeSettings,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<TestOutcome> {
  const check = checkServerUrl(settings.serverUrl);
  if (!check.ok) return { ok: false, message: check.reason ?? "Invalid server URL." };
  if (settings.apiToken === "") {
    return { ok: false, message: "No API token set. Paste the mtb_… key from your project settings." };
  }

  const url = apiUrl(check.normalized ?? settings.serverUrl, HANDSHAKE_PATH);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${settings.apiToken}`,
        Accept: "application/json",
      },
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON body is fine for the failure paths; describeHandshake copes.
    }

    return describeHandshake(response.status, body);
  } catch (error) {
    return {
      ok: false,
      message:
        `Could not reach ${check.normalized}. Check the URL, and check that the server is up. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    };
  }
}
