import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Audit (05-02 truth 2, UI-SPEC surface table + E1 loading row): the cream
 * hero's loading skeleton must draw its three blocks in --ccc-border-cream.
 *
 * Guards the 05-audit-w1 AUDIT-BUG (MAJOR): without a cream-scoped
 * .ccc-skeleton-line rule the blocks inherit --ccc-border, a light
 * translucent tone that is invisible on the cream card, and the loading
 * hero renders as an empty cream box.
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("cream hero loading skeleton (audit)", () => {
  it("a [data-surface='cream'] rule targets .ccc-skeleton-line with --ccc-border-cream", () => {
    const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selector, body]) =>
        selector?.includes('[data-surface="cream"]') &&
        selector.includes(".ccc-skeleton-line") &&
        /background(?:-color)?\s*:\s*var\(--ccc-border-cream\)/.test(body ?? ""),
    );
    expect(rules.length).toBeGreaterThan(0);
  });
});
