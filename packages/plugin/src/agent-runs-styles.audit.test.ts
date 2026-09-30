import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.js";

/**
 * Audit (05 wave 4 review, visual findings on the Agent runs destination):
 * the stylesheet rules the four Agent runs baselines depend on, pinned as
 * text so a regression fails in the unit suite, not only in the Linux
 * screenshot container.
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** Top-level and `@container`-nested rules alike: the innermost `{…}` pairs. */
const RULES: readonly Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector, body]) => ({
    selectors: (selector ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => s.length > 0),
    body: body ?? "",
  }),
);

function declarationsFor(selector: string): string[] {
  return RULES.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body);
}

function tokenValue(name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(CSS);
  if (!match?.[1]) throw new Error(`token ${name} not declared`);
  return match[1].trim();
}

/** ADR-0023's audited worst case for light ink on glass (tokens.test.ts). */
const GLASS_COMPOSITE = "#1D161E";

describe("Agent runs row names (wave 4 contrast finding)", () => {
  it("the glass-surface row-link rule sets the light ink explicitly", () => {
    const bodies = declarationsFor(".ccc-agent-runs .ccc-session-row-link");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some((body) => /(^|;|\s)color\s*:\s*var\(--ccc-ink\)/.test(body))).toBe(true);
  });

  it("the dark cream ink reaches a row link only inside a cream card", () => {
    const inverse = RULES.filter(
      (rule) =>
        /color\s*:\s*var\(--ccc-ink-inverse\)/.test(rule.body) &&
        rule.selectors.some((s) => s.includes(".ccc-session-row-link")),
    );
    for (const rule of inverse) {
      for (const selector of rule.selectors.filter((s) => s.includes(".ccc-session-row-link"))) {
        expect(selector).toContain('[data-surface="cream"]');
      }
    }
  });

  it("the row-link ink clears 4.5 : 1 on the opaque surface and on the glass worst case", () => {
    const ink = tokenValue("--ccc-ink");
    expect(contrastRatio(ink, tokenValue("--ccc-surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink, GLASS_COMPOSITE)).toBeGreaterThanOrEqual(4.5);
  });
});
