import type { SessionSummary } from "../commands/index.js";
import { MODULE_ID } from "../protocol/version.js";
import type { SocketStatus } from "../transport/socket.js";

/**
 * The status chip.
 *
 * Four states, and the important one is **grey**: Foundry is open six days a
 * week with no session running, and that is not an error. Nothing about the
 * offline state should look like a failure, because for most of the module's
 * life it is simply the truth.
 *
 * The view model is a pure function so the "which colour when" question — the
 * only part with any judgement in it — is a unit test rather than something
 * verified by squinting at a browser.
 */

export type StatusLevel = "green" | "yellow" | "grey" | "red";

export interface StatusView {
  level: StatusLevel;
  label: string;
  tooltip: string;
}

export interface StatusInputs {
  socket: SocketStatus;
  session: SessionSummary;
  /** Set when the REST outbox got a 401, which the socket may not have noticed yet. */
  tokenRejected?: boolean;
  queued?: number;
  dropped?: number;
}

export function computeStatusView(inputs: StatusInputs): StatusView {
  const { socket, session } = inputs;
  const detail: string[] = [];
  if (inputs.queued) detail.push(`${inputs.queued} queued`);
  if (inputs.dropped) detail.push(`${inputs.dropped} dropped`);
  const suffix = detail.length > 0 ? ` (${detail.join(", ")})` : "";

  if (inputs.tokenRejected || socket === "rejected") {
    return {
      level: "red",
      label: "Token rejected",
      tooltip:
        "Master of Tales refused this bridge token. It may have been revoked or mistyped. " +
        "Create a new bridge key in your project settings and paste it into the module settings.",
    };
  }

  if (socket === "connected") {
    if (session.live) {
      const name = session.name ?? session.projectName ?? "the live session";
      return {
        level: "green",
        label: `Logging to ${name}`,
        tooltip: `Connected to Master of Tales. Table events are being written to ${name}.${suffix}`,
      };
    }
    const project = session.projectName ? ` (${session.projectName})` : "";
    return {
      level: "yellow",
      label: "No live session",
      tooltip:
        `Connected to Master of Tales${project}, but no session is live. ` +
        `Start a session in Master of Tales and rolls will begin logging.${suffix}`,
    };
  }

  if (socket === "connecting") {
    return {
      level: "grey",
      label: "Connecting…",
      tooltip: `Opening the connection to Master of Tales.${suffix}`,
    };
  }

  return {
    level: "grey",
    label: "Offline",
    tooltip:
      socket === "idle"
        ? "Not connected. Set the server URL and API token in module settings."
        : `Not connected to Master of Tales. Retrying in the background.${suffix}`,
  };
}

// ---------------------------------------------------------------------- render

const ELEMENT_ID = `${MODULE_ID}-status`;
const STYLE_ID = `${MODULE_ID}-status-style`;

const COLORS: Record<StatusLevel, string> = {
  green: "#4caf50",
  yellow: "#e0a52a",
  grey: "#8b8b8b",
  red: "#d64545",
};

/**
 * Mount points, most specific first. Foundry moves its layout containers between
 * majors more often than anything else in the API, so this walks a list and only
 * falls back to a floating pill on `document.body` if none of them exist.
 *
 * `#players` is the target because it is a small, low-traffic panel in the
 * bottom-left of both v13 and v14, and a chip appended there flows with the
 * layout instead of covering something.
 */
const MOUNT_SELECTORS = ["#players", "#ui-left-column-1", "#ui-left", "#interface"];

export interface StatusChipOptions {
  /** Clicking the chip runs the connection test. */
  onClick?: () => void;
  document?: Document;
}

export class StatusChip {
  private readonly doc: Document | null;
  private readonly onClick: (() => void) | undefined;
  private element: HTMLElement | null = null;
  private view: StatusView = { level: "grey", label: "Offline", tooltip: "" };

  constructor(options: StatusChipOptions = {}) {
    this.doc = options.document ?? (typeof document === "undefined" ? null : document);
    this.onClick = options.onClick;
  }

  update(inputs: StatusInputs): void {
    this.view = computeStatusView(inputs);
    this.render();
  }

  get current(): StatusView {
    return this.view;
  }

  /** Re-attaches after a Foundry UI re-render blew the element away. */
  render(): void {
    const doc = this.doc;
    if (!doc) return;

    this.ensureStyle(doc);

    let element = this.element;
    if (!element || !element.isConnected) {
      element = doc.getElementById(ELEMENT_ID);
    }

    if (!element) {
      element = doc.createElement("div");
      element.id = ELEMENT_ID;
      element.setAttribute("role", "status");
      if (this.onClick) {
        element.style.cursor = "pointer";
        element.addEventListener("click", () => this.onClick?.());
      }
      const mount = this.resolveMount(doc);
      if (mount === doc.body) element.classList.add("floating");
      mount.appendChild(element);
    }

    element.title = this.view.tooltip;
    element.innerHTML = "";

    const dot = doc.createElement("span");
    dot.className = "mot-bridge-dot";
    dot.style.backgroundColor = COLORS[this.view.level];

    const label = doc.createElement("span");
    label.className = "mot-bridge-label";
    // textContent, not innerHTML: the session name is customer data and this is
    // the GM's own browser. Cheap to get right, embarrassing to get wrong.
    label.textContent = this.view.label;

    element.append(dot, label);
    this.element = element;
  }

  destroy(): void {
    this.element?.remove();
    this.element = null;
  }

  private resolveMount(doc: Document): HTMLElement {
    for (const selector of MOUNT_SELECTORS) {
      const found = doc.querySelector<HTMLElement>(selector);
      if (found) return found;
    }
    return doc.body;
  }

  private ensureStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${ELEMENT_ID} {
  display: flex; align-items: center; gap: 6px;
  margin: 2px 0 0; padding: 2px 6px;
  font-size: var(--font-size-12, 12px); line-height: 1.4;
  color: var(--color-text-light-highlight, #f0f0e0);
  border-radius: 3px; background: rgba(0, 0, 0, 0.35);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${ELEMENT_ID}.floating {
  position: fixed; left: 8px; bottom: 8px; z-index: 70;
}
#${ELEMENT_ID} .mot-bridge-dot {
  flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
  box-shadow: 0 0 4px currentColor;
}
#${ELEMENT_ID} .mot-bridge-label { overflow: hidden; text-overflow: ellipsis; }
`.trim();
    (doc.head ?? doc.body).appendChild(style);
  }
}
