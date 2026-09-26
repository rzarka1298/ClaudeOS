import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.js";
import { Shell } from "./view/shell.js";

/**
 * The A11Y-02 / UI-03 / D-18 audit of the real stylesheet.
 *
 * It parses `styles.css` from disk rather than asserting against a TypeScript
 * mirror of the token values, because a mirror is a second source of truth
 * that drifts silently: the CSS is what ships, so the CSS is what gets
 * measured. ADR-0023's token table is documentation of these same values, not
 * a competing declaration.
 *
 * Every assertion here is a property the stylesheet must keep forever, not a
 * snapshot of what it happens to say today — so an un-audited colour edit, a
 * stray `px`, an Obsidian custom property inside the root, a selector that
 * escapes `.ccc-`, or a motion token that is "nearly" zero under reduced
 * motion all fail loudly at the commit that introduces them.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const STYLESHEET_PATH = join(SRC_DIR, "styles.css");
const STYLESHEET = readFileSync(STYLESHEET_PATH, "utf8");

const ROOT_SELECTOR = ":where(.ccc-command-center)";
const REDUCED_SELECTOR = '[data-motion="reduced"]';

/**
 * The lightest composite `--ccc-surface-glass` can reach anywhere on the
 * atmosphere — the translucent card fill over the brightest point of the
 * top-left gradient. `contrastRatio()` refuses alpha < 1 by design (a
 * translucent colour has no single ratio), so ADR-0023 records this hex as
 * the audited worst case for light ink: every darker placement passes a
 * fortiori.
 */
const GLASS_COMPOSITE = "#1D161E";

/** Classes that must never be reachable without a visible focus ring (A11Y-01). */
const FOCUSABLE = [
  ".ccc-nav-item",
  ".ccc-content",
  ".ccc-source-button",
  ".ccc-connect-button",
  ".ccc-quick-action",
  ".ccc-list-more",
  // A `tall` card's body scrolls, so it takes a tabindex to stay
  // keyboard-reachable; plan 03-05 deferred this entry until the first `tall`
  // widget existed, and plan 03-06 registers two (Active Claude sessions,
  // Technology and market intelligence).
  ".ccc-card-body[tabindex]",
];

// ---------------------------------------------------------------------------
// A small, deliberate CSS reader
// ---------------------------------------------------------------------------

/**
 * Blanks comment text while preserving line count, so every scan below reads
 * CODE only — the file most likely to name a forbidden construct is the one
 * documenting why it is forbidden. Same technique as `vault-write.test.ts`.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

interface StyleRule {
  /** The rule's own selector text, e.g. `.ccc-nav-item:focus-visible`. */
  readonly selector: string;
  /** Raw declaration text between the braces. */
  readonly body: string;
  /** Enclosing at-rule preludes, outermost first (`@container (...)`, `@keyframes …`). */
  readonly atStack: readonly string[];
}

interface Declaration {
  readonly property: string;
  readonly value: string;
}

/** Collects every style rule, recording which at-rules enclose it. */
function parseRules(source: string, atStack: readonly string[] = []): StyleRule[] {
  const rules: StyleRule[] = [];
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
        rules.push(...parseRules(body, [...atStack, selector]));
      } else if (selector.length > 0) {
        rules.push({ selector, body, atStack });
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

/** Splits a rule body into `property: value` pairs, ignoring nested blocks. */
function declarationsOf(rule: StyleRule): Declaration[] {
  const declarations: Declaration[] = [];
  for (const chunk of rule.body.split(";")) {
    const text = chunk.trim();
    if (text.length === 0 || text.includes("{")) continue;
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    declarations.push({
      property: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
    });
  }
  return declarations;
}

const RULES = parseRules(codeOnly(STYLESHEET));
const ROOT_RULES = RULES.filter((rule) => rule.selector === ROOT_SELECTOR);
const REDUCED_RULES = RULES.filter((rule) => rule.selector.includes(REDUCED_SELECTOR));
const IN_KEYFRAMES = (rule: StyleRule): boolean =>
  rule.atStack.some((at) => at.startsWith("@keyframes"));

/** Every `--ccc-*` declaration outside the reduced-motion override block. */
function baseTokenDeclarations(): Declaration[] {
  return RULES.filter((rule) => !rule.selector.includes(REDUCED_SELECTOR))
    .flatMap(declarationsOf)
    .filter((declaration) => declaration.property.startsWith("--ccc-"));
}

const TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  baseTokenDeclarations().map((declaration) => [declaration.property, declaration.value]),
);

