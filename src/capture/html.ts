/**
 * Chat message content is HTML. Session entries render as **text** on the server
 * — there is deliberately no sanitizer surface over there to get wrong — so the
 * stripping happens here, and the server's validation ("text fields carry no
 * HTML") is a second line of defence rather than the only one.
 *
 * Implemented with string work rather than `innerHTML` + `textContent` on
 * purpose. Two reasons: it stays a pure function testable under vitest's node
 * environment with no DOM, and parsing hostile markup by handing it to a live
 * DOM in the GM's browser is a thing to avoid on reflex even when it is
 * technically inert.
 */

const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|h[1-6]|blockquote|hr|section|article)\b[^>]*>/gi;
const DROPPED_ELEMENTS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ANY_TAG = /<[^>]*>/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/** HTML in, one line of plain text out. Never returns null; empty in, empty out. */
export function stripHtml(input: string | null | undefined): string {
  if (input === null || input === undefined) return "";

  const withoutDropped = String(input).replace(DROPPED_ELEMENTS, " ");
  // Block-level tags become spaces so `<p>a</p><p>b</p>` reads "a b", not "ab".
  const spaced = withoutDropped.replace(BLOCK_TAGS, " ");
  const stripped = spaced.replace(ANY_TAG, "");

  return collapseWhitespace(decodeEntities(stripped));
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const key = name.toLowerCase();
    const known = ENTITIES[key];
    if (known !== undefined) return known;

    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    return match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/** Hard cap so one pathological message cannot blow the 16KB per-event budget. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}
