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