/** Resolves a TOKEN_PAIRS entry: a `--ccc-*` name, or a literal colour. */
function colourOf(nameOrLiteral: string): string {
  if (!nameOrLiteral.startsWith("--ccc-")) return nameOrLiteral;
  const value = TOKENS[nameOrLiteral];
  if (value === undefined) {
    throw new Error(`tokens: styles.css declares no ${nameOrLiteral}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The contrast matrix (A11Y-02)
// ---------------------------------------------------------------------------

interface TokenPair {
  readonly fg: string;
  readonly bg: string;
  /** 4.5 for body and label ink (WCAG 1.4.3); 3.0 for non-text (1.4.11). */
  readonly floor: number;
}

/**
 * Every pair ADR-0023 `## Measured contrast` records, re-measured from the
 * values the stylesheet actually declares. Translucent tokens (`--ccc-border`,
 * `--ccc-surface-glass`, `--ccc-border-cream`) never appear as a member: they
 * have no single ratio, so glass is audited at {@link GLASS_COMPOSITE} and the
 * hairline borders are decorative by construction (the surface delta carries
 * the boundary).
 */
const TOKEN_PAIRS: readonly TokenPair[] = [
  // Ink on the two opaque dark surfaces, plus the glass worst case.
  { fg: "--ccc-ink", bg: "--ccc-bg", floor: 4.5 },
  { fg: "--ccc-ink", bg: "--ccc-surface", floor: 4.5 },
  { fg: "--ccc-ink", bg: GLASS_COMPOSITE, floor: 4.5 },
  { fg: "--ccc-ink-muted", bg: "--ccc-bg", floor: 4.5 },
  { fg: "--ccc-ink-muted", bg: "--ccc-surface", floor: 4.5 },
  { fg: "--ccc-ink-muted", bg: GLASS_COMPOSITE, floor: 4.5 },
  { fg: "--ccc-accent", bg: "--ccc-bg", floor: 4.5 },
  { fg: "--ccc-accent", bg: "--ccc-surface", floor: 4.5 },
  { fg: "--ccc-accent", bg: GLASS_COMPOSITE, floor: 4.5 },
  { fg: "--ccc-danger", bg: "--ccc-bg", floor: 4.5 },
  { fg: "--ccc-danger", bg: "--ccc-surface", floor: 4.5 },
  { fg: "--ccc-danger", bg: GLASS_COMPOSITE, floor: 4.5 },
  // The cream family: ink on cream, and the deep accent that replaced the
  // bright one there.
  { fg: "--ccc-ink-inverse", bg: "--ccc-cream", floor: 4.5 },
  { fg: "--ccc-ink-inverse-muted", bg: "--ccc-cream", floor: 4.5 },
  { fg: "--ccc-accent-deep", bg: "--ccc-cream", floor: 4.5 },
  // Non-text: the focus ring on each surface, and the cream panel's own
  // boundary against the shell.
  { fg: "--ccc-accent", bg: "--ccc-bg", floor: 3.0 },
  { fg: "--ccc-accent", bg: "--ccc-surface", floor: 3.0 },
  { fg: "--ccc-accent-deep", bg: "--ccc-cream", floor: 3.0 },
  { fg: "--ccc-cream", bg: "--ccc-bg", floor: 3.0 },
];

/**
 * Pairs that must NEVER appear together on one surface. ADR-0023 rejected the
 * bright accent on cream at 2.47 : 1 and replaced it with `--ccc-accent-deep`;
 * without this negative assertion the rejection is prose that a future rule
 * can quietly contradict.
 */
const FORBIDDEN_PAIRS: readonly { readonly fg: string; readonly bg: string }[] = [
  { fg: "--ccc-accent", bg: "--ccc-cream" },
];

// ---------------------------------------------------------------------------

describe("token block (UI-03, D-18)", () => {
  it("declares the tokens in exactly one :where(.ccc-command-center) block", () => {
    expect(ROOT_RULES).toHaveLength(1);
    expect(Object.keys(TOKENS).length).toBeGreaterThan(0);
  });

  it("declares every --ccc-* custom property exactly once outside the reduced-motion block", () => {
    const counts = new Map<string, number>();
    for (const declaration of baseTokenDeclarations()) {
      counts.set(declaration.property, (counts.get(declaration.property) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([property]) => property);
    expect(duplicated).toEqual([]);
  });

  it("names no colour literal outside the token block", () => {
    const offenders = RULES.filter((rule) => rule.selector !== ROOT_SELECTOR).flatMap((rule) =>
      declarationsOf(rule)
        .filter((declaration) => !declaration.property.startsWith("--ccc-"))
        .filter((declaration) => /#[0-9a-f]{3,8}\b|\brgba?\s*\(/i.test(declaration.value))
        .map((declaration) => `${rule.selector} { ${declaration.property} }`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("leak gate (D-18, UI-SPEC Non-Negotiables 1-2)", () => {
  it("scopes every selector to the command-center root", () => {
    const escaping = RULES.filter((rule) => !IN_KEYFRAMES(rule))
      .filter((rule) => !rule.selector.includes(".ccc-"))
      .map((rule) => rule.selector);
    expect(escaping).toEqual([]);
  });

  it("references no Obsidian custom property — the root is near-black in both themes", () => {
    const references = [...codeOnly(STYLESHEET).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(references.filter((name) => !name.startsWith("--ccc-"))).toEqual([]);
    expect(references.length).toBeGreaterThan(0);
  });

  it("uses no importance override, so a user snippet can still win", () => {
    expect(codeOnly(STYLESHEET)).not.toMatch(/!\s*important/);
  });
});

describe("contrast floors (A11Y-02)", () => {
  it.each(TOKEN_PAIRS)("$fg on $bg clears $floor:1", ({ fg, bg, floor }) => {
    expect(contrastRatio(colourOf(fg), colourOf(bg))).toBeGreaterThanOrEqual(floor);
  });

  it.each(FORBIDDEN_PAIRS)("never places $fg on $bg", ({ fg, bg }) => {
    // The measurement that made it forbidden, recomputed from the shipped
    // values — so a future edit that "fixes" the ratio has to come back here.
    expect(contrastRatio(colourOf(fg), colourOf(bg))).toBeLessThan(4.5);

    // And structurally: no single rule may reference both tokens, which is the
    // only way the forbidden pairing can actually reach a screen.
    const offenders = RULES.filter(
      (rule) => rule.selector !== ROOT_SELECTOR && rule.body.includes(fg) && rule.body.includes(bg),
    ).map((rule) => rule.selector);
    expect(offenders).toEqual([]);
  });

  it("computes ratios over opaque sRGB only — a translucent token is never a text pair member", () => {
    for (const pair of TOKEN_PAIRS) {
      for (const member of [pair.fg, pair.bg]) {
        expect(() => contrastRatio(colourOf(member), "#000000")).not.toThrow();
      }
    }
    // The border tokens are translucent by design, and `contrastRatio` refuses
    // them rather than compositing a guess — proving they cannot be smuggled
    // into the matrix above by a later edit.
    expect(() => contrastRatio(colourOf("--ccc-border"), "#000000")).toThrow();
  });
});

describe("type and dimension floors (A11Y-02, WCAG 1.4.4)", () => {
  it("keeps every text token at or above 0.8125rem", () => {
    const textTokens = Object.entries(TOKENS).filter(([name]) => name.startsWith("--ccc-text-"));
    expect(textTokens.length).toBeGreaterThan(0);
    for (const [name, value] of textTokens) {
      const sizes = [...value.matchAll(/(\d*\.?\d+)rem/g)].map((match) => Number(match[1]));
      expect(sizes.length, `${name} states no rem size`).toBeGreaterThan(0);
      expect(Math.min(...sizes), `${name} is below the 0.8125rem floor`).toBeGreaterThanOrEqual(
        0.8125,
      );
    }
  });

  it("states no dimension in px, so Obsidian's own font-size setting still scales the UI", () => {
    const offenders = RULES.flatMap((rule) =>
      declarationsOf(rule)
        .filter((declaration) => /\b\d*\.?\d+px\b/.test(declaration.value))
        .map((declaration) => `${rule.selector} { ${declaration.property}: ${declaration.value} }`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("focus visibility (A11Y-01)", () => {
  it.each(FOCUSABLE)("gives %s a :focus-visible ring", (className) => {
    const rules = RULES.filter(
      (rule) => rule.selector.includes(":focus-visible") && rule.selector.includes(className),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((rule) => /outline\s*:/.test(rule.body))).toBe(true);
  });
});

describe("reduced motion at the token level (A11Y-03, D-19)", () => {
  it("re-declares the three motion tokens to literal zero", () => {
    const overridden = new Map<string, string>();
    for (const rule of REDUCED_RULES) {
      for (const declaration of declarationsOf(rule)) {
        if (declaration.property.startsWith("--ccc-")) {
          overridden.set(declaration.property, declaration.value);
        }
      }
    }
    // Literal zero, never a small nonzero value — the A11Y-03 precision edge.
    expect(overridden.get("--ccc-motion-fast")).toBe("0ms");
    expect(overridden.get("--ccc-motion-slow")).toBe("0ms");
    expect(overridden.get("--ccc-twinkle-duration")).toBe("0s");
  });

  it("stops the twinkle animation and the KPI transition outright", () => {
    const declaresOn = (className: string, property: string, value: string): boolean =>
      REDUCED_RULES.some(
        (rule) =>
          rule.selector.includes(className) &&
          declarationsOf(rule).some(
            (declaration) => declaration.property === property && declaration.value === value,
          ),
      );

    expect(declaresOn(".ccc-twinkle", "animation", "none")).toBe(true);
    expect(declaresOn(".ccc-kpi-number", "transition", "none")).toBe(true);
  });

  it("drives every animation and transition from a motion token, never a literal duration", () => {
    const offenders = RULES.flatMap((rule) =>
      declarationsOf(rule)
        .filter((declaration) => /^(animation|transition)(-duration)?$/.test(declaration.property))
        .filter((declaration) => declaration.value !== "none")
        .filter((declaration) => !declaration.value.includes("var(--ccc-"))
        .map((declaration) => `${rule.selector} { ${declaration.property}: ${declaration.value} }`),
    );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The wide collapse measures the grid's own box (UI-SPEC E3 overflow row)
// ---------------------------------------------------------------------------

/**
 * "The grid never scrolls horizontally at any container width" rests on one
 * inequality: a `wide` card may span two columns only when two columns exist.
 * The collapse is a container query, so it is evaluated against the card's
 * nearest query container — and if that box is wider than the grid (the grid
 * sits inside `.ccc-content`'s padding and, with classic scrollbars, beside a
 * scrollbar), there is a band of widths where the query still says "wide" but
 * the grid already has one column (phase-3 remediation, 03-07 review MAJOR).
 *
 * jsdom does no layout, so this is measured the way the browser decides it:
 * the REAL shell DOM names the query container, the REAL stylesheet names the
 * insets between it and the grid, the threshold, the column minimum and every
 * gap, and a sweep across grid widths in 1px steps (overlay and classic
 * scrollbars) checks `span <= columns` at every width, boundary included.
 */
describe("the wide collapse never spans more columns than the grid has (UI-SPEC E3)", () => {
  const BASE_RULES = RULES.filter((rule) => rule.atStack.length === 0);
  const PX = 1 / 16;
  /** A classic (non-overlay) macOS scrollbar is 15px wide. */
  const CLASSIC_SCROLLBAR = 15 * PX;

  /** Resolves `var(--ccc-*)` through the token block and returns rem. */
  function rem(value: string): number {
    const token = /^var\((--ccc-[\w-]+)\)$/.exec(value.trim());
    if (token?.[1] !== undefined) {
      const resolved = TOKENS[token[1]];
      if (resolved === undefined) throw new Error(`no token ${token[1]}`);
      return rem(resolved);
    }
    if (value.trim() === "0") return 0;
    const match = /^(-?\d*\.?\d+)rem$/.exec(value.trim());
    if (!match?.[1]) throw new Error(`not a rem length: ${value}`);
    return Number(match[1]);
  }

  function selectorsOf(rule: StyleRule): string[] {
    return rule.selector.split(",").map((selector) => selector.trim());
  }

  /** Unconditional declarations of `property` on rules matching `element`, in source order. */
  function matchingDeclarations(element: Element, property: RegExp): Declaration[] {
    return BASE_RULES.filter((rule) => selectorsOf(rule).some((s) => element.matches(s))).flatMap(
      (rule) => declarationsOf(rule).filter((declaration) => property.test(declaration.property)),
    );
  }

  /** The nearest ancestor the stylesheet makes a size query container. */
  function queryContainerOf(element: Element): Element | null {
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const declared = matchingDeclarations(node, /^container-type$/).at(-1);
      if (declared !== undefined && declared.value !== "normal") return node;
    }
    return null;
  }

  /** Left + right from the element's last matching `padding` shorthand. */
  function horizontalPadding(element: Element): number {
    const declared = matchingDeclarations(element, /^padding$/).at(-1);
    if (declared === undefined) return 0;
    const [top = "0", right = top, , left = right] = declared.value.split(/\s+(?![^(]*\))/);
    return rem(right) + rem(left);
  }

  function scrollsVertically(element: Element): boolean {
    return matchingDeclarations(element, /^overflow(-y)?$/).some((declaration) =>
      /\b(auto|scroll)\b/.test(declaration.value),
    );
  }

  it("keeps a wide card's span within the grid's columns at every width", () => {
    render(h(Shell, {}));
    const grid = document.querySelector(".ccc-overview-grid");
    const wide = grid?.querySelector(':scope > .ccc-card[data-size="wide"]');
    if (!grid || !wide) throw new Error("the default Overview renders no wide card");

    // What lies between the query container's content box and the grid's
    // content box (where the tracks live). The container is an ancestor of
    // the card, so it is the grid itself or an ancestor of the grid.
    const container = queryContainerOf(wide);
    let padding = 0;
    let scrollbars = 0;
    for (let node: Element | null = grid; node !== null && node !== container; ) {
      padding += horizontalPadding(node);
      if (scrollsVertically(node)) scrollbars++;
      node = node.parentElement;
    }
    cleanup();

    const collapse = RULES.filter(
      (rule) =>
        rule.selector.includes('[data-size="wide"]') &&
        /grid-column:\s*span 1/.test(rule.body) &&
        rule.atStack.some((at) => at.startsWith("@container")),
    );
    expect(collapse).toHaveLength(1);
    const threshold = rem(
      /max-width:\s*([^)]+)\)/.exec(collapse[0]?.atStack.at(-1) ?? "")?.[1] ?? "",
    );

    const gridDeclarations = RULES.filter((rule) => rule.selector === ".ccc-overview-grid").flatMap(
      declarationsOf,
    );
    const columns = gridDeclarations.find((d) => d.property === "grid-template-columns");
    const columnMin = rem(/min\(100%,\s*([^)]+)\)/.exec(columns?.value ?? "")?.[1] ?? "");
    const gaps = gridDeclarations.filter((d) => d.property === "gap").map((d) => rem(d.value));
    expect(gaps.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (let step = 0; step <= 64 * 16; step++) {
      const width = step * PX;
      for (const scrollbar of [0, CLASSIC_SCROLLBAR]) {
        // No query container at all means the collapse never applies.
        const measured =
          container === null ? Number.POSITIVE_INFINITY : width + padding + scrollbars * scrollbar;
        const span = measured <= threshold ? 1 : 2;
        for (const gap of gaps) {
          const fit = Math.max(1, Math.floor((width + gap) / (columnMin + gap)));
          if (span > fit) violations.push(`grid ${width}rem, gap ${gap}rem, bar ${scrollbar}rem`);
        }
      }
    }
    expect(violations.slice(0, 3)).toEqual([]);
  });
});
