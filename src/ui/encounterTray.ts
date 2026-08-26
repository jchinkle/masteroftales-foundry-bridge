import type { EncounterPlan, Placement, ResolvedEntry, TokenLike } from "../commands/encounters.js";
import { dragPayload, expectedTokenCount, matchPlacedToken, placementFor } from "../commands/encounters.js";
import type { CommandLog } from "../commands/index.js";
import { MODULE_ID } from "../protocol/version.js";

/**
 * The token tray — one stage of an encounter, waiting to be dragged onto a map.
 *
 * Deliberately thin. Everything with a decision in it lives in
 * `commands/encounters.ts` as a pure function: which rows are draggable, what a
 * drag carries, which row a landed token belongs to, how many tokens are still
 * owed. This file turns those answers into elements and reads events back. If a
 * question here needs more than an `if`, it belongs over there.
 *
 * Three things about it are load-bearing rather than cosmetic:
 *
 *  1. **It listens to `createToken`, not to its own drops.** A drop is a browser
 *     event on a canvas this module does not own, and a GM has half a dozen other
 *     ways to put a goblin on a map. The hook is Foundry stating what actually
 *     happened, so the counter is right however the token got there.
 *  2. **The hook comes off when the tray closes.** A tray left listening after it
 *     is shut is not merely wasteful: it would keep matching tokens by actor id
 *     and would count the *next* fight's goblins onto a stage nobody is looking
 *     at, then roll initiative for them. Every exit path goes through `close()`.
 *  3. **The roll button stays pressable.** A GM who wanted four of the six
 *     goblins on the board is not stuck waiting for two they never meant to
 *     place; the auto-press is a convenience for the common case, not the only
 *     way out of the window. Each press deploys only what has landed since the
 *     last one, so pressing twice does not add a goblin to the tracker twice.
 *
 * Built with `createElement` against an injected `Document`, exactly as
 * `ui/status.ts` is, and for the same reason: no framework, and every branch
 * testable against the hand-rolled DOM in `test/fakeDom.ts`.
 */

/** Foundry's "a token document was created" hook. */
export const CREATE_TOKEN_HOOK = "createToken";

/** The hook surface this tray needs. `Hooks` satisfies it. */
export interface TrayHooks {
  on(hook: string, fn: (...args: any[]) => unknown): number;
  off(hook: string, id: number | ((...args: any[]) => unknown)): void;
}

/** When MoT sent no encounter name. */
export const DEFAULT_TITLE = "Encounter";

export const DRAG_HINT = "Drag each onto the map.";

export const ROLL_LABEL = "Roll initiative";

/**
 * The two sentences a greyed row carries.
 *
 * Said out loud rather than implied by the grey, because both are things the
 * keeper can go and fix in Master of Tales, and neither is this module's fault to
 * apologise for silently.
 */
export const UNLINKED_NOTE = "Not linked to a Foundry actor — place this one yourself.";
export const UNRESOLVED_NOTE = "This world has no actor with that id.";

export interface EncounterTrayOptions {
  plan: EncounterPlan;
  entries: ResolvedEntry[];
  hooks: TrayHooks;
  /** Hands the placements that have landed since the last press to the combat. */
  rollInitiative(placements: Placement[]): void;
  document?: Document;
  log?: CommandLog;
}

const ELEMENT_ID = `${MODULE_ID}-encounter-tray`;
const STYLE_ID = `${MODULE_ID}-encounter-style`;

/**
 * Mount points, most specific first — the same walk `StatusChip` does, and for
 * the same reason: Foundry moves its layout containers between majors more often
 * than anything else in the API. The tray is positioned by CSS in either case, so
 * a fallback to `body` costs nothing but a stacking context.
 */
const MOUNT_SELECTORS = ["#interface", "#ui-middle", "#ui-left"];

export class EncounterTray {
  private readonly doc: Document | null;
  private readonly plan: EncounterPlan;
  private readonly entries: ResolvedEntry[];
  private readonly hooks: TrayHooks;
  private readonly roll: (placements: Placement[]) => void;
  private readonly log: CommandLog | undefined;

  /** How many tokens this stage owes the map. Computed once; the plan does not change. */
  private readonly expected: number;

  private element: HTMLElement | null = null;
  private readonly counters = new Map<string, HTMLElement>();
  private hookId: number | null = null;
  private opened = false;

  /** Tokens counted, by row key, and the ids behind them so none is counted twice. */
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();
  /** Landed but not yet handed to a combat. Drained by every press. */
  private readonly pending: Placement[] = [];
  private placedTotal = 0;
  private autoRolled = false;

