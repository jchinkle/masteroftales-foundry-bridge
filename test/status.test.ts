import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/commands/index.js";
import { NO_SESSION } from "../src/commands/index.js";
import { parseSessionState } from "../src/protocol/session.js";
import { computeStatusView } from "../src/ui/status.js";

/**
 * Built through the real parser from the real server object, so a change to
 * either cannot leave these fixtures quietly describing something the server
 * never sends.
 */
function summary(session: unknown, projectName: string | null = "Faerûn"): SessionSummary {
  return { ...parseSessionState(session), projectName };
}

const LIVE = summary({ status: "live", id: "s1", name: "Session 14" });

describe("computeStatusView", () => {
  it("is GREEN and names the session when connected to a live one", () => {
    const view = computeStatusView({ socket: "connected", session: LIVE });
    expect(view.level).toBe("green");
    expect(view.label).toBe("Logging to Session 14");
  });

  it("falls back to the project name when the session is unnamed", () => {
    const view = computeStatusView({
      socket: "connected",
      session: summary({ status: "live", id: "s1", name: null }),
    });
    expect(view.level).toBe("green");
    expect(view.label).toContain("Faerûn");
  });

  it("is YELLOW when connected with no live session — the common Tuesday-night case", () => {
    const view = computeStatusView({
      socket: "connected",
      session: summary(null),
    });
    expect(view.level).toBe("yellow");
    expect(view.label).toBe("No live session");
    expect(view.tooltip).toContain("Faerûn");
    // Not an error. Nothing here should read as broken.
    expect(view.tooltip).toMatch(/start a session/i);
  });

  it("is GREY when offline, and says so calmly", () => {
    const view = computeStatusView({ socket: "offline", session: { ...NO_SESSION } });
    expect(view.level).toBe("grey");
    expect(view.label).toBe("Offline");
  });

  it("is GREY while connecting", () => {
    expect(computeStatusView({ socket: "connecting", session: { ...NO_SESSION } }).level).toBe("grey");
  });

  it("tells an unconfigured module apart from a disconnected one", () => {
    expect(computeStatusView({ socket: "idle", session: { ...NO_SESSION } }).tooltip).toMatch(/module settings/i);
    expect(computeStatusView({ socket: "offline", session: { ...NO_SESSION } }).tooltip).toMatch(/retrying/i);
  });

  it("is RED when the socket reports a rejected token", () => {
    const view = computeStatusView({ socket: "rejected", session: { ...NO_SESSION } });
    expect(view.level).toBe("red");
    expect(view.label).toBe("Token rejected");
    expect(view.tooltip).toMatch(/revoked|mistyped/i);
  });

  it("is RED when the REST outbox saw a 401 even though the socket has not noticed yet", () => {
    const view = computeStatusView({ socket: "connected", session: LIVE, tokenRejected: true });
    expect(view.level).toBe("red");
  });

  it("surfaces queued and dropped counts in the tooltip", () => {
    const view = computeStatusView({ socket: "connected", session: LIVE, queued: 7, dropped: 3 });
    expect(view.tooltip).toContain("7 queued");
    expect(view.tooltip).toContain("3 dropped");
  });

  it("says nothing about counts when there is nothing to say", () => {
    const view = computeStatusView({ socket: "connected", session: LIVE, queued: 0, dropped: 0 });
    expect(view.tooltip).not.toContain("queued");
  });
});
