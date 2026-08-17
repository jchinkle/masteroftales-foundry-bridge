import { describe, expect, it } from "vitest";
import { apiUrl, cableUrl, checkServerUrl, isLoopback, redactCableUrl } from "../src/transport/urls.js";

describe("checkServerUrl", () => {
  it("accepts an https URL and normalises it to a bare origin", () => {
    expect(checkServerUrl("https://masteroftales.com")).toEqual({
      ok: true,
      normalized: "https://masteroftales.com",
    });
  });

  it("strips a trailing slash, a path, a query and a fragment", () => {
    // People paste what was in their address bar. The useful part is the origin.
    expect(checkServerUrl("https://masteroftales.com/").normalized).toBe("https://masteroftales.com");
    expect(checkServerUrl("https://masteroftales.com/projects/42/settings").normalized).toBe(
      "https://masteroftales.com",
    );
    expect(checkServerUrl("https://masteroftales.com/x?y=1#z").normalized).toBe("https://masteroftales.com");
  });

  it("keeps an explicit port", () => {
    expect(checkServerUrl("https://mot.example:8443").normalized).toBe("https://mot.example:8443");
  });

  it("tolerates surrounding whitespace from a paste", () => {
    expect(checkServerUrl("  https://masteroftales.com  ").normalized).toBe("https://masteroftales.com");
  });

  it("REJECTS http:// for a real host — an https Foundry cannot reach it", () => {
    const result = checkServerUrl("http://masteroftales.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mixed content/i);
    expect(result.reason).toMatch(/https/i);
  });

  it("allows http:// for loopback, where a local dev server is a real setup", () => {
    expect(checkServerUrl("http://localhost:3000").ok).toBe(true);
    expect(checkServerUrl("http://127.0.0.1:3000").ok).toBe(true);
    expect(checkServerUrl("http://LOCALHOST:3000").ok).toBe(true);
    expect(checkServerUrl("http://[::1]:3000").ok).toBe(true);
  });

  it("is not fooled by a hostname that merely contains 'localhost'", () => {
    expect(checkServerUrl("http://localhost.evil.example").ok).toBe(false);
    expect(checkServerUrl("http://notlocalhost").ok).toBe(false);
  });

  it("rejects other schemes, including a ws:// URL pasted by mistake", () => {
    expect(checkServerUrl("ws://masteroftales.com").ok).toBe(false);
    expect(checkServerUrl("wss://masteroftales.com").ok).toBe(false);
    expect(checkServerUrl("ftp://masteroftales.com").ok).toBe(false);
  });

  it("rejects empty and malformed input with a sentence, not a stack trace", () => {
    expect(checkServerUrl("").reason).toMatch(/empty/i);
    expect(checkServerUrl("   ").reason).toMatch(/empty/i);
    expect(checkServerUrl("masteroftales.com").reason).toMatch(/https:\/\//);
  });
});

describe("isLoopback", () => {
  it("knows the loopback names and nothing else", () => {
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("192.168.50.99")).toBe(false);
  });
});

describe("apiUrl", () => {
  it("joins an origin and a path exactly once", () => {
    expect(apiUrl("https://mot.example", "/api/v1/bridge/events")).toBe("https://mot.example/api/v1/bridge/events");
    expect(apiUrl("https://mot.example/", "/api/v1/bridge/events")).toBe("https://mot.example/api/v1/bridge/events");
    expect(apiUrl("https://mot.example", "api/v1/bridge/events")).toBe("https://mot.example/api/v1/bridge/events");
  });
});

describe("cableUrl", () => {
  it("upgrades https to wss", () => {
    expect(cableUrl("https://mot.example", "mtb_abc")).toBe("wss://mot.example/bridge/cable?token=mtb_abc");
  });

  it("uses ws for a loopback http server", () => {
    expect(cableUrl("http://localhost:3000", "mtb_abc")).toBe("ws://localhost:3000/bridge/cable?token=mtb_abc");
  });

  it("puts the token in the query string, because a browser cannot set WS headers", () => {
    expect(cableUrl("https://mot.example", "a b&c=d")).toBe("wss://mot.example/bridge/cable?token=a%20b%26c%3Dd");
  });

  it("does not double a trailing slash", () => {
    expect(cableUrl("https://mot.example/", "t")).toBe("wss://mot.example/bridge/cable?token=t");
  });
});

describe("redactCableUrl", () => {
  it("hides the token so no log line ever carries a live credential", () => {
    expect(redactCableUrl("wss://mot.example/bridge/cable?token=mtb_secret")).toBe(
      "wss://mot.example/bridge/cable?token=<redacted>",
    );
  });

  it("leaves a URL with no token untouched", () => {
    expect(redactCableUrl("wss://mot.example/bridge/cable")).toBe("wss://mot.example/bridge/cable");
  });
});