  constructor(options: EncounterTrayOptions) {
    this.doc = options.document ?? (typeof document === "undefined" ? null : document);
    this.plan = options.plan;
    this.entries = options.entries;
    this.hooks = options.hooks;
    this.roll = options.rollInitiative;
    this.log = options.log;
    this.expected = expectedTokenCount(options.entries);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Tokens this tray has counted. The tests read it; so does the auto-press. */
  get placed(): number {
    return this.placedTotal;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    // Registered before anything is rendered: the window is the slow half, and a
    // token placed while it opens still belongs to this stage.
    this.hookId = this.hooks.on(CREATE_TOKEN_HOOK, (token: unknown) => this.onTokenCreated(token as TokenLike));
    this.render();
  }

  /** Unhooks and removes. Idempotent — a double close is a no-op, not a second `off`. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;

    if (this.hookId !== null) {
      try {
        this.hooks.off(CREATE_TOKEN_HOOK, this.hookId);
      } catch (error) {
        // A Foundry mid-teardown. The tray is going away regardless.
        this.log?.debug?.("[masteroftales-bridge] could not unhook the encounter tray", error);
      }
      this.hookId = null;
    }

    this.element?.remove();
    this.element = null;
    this.counters.clear();
  }

  // ------------------------------------------------------------- placements

  private onTokenCreated(token: TokenLike | null | undefined): void {
    // Defensive: a hook Foundry called after the `off` landed, or a second tray's
    // token arriving during teardown. A closed tray counts nothing.
    if (!this.opened) return;

    const key = matchPlacedToken(this.entries, token);
    if (key === null) return;

    const placement = placementFor(token, key);
    if (placement === null || this.seen.has(placement.tokenId)) return;

    this.seen.add(placement.tokenId);
    this.pending.push(placement);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.placedTotal += 1;
    this.paintCounters();

    if (this.autoRolled || !this.plan.rollInitiative) return;
    if (this.expected === 0 || this.placedTotal < this.expected) return;

    // Every token this stage owed is on the map. Pressing the button for the GM
    // is the whole point of counting: the alternative is a keeper who deployed
    // six goblins hunting for a button to finish a thing they already finished.
    this.autoRolled = true;
    this.rollNow();
  }

  /**
   * What the button does, and what the auto-press does — one path, deliberately.
   *
   * `splice` rather than a read: each press owns the placements it takes, so a
   * second press after two more goblins landed adds those two and nothing else.
   * Foundry would otherwise be handed a token it already has a combatant for.
   */
  private rollNow(): void {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length === 0) return;

    try {
      this.roll(batch);
    } catch (error) {
      this.log?.warn?.("[masteroftales-bridge] could not roll initiative for the deployed tokens", error);
    }
  }

  // ----------------------------------------------------------------- render

  private render(): void {
    const doc = this.doc;
    if (!doc) return;

    this.ensureStyle(doc);
    doc.getElementById(ELEMENT_ID)?.remove();

    const root = doc.createElement("div");
    root.id = ELEMENT_ID;
    root.setAttribute("role", "dialog");

    root.appendChild(this.buildHeader(doc));

    const hint = doc.createElement("div");
    hint.className = "mot-encounter-hint";
    hint.textContent = DRAG_HINT;
    root.appendChild(hint);

    const rows = doc.createElement("div");
    rows.className = "mot-encounter-rows";
    for (const entry of this.entries) rows.appendChild(this.buildRow(doc, entry));
    root.appendChild(rows);

    // Omitted entirely when MoT said "tray only". A button that contradicts the
    // command is a worse offer than no button: Foundry's own combat tracker is
    // right there for a GM who changes their mind.
    if (this.plan.rollInitiative) root.appendChild(this.buildRollButton(doc));

    this.resolveMount(doc).appendChild(root);
    this.element = root;
    this.paintCounters();
  }

  private buildHeader(doc: Document): HTMLElement {
    const header = doc.createElement("div");
    header.className = "mot-encounter-header";

    const title = doc.createElement("span");
    title.className = "mot-encounter-title";
    // textContent, not innerHTML, throughout this file: every string here is
    // customer data that arrived over a socket. Cheap to get right.
    title.textContent = this.plan.encounterName ?? DEFAULT_TITLE;
    header.appendChild(title);

    if (this.plan.stageName !== null) {
      const stage = doc.createElement("span");
      stage.className = "mot-encounter-stage";
      stage.textContent = this.plan.stageName;
      header.appendChild(stage);
    }

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "mot-encounter-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", () => this.close());
    header.appendChild(close);

