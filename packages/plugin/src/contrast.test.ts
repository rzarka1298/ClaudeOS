import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "./contrast.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
// Resolved from this file's own URL, never a repo-relative literal: the same
// test must find the stylesheet whatever directory the runner is invoked from
// (the convention vault-write.test.ts already follows).
const REPO_ROOT = resolve(SRC_DIR, "..", "..", "..");
const TOKENS_CSS = join(REPO_ROOT, "docs", "design", "prototypes", "prototype-tokens.css");

/** Reads one `--ccc-*` custom property out of the authoritative stylesheet.
 *  The CSS stays the single source of the palette (research: "prefer
 *  extracting from the CSS"), so an un-audited colour edit fails this test
 *  rather than passing against a stale copy in TypeScript. */
function readToken(css: string, name: string): string {
  const match = new RegExp(`--ccc-${name}\\s*:\\s*([^;]+);`).exec(css);
  if (!match?.[1]) throw new Error(`token --ccc-${name} not found in ${TOKENS_CSS}`);
  return match[1].trim();
}

describe("relativeLuminance and contrastRatio (WCAG 2.2 SC 1.4.3)", () => {
  it("reports the 21:1 maximum for black against white, in either order", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 2);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 2);
  });

  it("straddles the 4.5 threshold exactly where WCAG does", () => {
    // #767676 is the darkest grey that still passes 4.5:1 on white; one step
    // lighter fails. Pinning both sides catches an off-by-a-rounding-step
    // error in the linearisation that a single-sided assertion would miss.
    expect(contrastRatio("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeLessThan(4.5);
  });

  it("anchors relative luminance at 1 for white and 0 for black", () => {
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 6);
  });

  it("accepts 3-digit hex and fully opaque rgb() / rgba()", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(relativeLuminance("#ffffff"), 6);
    expect(relativeLuminance("#0b0")).toBeCloseTo(relativeLuminance("#00bb00"), 6);
    expect(relativeLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 6);
    expect(relativeLuminance("rgba(0, 0, 0, 1)")).toBeCloseTo(0, 6);
  });

  it("refuses a translucent colour rather than inventing a ratio for it", () => {
    // A translucent colour has no single contrast -- it depends on whatever
    // is behind it. --ccc-border is translucent by design and is therefore
    // excluded from every text pair, not silently approximated.
    expect(() => relativeLuminance("rgba(244, 239, 230, 0.14)")).toThrow(/alpha/i);
    expect(() => relativeLuminance("teal")).toThrow();
    expect(() => relativeLuminance("#12345")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The shipped stylesheet (`packages/plugin/src/styles.css`) — the cream-surface
// colour guard, meter accessibility and reduced-motion proof (Phase 5 plan 02
// Task 3). Parsed into real `{selector, body}` rules, exactly the technique
// `tokens.test.ts` already uses for the same file, never a regex over
// arbitrary text — so a selector that merely LOOKS like a match (inside a
// comment, or a substring of a longer token name) cannot slip past.
// ---------------------------------------------------------------------------

const PLUGIN_STYLESHEET_PATH = join(REPO_ROOT, "packages", "plugin", "src", "styles.css");
const PLUGIN_STYLESHEET = readFileSync(PLUGIN_STYLESHEET_PATH, "utf8");

/** Blanks comment text while preserving line count (same technique as tokens.test.ts). */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

interface PluginStyleRule {
  readonly selector: string;
  readonly body: string;
}

/** Every style rule in the file, flattened out of any enclosing at-rule. */
function parsePluginRules(source: string): PluginStyleRule[] {
  const rules: PluginStyleRule[] = [];
  let prelude = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "{") {
      let depth = 1;
      let cursor = index + 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "{") depth++;
        else if (source[cursor] === "}") depth--;
        cursor++;
      }
      const body = source.slice(index + 1, cursor - 1);
      const selector = prelude.trim();
      if (selector.startsWith("@")) {
        rules.push(...parsePluginRules(body));
      } else if (selector.length > 0) {
        rules.push({ selector, body });
      }
      prelude = "";
      index = cursor;
      continue;
    }

    if (char === ";" && prelude.trim().startsWith("@")) {
      prelude = "";
      index++;
      continue;
    }

    prelude += char;
    index++;
  }

  return rules;
}

