/**
 * A hand-rolled DOM, just large enough for `StatusChip`.
 *
 * Written rather than pulled in (happy-dom/jsdom) to keep the dev toolchain at
 * typescript + vite + vitest, which is the same reason the ActionCable client is
 * hand-written. It implements only the handful of methods the chip calls, and if
 * the chip ever calls something else the test fails loudly rather than silently
 * passing against a permissive mock.
 */

export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classList: { add(name: string): void; contains(name: string): boolean };
  readonly style: Record<string, string> = {};

  id = "";
  title = "";
  textContent = "";
  className = "";
  parent: FakeElement | null = null;
  isConnected = false;

  private readonly classes = new Set<string>();
  private readonly attributes = new Map<string, string>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {
    this.classList = {
      add: (name) => void this.classes.add(name),
      contains: (name) => this.classes.has(name),
    };
  }

  set innerHTML(value: string) {
    if (value !== "") throw new Error("FakeElement only supports clearing innerHTML");
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    child.isConnected = true;
    this.children.push(child);
    if (child.id) this.ownerDocument.index.set(child.id, child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  remove(): void {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    if (this.id) this.ownerDocument.index.delete(this.id);
    this.parent = null;
    this.isConnected = false;
  }

  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  /** Test driver. */
  click(): void {
    for (const handler of this.listeners.get("click") ?? []) handler();
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.descendants()) {
      if (matches(child, selector)) return child;
    }
    return null;
  }

  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  /** Test helper: the visible text of this element and everything under it. */
  get text(): string {
    return [this.textContent, ...this.children.map((child) => child.text)].join("").trim();
  }
}

function matches(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  return element.tagName === selector;
}

export class FakeDocument {
  readonly index = new Map<string, FakeElement>();
  readonly body: FakeElement;
  readonly head: FakeElement;
  private readonly root: FakeElement;

  constructor(mountIds: string[] = []) {
    this.root = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.head = new FakeElement("head", this);
    this.root.appendChild(this.head);
    this.root.appendChild(this.body);

    for (const id of mountIds) {
      const element = new FakeElement("div", this);
      element.id = id;
      this.body.appendChild(element);
    }
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  getElementById(id: string): FakeElement | null {
    return this.index.get(id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.root.querySelector(selector);
  }
}

/** `StatusChip` takes a `Document`; the fake satisfies the parts it uses. */
export function asDocument(fake: FakeDocument): Document {
  return fake as unknown as Document;
}
