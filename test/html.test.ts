import { describe, expect, it } from "vitest";
import { stripHtml, truncate } from "../src/capture/html.js";

describe("stripHtml", () => {
  it("removes inline tags and keeps the text", () => {
    expect(stripHtml("<b>Tharivol</b> swings <i>wildly</i>")).toBe("Tharivol swings wildly");
  });

  it("turns block boundaries into spaces so words do not run together", () => {
    expect(stripHtml("<p>first</p><p>second</p>")).toBe("first second");
    expect(stripHtml("one<br>two")).toBe("one two");
    expect(stripHtml("<li>a</li><li>b</li>")).toBe("a b");
  });

  it("drops script and style content entirely, not just the tags", () => {
    expect(stripHtml("safe<script>alert('x')</script>text")).toBe("safe text");
    expect(stripHtml("<style>.a{color:red}</style>visible")).toBe("visible");
  });

  it("decodes the entities Foundry actually emits", () => {
    expect(stripHtml("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(stripHtml("&lt;not a tag&gt;")).toBe("<not a tag>");
    expect(stripHtml("&quot;quoted&quot;")).toBe('"quoted"');
    expect(stripHtml("a&nbsp;b")).toBe("a b");
    expect(stripHtml("wait&hellip;")).toBe("wait…");
    expect(stripHtml("don&#39;t")).toBe("don't");
  });

  it("decodes numeric and hex entities", () => {
    expect(stripHtml("&#65;&#66;")).toBe("AB");
    expect(stripHtml("&#x41;&#x42;")).toBe("AB");
  });

  it("leaves an unknown entity alone rather than mangling it", () => {
    expect(stripHtml("&notarealentity;")).toBe("&notarealentity;");
  });

  it("collapses whitespace and trims", () => {
    expect(stripHtml("  lots   of \n\t space  ")).toBe("lots of space");
  });

  it("handles attributes containing angle-bracket-ish text", () => {
    expect(stripHtml('<span data-x="a>b">hi</span>')).toContain("hi");
  });

  it("returns an empty string for empty, null and undefined input", () => {
    expect(stripHtml("")).toBe("");
    expect(stripHtml(null)).toBe("");
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml("<div></div>")).toBe("");
  });

  it("strips a realistic dnd5e chat card down to its words", () => {
    const card =
      '<div class="dnd5e2 chat-card"><header class="card-header"><h3>Longsword</h3></header>' +
      "<div class='card-content'><p>Melee Weapon Attack</p></div></div>";
    expect(stripHtml(card)).toBe("Longsword Melee Weapon Attack");
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 100)).toBe("short");
    expect(truncate("exact", 5)).toBe("exact");
  });

  it("cuts long text and marks the cut", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abcdefghij", 5)).toHaveLength(5);
  });

  it("copes with a zero limit", () => {
    expect(truncate("abc", 0)).toBe("…");
  });
});
