import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Audit (05-02 truth 2, UI-SPEC surface table + E1 loading row): the cream
 * hero's loading skeleton must draw its three blocks in --ccc-border-cream.
 *
 * AUDIT-BUG (05-audit-w1, MAJOR): styles.css has no cream-scoped
 * .ccc-skeleton-line rule, so the blocks inherit --ccc-border, a light
 * translucent tone that is invisible on the cream card. The loading hero
 * renders as an empty cream box (seen in the wave-1 harness capture).
 * Skipped until the product CSS adds the cream override.
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("cream hero loading skeleton (audit)", () => {
  it.skip("a [data-surface='cream'] rule targets .ccc-skeleton-line with --ccc-border-cream", () => {
    const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selector, body]) =>
        selector?.includes('[data-surface="cream"]') &&
        selector.includes(".ccc-skeleton-line") &&
        body?.includes("--ccc-border-cream"),
    );
    expect(rules.length).toBeGreaterThan(0);
  });
});
