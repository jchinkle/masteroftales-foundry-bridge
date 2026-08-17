import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../src/commands/index.js";
import { NO_SESSION } from "../src/commands/index.js";
import { parseSessionState } from "../src/protocol/session.js";
import { MODULE_ID } from "../src/protocol/version.js";
import { StatusChip } from "../src/ui/status.js";
import { asDocument, FakeDocument } from "./fakeDom.js";

const ELEMENT_ID = `${MODULE_ID}-status`;
function summary(session: unknown, projectName: string | null = "Faerûn"): SessionSummary {
  return { ...parseSessionState(session), projectName };
}

const LIVE = summary({ status: "live", id: "s1", name: "Session 14" });

function chipIn(mounts: string[], onClick?: () => void) {
  const doc = new FakeDocument(mounts);
  const chip = new StatusChip({ document: asDocument(doc), onClick });
  return { doc, chip };
}

describe("StatusChip mounting", () => {
  it("mounts into the player list, which exists in both v13 and v14", () => {
    const { doc, chip } = chipIn(["players", "ui-left", "interface"]);
    chip.render();
    expect(doc.querySelector("#players")?.querySelector(`#${ELEMENT_ID}`)).not.toBeNull();
  });

  it("walks the fallback list when the preferred mount is missing", () => {
    const { doc, chip } = chipIn(["ui-left", "interface"]);
    chip.render();
    expect(doc.querySelector("#ui-left")?.querySelector(`#${ELEMENT_ID}`)).not.toBeNull();
  });

  it("falls back to a floating pill on the body when Foundry's layout has moved again", () => {
    const { doc, chip } = chipIn([]);
    chip.render();
    const element = doc.getElementById(ELEMENT_ID);
    expect(element).not.toBeNull();
    // The chip is positioned by CSS in this case so it cannot end up inside
    // whatever container a future Foundry decided to rename.
    expect(element?.classList.contains("floating")).toBe(true);
  });

  it("injects its stylesheet exactly once, however often it re-renders", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.render();
    chip.render();
    chip.update({ socket: "connected", session: LIVE });
    const styles = [...doc.head.descendants()].filter((el) => el.id === `${MODULE_ID}-status-style`);
    expect(styles).toHaveLength(1);
  });

  it("creates one element, not one per update", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.update({ socket: "offline", session: { ...NO_SESSION } });
    chip.update({ socket: "connecting", session: { ...NO_SESSION } });
    chip.update({ socket: "connected", session: LIVE });

    const players = doc.querySelector("#players");
    expect(players?.children.filter((el) => el.id === ELEMENT_ID)).toHaveLength(1);
  });

  it("re-attaches after a Foundry UI re-render removed the element", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.render();
    doc.getElementById(ELEMENT_ID)?.remove();
    expect(doc.getElementById(ELEMENT_ID)).toBeNull();

    chip.update({ socket: "connected", session: LIVE });
    expect(doc.getElementById(ELEMENT_ID)).not.toBeNull();
  });
});

describe("StatusChip rendering", () => {
  it("shows the label and tooltip for the current state", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.update({ socket: "connected", session: LIVE });

    const element = doc.getElementById(ELEMENT_ID);
    expect(element?.text).toBe("Logging to Session 14");
    expect(element?.title).toContain("Session 14");
  });

  it("replaces the label rather than appending to it as state changes", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.update({ socket: "connected", session: LIVE });
    chip.update({ socket: "offline", session: { ...NO_SESSION } });

    const element = doc.getElementById(ELEMENT_ID);
    expect(element?.text).toBe("Offline");
    expect(element?.children).toHaveLength(2); // dot + label, not four
  });

  it("colours the dot per level", () => {
    const { doc, chip } = chipIn(["players"]);
    const dotColour = () => doc.getElementById(ELEMENT_ID)?.children[0]?.style.backgroundColor;

    chip.update({ socket: "connected", session: LIVE });
    expect(dotColour()).toBe("#4caf50");
    chip.update({ socket: "connected", session: summary(null) });
    expect(dotColour()).toBe("#e0a52a");
    chip.update({ socket: "offline", session: { ...NO_SESSION } });
    expect(dotColour()).toBe("#8b8b8b");
    chip.update({ socket: "rejected", session: { ...NO_SESSION } });
    expect(dotColour()).toBe("#d64545");
  });

  it("writes the session name as text, never as markup — it is customer data", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.update({
      socket: "connected",
      session: summary({ status: "live", id: "s1", name: "<img src=x onerror=alert(1)>" }, null),
    });
    const label = doc.getElementById(ELEMENT_ID)?.children[1];
    expect(label?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("runs the click handler, which is how the customer re-tests the connection", () => {
    const onClick = vi.fn();
    const { doc, chip } = chipIn(["players"], onClick);
    chip.render();
    doc.getElementById(ELEMENT_ID)?.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not wire a click handler when none was supplied", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.render();
    expect(doc.getElementById(ELEMENT_ID)?.listeners.get("click")).toBeUndefined();
  });

  it("destroy() removes the element", () => {
    const { doc, chip } = chipIn(["players"]);
    chip.render();
    chip.destroy();
    expect(doc.getElementById(ELEMENT_ID)).toBeNull();
  });

  it("is a silent no-op with no document at all, e.g. under a headless import", () => {
    const chip = new StatusChip({ document: undefined as unknown as Document });
    expect(() => chip.update({ socket: "offline", session: { ...NO_SESSION } })).not.toThrow();
  });
});
