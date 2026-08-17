/**
 * Server URL handling. Pure, and stricter than it looks — the `http://` refusal
 * below is the difference between "it doesn't work and nobody knows why" and one
 * sentence in a notification.
 *
 * The reason: Foundry is usually served over https, and an https page cannot
 * open a `ws://` socket or `fetch` an `http://` URL. The browser blocks it as
 * mixed content, silently, in a place the module cannot observe. So we refuse
 * the URL up front instead — except for loopback, where a self-hosted Foundry on
 * plain http talking to a dev server on plain http is a real and fine setup.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface UrlCheck {
  ok: boolean;
  /** Normalised origin (no trailing slash) when ok. */
  normalized?: string;
  reason?: string;
}

export function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Validates a server URL from the settings pane and normalises it to a bare
 * origin. A path, query or fragment is dropped rather than rejected: people
 * paste the URL they had in their address bar, and the useful part of
 * `https://masteroftales.com/projects/42/settings` is the first 26 characters.
 */
export function checkServerUrl(input: string): UrlCheck {
  const raw = (input ?? "").trim();
  if (raw === "") return { ok: false, reason: "Server URL is empty." };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid URL. Include the https:// prefix.` };
  }

  if (url.protocol === "https:") {
    return { ok: true, normalized: stripTrailingSlash(url.origin) };
  }

  if (url.protocol === "http:") {
    if (isLoopback(url.hostname)) {
      return { ok: true, normalized: stripTrailingSlash(url.origin) };
    }
    return {
      ok: false,
      reason:
        "http:// is refused for anything but localhost. A Foundry served over https cannot " +
        "open an insecure connection — the browser blocks it as mixed content, with no error " +
        "the module can see. Use https://.",
    };
  }

  return { ok: false, reason: `Unsupported scheme "${url.protocol}". Use https://.` };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** `https://host` -> `https://host/api/v1/bridge/events`, etc. */
export function apiUrl(serverUrl: string, path: string): string {
  const base = stripTrailingSlash(serverUrl.trim());
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * The command channel's URL.
 *
 * The token rides in the query string because **browsers cannot set headers on a
 * WebSocket handshake** — there is no Authorization header to put it in. That is
 * also why the server keeps `:token` in `filter_parameters`: this URL must never
 * be logged with its params, and neither must our own console lines (see
 * `redactCableUrl`).
 */
export function cableUrl(serverUrl: string, token: string): string {
  const base = stripTrailingSlash(serverUrl.trim());
  const ws = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  return `${ws}/bridge/cable?token=${encodeURIComponent(token)}`;
}

/** For logs and the status tooltip. Never print the real thing. */
export function redactCableUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/i, "$1<redacted>");
}
