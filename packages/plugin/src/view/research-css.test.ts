import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Research family of the stylesheet (plan 07-11; 07-UI-SPEC "Color",
 * "Spacing Scale", "Motion", "Width behaviour", "New CSS classes",
 * Non-Negotiables 1 and 7), audited from the file on disk the way
 * `tasks-css.test.ts` audits the Tasks family: a rule that strays from the
 * design system fails here, at the commit that introduces it. The reader's
 * `.ccc-report-*` classes arrive with plan 07-13 and its own audit.
 */

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);
const CODE = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));

interface StyleRule {
  readonly selectors: readonly string[];
  readonly body: string;
  readonly atStack: readonly string[];
}

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
      const head = prelude.trim();
      if (head.startsWith("@")) {
        rules.push(...parseRules(body, [...atStack, head]));
      } else if (head.length > 0) {
        rules.push({
          selectors: head.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
          body,
          atStack,
        });
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

const ALL_RULES = parseRules(CODE);

/** `.ccc-research*`, `.ccc-report-list*`, `.ccc-report-row*` and `.ccc-report-title`. */
const FAMILY = /\.ccc-(research\b|research-|report-list|report-row|report-title)/;
const NEW_RULES = ALL_RULES.filter((rule) =>
  rule.selectors.some((selector) => FAMILY.test(selector)),
);

function declarations(rule: StyleRule): { property: string; value: string }[] {
  return rule.body
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.includes(":"))
    .map((chunk) => {
      const colon = chunk.indexOf(":");
      return { property: chunk.slice(0, colon).trim(), value: chunk.slice(colon + 1).trim() };
    });
}

/** True when a selector names the class anywhere in it. */
function names(selector: string, className: string): boolean {
  return new RegExp(`(^|[^\\w-])\\.${className}(?![\\w-])`).test(selector);
}

/** The rules whose selector ENDS in the class, however it is scoped or stated. */
function rulesOf(className: string): StyleRule[] {
  return NEW_RULES.filter((rule) =>
    rule.selectors.some((selector) =>
      new RegExp(`\\.${className}(?:\\[[^\\]]*\\])?(?::[\\w-]+)*$`).test(selector),
    ),
  );
}

function declared(className: string, property: string): string | undefined {
  for (const rule of rulesOf(className)) {
    const found = declarations(rule).find((declaration) => declaration.property === property);
    if (found !== undefined) return found.value;
  }
  return undefined;
}

describe("Test 6: the layout classes the UI-SPEC names all exist", () => {
  it.each([
    "ccc-research",
    "ccc-research-header",
    "ccc-research-run",
    "ccc-research-subline",
    "ccc-research-strip",
    "ccc-research-status",
    "ccc-research-status-row",
    "ccc-research-run-status",
    "ccc-research-sources-config",
    "ccc-research-layout",
    "ccc-research-list-cell",
    "ccc-research-reader-cell",
    "ccc-research-reason",
    "ccc-research-next-step",
    "ccc-report-list",
    "ccc-report-list-region",
    "ccc-report-row",
    "ccc-report-row-button",
    "ccc-report-row-meta",
  ])("has a rule for .%s", (className) => {
    expect(
      NEW_RULES.some((rule) => rule.selectors.some((selector) => names(selector, className))),
      className,
    ).toBe(true);
  });
});