    return header;
  }

  private buildRow(doc: Document, entry: ResolvedEntry): HTMLElement {
    const row = doc.createElement("div");
    row.className = entry.state === "ready" ? "mot-encounter-row" : "mot-encounter-row is-unavailable";

    if (entry.img !== null) {
      const art = doc.createElement("img");
      art.className = "mot-encounter-art";
      art.src = entry.img;
      art.alt = "";
      row.appendChild(art);
    }

    const quantity = doc.createElement("span");
    quantity.className = "mot-encounter-quantity";
    quantity.textContent = `${entry.quantity} ×`;
    row.appendChild(quantity);

    const name = doc.createElement("span");
    name.className = "mot-encounter-name";
    name.textContent = entry.name;
    row.appendChild(name);

    if (entry.state === "ready") {
      const counter = doc.createElement("span");
      counter.className = "mot-encounter-count";
      row.appendChild(counter);
      this.counters.set(entry.key, counter);

      this.makeDraggable(row, entry);
    } else {
      const note = doc.createElement("span");
      note.className = "mot-encounter-note";
      note.textContent = entry.state === "unlinked" ? UNLINKED_NOTE : UNRESOLVED_NOTE;
      row.appendChild(note);
    }

    return row;
  }

  /**
   * Makes the row carry exactly what a drag from Foundry's own actor directory
   * carries. `text/plain` is the format the canvas reads; `dragPayload` is the
   * content, built as a value so its shape is a unit test rather than something
   * discovered by dropping a goblin on a map and getting nothing.
   */
  private makeDraggable(row: HTMLElement, entry: ResolvedEntry): void {
    const data = dragPayload(entry);
    if (data === null) return;

    row.draggable = true;
    row.addEventListener("dragstart", (event: DragEvent) => {
      event.dataTransfer?.setData("text/plain", JSON.stringify(data));
    });
  }

  private buildRollButton(doc: Document): HTMLElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "mot-encounter-roll";
    button.textContent = ROLL_LABEL;
    button.addEventListener("click", () => this.rollNow());
    return button;
  }

  /** The only thing a placement redraws. The rows themselves keep their listeners. */
  private paintCounters(): void {
    for (const entry of this.entries) {
      const counter = this.counters.get(entry.key);
      if (!counter) continue;
      counter.textContent = `${this.counts.get(entry.key) ?? 0} / ${entry.quantity}`;
    }
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
  position: fixed; right: 16px; top: 96px; z-index: 70;
  display: flex; flex-direction: column; gap: 4px;
  max-width: 280px; max-height: 60vh; overflow-y: auto;
  padding: 6px 8px; border-radius: 4px;
  background: rgba(0, 0, 0, 0.75);
  color: var(--color-text-light-highlight, #f0f0e0);
  font-size: var(--font-size-12, 12px); line-height: 1.4;
}
#${ELEMENT_ID} .mot-encounter-header {
  display: flex; align-items: baseline; gap: 6px;
}
#${ELEMENT_ID} .mot-encounter-title { font-weight: bold; }
#${ELEMENT_ID} .mot-encounter-stage { opacity: 0.75; flex: 1 1 auto; }
#${ELEMENT_ID} .mot-encounter-close {
  flex: 0 0 auto; background: none; border: 0; color: inherit; cursor: pointer;
  font-size: 14px; line-height: 1; padding: 0 2px;
}
#${ELEMENT_ID} .mot-encounter-hint { opacity: 0.65; }
#${ELEMENT_ID} .mot-encounter-rows { display: flex; flex-direction: column; gap: 2px; }
#${ELEMENT_ID} .mot-encounter-row {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 4px; border-radius: 3px;
  background: rgba(255, 255, 255, 0.06); cursor: grab;
}
#${ELEMENT_ID} .mot-encounter-row.is-unavailable { opacity: 0.5; cursor: default; }
#${ELEMENT_ID} .mot-encounter-art {
  flex: 0 0 auto; width: 24px; height: 24px; object-fit: cover; border-radius: 2px;
}
#${ELEMENT_ID} .mot-encounter-quantity { flex: 0 0 auto; opacity: 0.8; }
#${ELEMENT_ID} .mot-encounter-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${ELEMENT_ID} .mot-encounter-count { flex: 0 0 auto; opacity: 0.8; }
#${ELEMENT_ID} .mot-encounter-note { flex: 2 1 auto; opacity: 0.8; white-space: normal; }
#${ELEMENT_ID} .mot-encounter-roll {
  margin-top: 2px; cursor: pointer;
}
`.trim();
    (doc.head ?? doc.body).appendChild(style);
  }
}
