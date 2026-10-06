import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The approvals family of the stylesheet (UI-SPEC "Color", "Spacing Scale",
 * "Motion", "Width behaviour", Non-Negotiables 1, 2 and 10), audited from the
 * file on disk the way `tokens.test.ts` audits the token block: a rule that
 * strays from the design system fails here, at the commit that introduces it.
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

const FAMILY = /\.ccc-(approvals?\b|approval-|diff\b|diff-|filter-|nav-count|control-token)/;
/** Every rule that names a class of the approvals family, wherever the rule lives. */
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

function rulesFor(selector: string): StyleRule[] {
  return ALL_RULES.filter((rule) => rule.selectors.includes(selector));
}

function declaredValue(selector: string, property: string): string | undefined {
  for (const rule of rulesFor(selector)) {
    const found = declarations(rule).find((declaration) => declaration.property === property);
    if (found !== undefined) return found.value;
  }
  return undefined;
}

describe("the approvals stylesheet family (Test 10)", () => {
  it.each([
    ".ccc-approvals",
    ".ccc-approvals-layout",
    ".ccc-approval-list",
    ".ccc-approval-row",
    ".ccc-approval-row-button",
    ".ccc-approval-detail",
    ".ccc-approval-block",
    ".ccc-approval-state",
    ".ccc-approval-decision",
    ".ccc-approval-button",
    ".ccc-diff",
    ".ccc-diff-line",
    ".ccc-filter-group",
    ".ccc-filter-chip",
    ".ccc-nav-count",
  ])("has a rule for %s", (selector) => {
    expect(
      NEW_RULES.some((rule) => rule.selectors.includes(selector)),
      selector,
    ).toBe(true);
  });

  it("uses only --ccc-* tokens for colour: no literal, no px, no importance override, no inline style hook", () => {
    const offenders = NEW_RULES.flatMap((rule) =>
      declarations(rule)
        .filter(
          (declaration) =>
            /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|lab|color)\(/i.test(declaration.value) ||
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

  it("keeps Approve once and Deny colourless: neither accent nor danger outside the shared focus ring", () => {
    const decisionRules = NEW_RULES.filter((rule) =>
      rule.selectors.some((selector) => selector.includes(".ccc-approval-button")),
    );
    expect(decisionRules.length).toBeGreaterThan(0);
    for (const rule of decisionRules) {
      const focusRing = rule.selectors.every((selector) => selector.includes(":focus-visible"));
      if (focusRing) continue;
      expect(rule.body, rule.selectors.join(", ")).not.toMatch(/--ccc-accent|--ccc-danger/);
    }
    const border = declaredValue(".ccc-approval-button", "border");
    expect(border).toContain("var(--ccc-ink)");
  });

  it("spends the danger token only on the Failed state", () => {
    const users = NEW_RULES.filter((rule) => rule.body.includes("--ccc-danger"));
    for (const rule of users) {
      expect(
        rule.selectors.every((selector) => selector.includes('[data-state="failed"]')),
        rule.selectors.join(", "),
      ).toBe(true);
    }
  });

  it("makes the decision pair at least --ccc-space-xl high with --ccc-space-md between them", () => {
    expect(declaredValue(".ccc-approval-button", "min-height")).toBe("var(--ccc-space-xl)");
    expect(declaredValue(".ccc-approval-decision", "gap")).toBe("var(--ccc-space-md)");
    expect(declaredValue(".ccc-approval-decision", "flex-wrap")).toBe("wrap");
  });

  it("gives every new interactive control a hit area of at least --ccc-space-lg", () => {
    for (const selector of [
      ".ccc-approval-button",
      ".ccc-approval-row-button",
      ".ccc-filter-chip",
    ]) {
      const height = declaredValue(selector, "min-height");
      const width = declaredValue(selector, "min-width");
      expect(["var(--ccc-space-lg)", "var(--ccc-space-xl)"], `${selector} min-height`).toContain(
        height,
      );
      expect(["var(--ccc-space-lg)", "var(--ccc-space-xl)"], `${selector} min-width`).toContain(
        width,
      );
    }
  });

  it("transitions only on --ccc-motion-fast and never animates", () => {
    for (const rule of NEW_RULES) {
      for (const declaration of declarations(rule)) {
        if (/^animation/.test(declaration.property)) {
          expect(declaration.value, rule.selectors.join(", ")).toBe("none");
        }
        if (/^transition/.test(declaration.property) && declaration.value !== "none") {
          const durations = [...declaration.value.matchAll(/var\((--ccc-motion-[\w-]+)\)/g)].map(
            (match) => match[1],
          );
          expect(durations.length, rule.selectors.join(", ")).toBeGreaterThan(0);
          for (const duration of durations) expect(duration).toBe("--ccc-motion-fast");
          expect(declaration.value).not.toMatch(/\b\d+m?s\b/);
        }
      }
      expect(rule.atStack.some((at) => at.startsWith("@keyframes"))).toBe(false);
    }
    expect(CODE).not.toMatch(/@keyframes\s+ccc-(approval|diff|filter)/);
  });

  it("queries a container only at 48rem, 34rem or 24rem", () => {
    const thresholds = new Set<string>();
    for (const rule of NEW_RULES) {
      for (const at of rule.atStack) {
        for (const match of at.matchAll(/(?:min|max)-width:\s*([\d.]+rem)/g)) {
          thresholds.add(match[1] as string);
        }
        expect(at.startsWith("@container"), at).toBe(true);
      }
    }
    for (const threshold of thresholds) expect(["48rem", "34rem", "24rem"]).toContain(threshold);
    expect(thresholds.has("48rem")).toBe(true);
  });

  it("lays the section out as a size container with the 48rem master and detail grid", () => {
    expect(declaredValue(".ccc-approvals", "container-type")).toBe("inline-size");
    const wide = ALL_RULES.find(
      (rule) =>
        rule.selectors.includes(".ccc-approvals-layout") &&
        rule.atStack.some((at) => at.includes("min-width: 48rem")),
    );
    expect(wide).toBeDefined();
    expect(wide?.body).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(20rem,\s*3fr\)/,
    );
  });

  it("marks a requester block with a dashed border and an engine block with none", () => {
    const requester = ALL_RULES.find((rule) =>
      rule.selectors.includes('.ccc-approval-block[data-origin="requester"]'),
    );
    expect(requester).toBeDefined();
    expect(requester?.body).toMatch(/border:[^;]*dashed/);
    expect(
      ALL_RULES.some(
        (rule) =>
          rule.selectors.includes('.ccc-approval-block[data-origin="engine"]') &&
          /border:[^;]*(solid|dashed|dotted)/.test(rule.body),
      ),
    ).toBe(false);
  });

  it("styles diff lines by weight and a muted ink, with no colour of their own", () => {
    expect(declaredValue('.ccc-diff-line[data-kind="added"]', "font-weight")).toBe(
      "var(--ccc-weight-strong)",
    );
    expect(declaredValue('.ccc-diff-line[data-kind="removed"]', "font-weight")).toBe(
      "var(--ccc-weight-strong)",
    );
    expect(declaredValue('.ccc-diff-line[data-kind="context"]', "color")).toBe(
      "var(--ccc-ink-muted)",
    );
    expect(declaredValue(".ccc-diff", "font-family")).toBe("var(--ccc-font-mono)");
    expect(declaredValue(".ccc-diff-text", "white-space")).toBe("pre-wrap");
    expect(declaredValue(".ccc-diff-text", "overflow-wrap")).toBe("anywhere");
  });

  it("shares the pressed-pill treatment between the range pill and the filter chip, never with accent or danger on cream", () => {
    const pressed = ALL_RULES.filter((rule) =>
      rule.selectors.some(
        (selector) =>
          selector.includes(".ccc-filter-chip") && selector.includes('[aria-pressed="true"]'),
      ),
    );
    expect(pressed.length).toBeGreaterThan(0);
    for (const rule of pressed) {
      if (rule.selectors.every((selector) => selector.includes(":focus-visible"))) {
        expect(rule.body).toContain("--ccc-accent-deep");
        expect(rule.body).not.toContain("--ccc-cream");
      } else {
        expect(rule.body).toContain("var(--ccc-cream)");
        expect(rule.body).not.toMatch(/--ccc-accent|--ccc-danger/);
      }
    }
    const focus = ALL_RULES.filter((rule) =>
      rule.selectors.some(
        (selector) => selector.includes(".ccc-filter-chip") && selector.includes(":focus-visible"),
      ),
    );
    expect(focus.length).toBeGreaterThan(0);
  });

  it("references neither accent nor danger under any cream selector", () => {
    for (const rule of NEW_RULES) {
      const cream =
        rule.selectors.some((selector) => selector.includes('[data-surface="cream"]')) ||
        rule.body.includes("var(--ccc-cream)");
      if (!cream) continue;
      expect(rule.body, rule.selectors.join(", ")).not.toMatch(
        /--ccc-accent(?!-deep)|--ccc-danger/,
      );
    }
  });

  it("gives every new focusable class a visible focus ring", () => {
    for (const selector of [
      ".ccc-approval-button",
      ".ccc-approval-row-button",
      ".ccc-filter-chip",
    ]) {
      const ring = ALL_RULES.find(
        (rule) =>
          rule.selectors.some((s) => s.startsWith(selector) && s.includes(":focus-visible")) &&
          /outline\s*:/.test(rule.body),
      );
      expect(ring, selector).toBeDefined();
    }
  });

  it("styles the Agent runs count chip as a hairline pill with tabular numerals", () => {
    expect(declaredValue(".ccc-nav-count", "border")).toContain("var(--ccc-border-hairline)");
    expect(declaredValue(".ccc-nav-count", "border-radius")).toBe("var(--ccc-radius-pill)");
    expect(declaredValue(".ccc-nav-count", "font-variant-numeric")).toBe("tabular-nums");
    expect(declaredValue(".ccc-nav-count", "color")).toBe("var(--ccc-ink)");
  });

  it("collapses the decision pair to a stacked, full-width column below 24rem", () => {
    const narrow = ALL_RULES.find(
      (rule) =>
        rule.selectors.includes(".ccc-approval-decision") &&
        rule.atStack.some((at) => at.includes("max-width: 24rem")),
    );
    expect(narrow?.body).toMatch(/flex-direction:\s*column/);
  });
});
