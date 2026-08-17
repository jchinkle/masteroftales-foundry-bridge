/**
 * The one piece of memory in the capture layer, and it exists because of a gap
 * in Foundry rather than because we wanted state.
 *
 * `updateActor` / `updateToken` fire **after** the write, and they hand back the
 * updated document plus the diff. Neither carries the *previous* value. So a
 * client watching a fight sees "hp is now 12" and can never say "was 27" — which
 * is the difference between a battle report and a list of numbers.
 *
 * Systems do not help portably: dnd5e stashes pre-update HP in `options.dnd5e`,
 * most systems stash nothing, and reading a system-specific option would put a
 * 5e dependency in the core path — exactly the thing the adapter boundary exists
 * to prevent.
 *
 * So the module remembers what it last saw. The consequences are stated honestly
 * in the payload rather than hidden: the first change to any pool reports
 * `from: null`, and a GM who enables the bridge mid-fight gets one line without a
 * delta and correct deltas thereafter.
 *
 * **Bounded**, for the same reason the outbox is: a Map that grows once per
 * document in a browser tab left open for nine hours of dungeon crawling is a
 * memory leak with extra steps. Insertion order is recency order (a re-remember
 * deletes and re-inserts), so the eviction is a true LRU and the mook nobody has
 * touched since the first encounter is the one that goes.
 */

export const MAX_REMEMBERED = 500;

export class PriorValues {
  private readonly values = new Map<string, unknown>();

  constructor(private readonly max: number = MAX_REMEMBERED) {}

  /** What this client last saw at `key`, or null if it has never seen it. */
  recall(key: string): unknown {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  remember(key: string, value: unknown): void {
    // Delete first so the re-insert moves the key to the end of the iteration
    // order. Without this, a document touched a thousand times would still be
    // evicted at its *first* sighting's position.
    this.values.delete(key);
    this.values.set(key, value);
    this.evict();
  }

  forget(key: string): void {
    this.values.delete(key);
  }

  get size(): number {
    return this.values.size;
  }

  private evict(): void {
    while (this.values.size > this.max) {
      const oldest = this.values.keys().next();
      if (oldest.done) return;
      this.values.delete(oldest.value);
    }
  }
}

/** Namespaced so a hit point pool and a purse on the same actor cannot collide. */
export function hpSlot(uuid: string): string {
  return `hp:${uuid}`;
}

export function currencySlot(uuid: string): string {
  return `currency:${uuid}`;
}