describe("Test 6: the CSS contract of the Research family", () => {
  it("has rules to audit", () => {
    expect(NEW_RULES.length).toBeGreaterThan(25);
  });

  it("is scoped inside the command-center root and never global", () => {
    for (const rule of NEW_RULES) {
      for (const selector of rule.selectors) {
        // The strip joins the existing shared strip rule block (UI-SPEC "Reused primitives").
        if (selector === ".ccc-research-strip" || selector === ".ccc-tasks-strip") continue;
        expect(selector.startsWith(".ccc-command-center "), selector).toBe(true);
      }
    }
  });

  it("uses only --ccc-* tokens: no colour literal, no px, no importance override", () => {
    const offenders = NEW_RULES.flatMap((rule) =>
      declarations(rule)
        .filter(
          (declaration) =>
            /#[0-9a-f]{3,8}\b/i.test(declaration.value) ||
            /\b(rgba?|hsla?|oklch|lab|color)\(/i.test(declaration.value) ||
            /\b\d*\.?\d+px\b/.test(declaration.value) ||
            /!\s*important/.test(declaration.value),
        )
        .map((declaration) => `${rule.selectors.join(", ")} { ${declaration.property} }`),
    );
    expect(offenders).toEqual([]);
  });

  it("names every custom property it reads, and declares none", () => {
    for (const rule of NEW_RULES) {
      for (const declaration of declarations(rule)) {
        expect(declaration.property.startsWith("--"), declaration.property).toBe(false);
        for (const reference of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          expect(reference[1]?.startsWith("--ccc-"), `${declaration.value}`).toBe(true);
        }
      }
    }
  });

  it("sets no new font size or weight: only the existing text and weight tokens", () => {
    for (const rule of NEW_RULES) {
      for (const declaration of declarations(rule)) {
        if (declaration.property === "font-size") {
          expect(declaration.value, rule.selectors.join(", ")).toMatch(
            /^var\(--ccc-text-(body|label|heading)\)$/,
          );
        }
        if (declaration.property === "font-weight") {
          expect(declaration.value, rule.selectors.join(", ")).toMatch(
            /^(var\(--ccc-weight-(strong|regular|normal)\)|inherit)$/,
          );
        }
      }
    }
  });

  it("gives the row button a hit area of at least --ccc-space-lg in both directions", () => {
    expect(declared("ccc-report-row-button", "min-height")).toBe("var(--ccc-space-lg)");
    expect(declared("ccc-report-row-button", "min-width")).toBe("var(--ccc-space-lg)");
  });

  it("transitions only on --ccc-motion-fast, never animates and never scrolls smoothly", () => {
    for (const rule of NEW_RULES) {
      for (const declaration of declarations(rule)) {
        if (/^animation/.test(declaration.property)) {
          expect(declaration.value, rule.selectors.join(", ")).toBe("none");
        }
        expect(declaration.property, rule.selectors.join(", ")).not.toBe("scroll-behavior");
        if (/^transition/.test(declaration.property) && declaration.value !== "none") {
          const durations = [...declaration.value.matchAll(/var\((--ccc-motion-[\w-]+)\)/g)].map(
            (match) => match[1],
          );
          expect(durations.length, rule.selectors.join(", ")).toBeGreaterThan(0);
          for (const duration of durations) expect(duration).toBe("--ccc-motion-fast");
        }
      }
      expect(rule.atStack.some((at) => at.startsWith("@keyframes"))).toBe(false);
    }
  });

  it("queries a container only at 48rem, 34rem or 24rem, and uses all three", () => {
    const thresholds = new Set<string>();
    for (const rule of NEW_RULES) {
      for (const at of rule.atStack) {
        expect(at.startsWith("@container"), at).toBe(true);
        for (const match of at.matchAll(/(?:min|max)-width:\s*([\d.]+rem)/g)) {
          thresholds.add(match[1] as string);
        }
      }
    }
    for (const threshold of thresholds) expect(["48rem", "34rem", "24rem"]).toContain(threshold);
    for (const needed of ["48rem", "34rem", "24rem"])
      expect(thresholds.has(needed), needed).toBe(true);
  });

  it("makes the destination and its grid size containers with the 48rem list and reader columns", () => {
    expect(declared("ccc-research", "container-type")).toBe("inline-size");
    expect(declared("ccc-research-layout", "container-type")).toBe("inline-size");
    const wide = ALL_RULES.find(
      (rule) =>
        rule.selectors.some((selector) => selector.endsWith(".ccc-research-layout")) &&
        rule.atStack.some((at) => at.includes("min-width: 48rem")),
    );
    expect(wide?.body).toMatch(
      /grid-template-columns:\s*minmax\(14rem,\s*1fr\)\s*minmax\(0,\s*2fr\)/,
    );
    expect(declared("ccc-research-layout", "grid-template-columns")).toBe("minmax(0, 1fr)");
  });

  it("replaces the list with the open report below 48rem", () => {
    const stacked = ALL_RULES.find(
      (rule) =>
        rule.selectors.some((selector) =>
          selector.includes('[data-reader-open="true"] > .ccc-research-list-cell'),
        ) && rule.atStack.some((at) => at.includes("max-width: 48rem")),
    );
    expect(stacked?.body).toMatch(/display:\s*none/);
  });

  it("wraps Run now under the title below 34rem and gives it the full width below 24rem", () => {
    const narrow = ALL_RULES.find(
      (rule) =>
        rule.selectors.some((selector) => selector.endsWith(".ccc-research-run")) &&
        rule.atStack.some((at) => at.includes("max-width: 24rem")),
    );
    expect(narrow?.body).toMatch(/width:\s*100%/);
    expect(
      ALL_RULES.some(
        (rule) =>
          rule.selectors.some((selector) => selector.endsWith(".ccc-research-header")) &&
          declarations(rule).some((d) => d.property === "flex-wrap" && d.value === "wrap"),
      ),
    ).toBe(true);
  });

  it("joins the strip to the shared provenance strip rule block", () => {
    expect(STYLESHEET).toMatch(/\.ccc-tasks-strip,\s*\.ccc-research-strip\s*\{/);
  });

  it("places no named grid area, which a Phase 3 audit forbids", () => {
    for (const rule of NEW_RULES) {
      expect(rule.body, rule.selectors.join(", ")).not.toMatch(/grid-area|grid-template-areas/);
    }
  });

  it("spends no cream, no inline-style hook and the accent only on the focus ring", () => {
    for (const rule of NEW_RULES) {
      expect(rule.body, rule.selectors.join(", ")).not.toContain("--ccc-cream");
      if (rule.body.includes("--ccc-accent")) {
        expect(
          rule.selectors.every((selector) => selector.includes(":focus-visible")),
          rule.selectors.join(", "),
        ).toBe(true);
      }
    }
  });

  it("spends the danger colour only on errors and the Failed state", () => {
    const allowed = ['.ccc-research-state[data-state="failed"]', ".ccc-report-row-error"];
    for (const rule of NEW_RULES) {
      if (!rule.body.includes("--ccc-danger")) continue;
      for (const selector of rule.selectors) {
        expect(
          allowed.some((entry) => selector.endsWith(entry)),
          selector,
        ).toBe(true);
      }
    }
  });

  it("gives the row button a visible focus ring", () => {
    const ring = ALL_RULES.find(
      (rule) =>
        rule.selectors.some(
          (s) => names(s, "ccc-report-row-button") && s.includes(":focus-visible"),
        ) && /outline\s*:/.test(rule.body),
    );
    expect(ring).toBeDefined();
  });
});

describe("Test 6: states reach CSS through data attributes, and none relies on colour alone", () => {
  it("dims through the one audited opacity token", () => {
    const dim = ALL_RULES.find((candidate) =>
      candidate.selectors.some((selector) =>
        selector.endsWith('.ccc-research[data-dimmed="true"]'),
      ),
    );
    expect(dim?.body).toContain("opacity: var(--ccc-dim-opacity)");
  });

  it("marks the selected row with an inset bar, the surface and weight 600, never accent", () => {
    const selected = NEW_RULES.find((rule) =>
      rule.selectors.some((selector) => selector.endsWith('.ccc-report-row[data-selected="true"]')),
    );
    expect(selected?.body).toContain(
      "box-shadow: inset var(--ccc-focus-ring) 0 0 0 var(--ccc-ink)",
    );
    expect(selected?.body).toContain("background-color: var(--ccc-surface)");
    expect(selected?.body).not.toContain("--ccc-accent");
    const weight = NEW_RULES.find((rule) =>
      rule.selectors.some((selector) =>
        selector.includes('.ccc-report-row[data-selected="true"] .ccc-report-row-button'),
      ),
    );
    expect(weight?.body).toContain("font-weight: var(--ccc-weight-strong)");
  });

  it("clamps nothing to a fixed pixel height and never scrolls the list horizontally", () => {
    for (const rule of NEW_RULES) {
      expect(rule.body, rule.selectors.join(", ")).not.toMatch(/overflow-x:\s*(auto|scroll)/);
      expect(rule.body, rule.selectors.join(", ")).not.toMatch(/\b(min-|max-)?height:\s*\d/);
    }
  });
});