const PLUGIN_RULES = parsePluginRules(codeOnly(PLUGIN_STYLESHEET));

describe("cream surface never uses --ccc-accent or --ccc-danger (UI-SPEC Non-Negotiable 2)", () => {
  it('Test 1: no rule whose selector includes [data-surface="cream"] references --ccc-accent or --ccc-danger', () => {
    const offenders = PLUGIN_RULES.filter((rule) =>
      rule.selector.includes('[data-surface="cream"]'),
    )
      .filter(
        (rule) => /--ccc-accent\b(?!-deep)/.test(rule.body) || /--ccc-danger\b/.test(rule.body),
      )
      .map((rule) => rule.selector);
    expect(offenders).toEqual([]);
  });

  it("still finds at least one cream-scoped rule, so the assertion above is not vacuous", () => {
    const creamRules = PLUGIN_RULES.filter((rule) =>
      rule.selector.includes('[data-surface="cream"]'),
    );
    expect(creamRules.length).toBeGreaterThan(0);
  });
});

describe("the hero meter and row action never animate or lose their focus/motion guarantees (UI-SPEC 'the fill does not animate', D-19)", () => {
  it("Test 2: .ccc-hero-meter and its pseudo-elements declare no transition or animation", () => {
    const meterRules = PLUGIN_RULES.filter((rule) => rule.selector.includes(".ccc-hero-meter"));
    expect(meterRules.length).toBeGreaterThan(0);
    for (const rule of meterRules) {
      expect(rule.body, rule.selector).not.toMatch(/\btransition\s*:/);
      expect(rule.body, rule.selector).not.toMatch(/\banimation\s*:/);
    }
  });

  it("Test 2: the existing reduced-motion override on .ccc-kpi-number still applies inside the hero head", () => {
    // The selector is `.ccc-command-center[data-motion="reduced"] .ccc-kpi-number`
    // — an ordinary descendant combinator, so it matches a `.ccc-kpi-number`
    // inside `.ccc-hero-head` exactly as it matches the top-level one; no
    // hero-specific override exists or is needed.
    const rule = PLUGIN_RULES.find(
      (r) =>
        r.selector.includes('[data-motion="reduced"]') && r.selector.includes(".ccc-kpi-number"),
    );
    expect(rule).toBeDefined();
    expect(rule?.body).toMatch(/transition\s*:\s*none/);
    expect(rule?.selector.includes(".ccc-hero-head")).toBe(false);
  });

  it("Test 3: .ccc-row-action declares a min-height and min-width that resolve to --ccc-space-lg", () => {
    const rowActionRules = PLUGIN_RULES.filter((rule) =>
      rule.selector.split(",").some((selector) => selector.trim() === ".ccc-row-action"),
    );
    const minHeight = rowActionRules.flatMap((rule) =>
      [...rule.body.matchAll(/min-height\s*:\s*([^;]+);/g)].map((match) => match[1]?.trim()),
    );
    const minWidth = rowActionRules.flatMap((rule) =>
      [...rule.body.matchAll(/min-width\s*:\s*([^;]+);/g)].map((match) => match[1]?.trim()),
    );
    expect(minHeight).toContain("var(--ccc-space-lg)");
    expect(minWidth).toContain("var(--ccc-space-lg)");
  });
});

describe("provisional palette clears WCAG AA before the review (A11Y-02, research A9)", () => {
  // A separate describe so a palette failure reads as "the colours are wrong"
  // rather than "the formula is wrong" -- they are fixed in different files
  // by different people. A9 flags magenta-on-near-black and muted-ink-on-
  // near-black as the two at real risk, which is exactly why this runs
  // BEFORE the owner is asked to choose a direction, not at UAT.
  const FOREGROUNDS = ["ink", "ink-muted", "accent", "danger"] as const;
  const BACKGROUNDS = ["bg", "surface"] as const;

  for (const foreground of FOREGROUNDS) {
    for (const background of BACKGROUNDS) {
      it(`--ccc-${foreground} reaches 4.5:1 on --ccc-${background}`, () => {
        const css = readFileSync(TOKENS_CSS, "utf8");
        const ratio = contrastRatio(readToken(css, foreground), readToken(css, background));

        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
