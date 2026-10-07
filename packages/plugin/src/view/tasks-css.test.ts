import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Tasks family of the stylesheet (UI-SPEC "Color", "Spacing Scale",
 * "Motion", "Width behaviour", "New CSS classes", Non-Negotiables 1 and 10),
 * audited from the file on disk the way `approvals-css.test.ts` audits the
 * approvals family: a rule that strays from the design system fails here, at
 * the commit that introduces it.
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

/** `.ccc-tasks`, `.ccc-tasks-*`, `.ccc-task-*`, `.ccc-attention*` and `.ccc-project-tasks*`. */
const FAMILY = /\.ccc-(tasks\b|tasks-|task-|attention|project-tasks)/;
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

describe("Test 3: the layout classes the UI-SPEC names all exist, so later plans need no CSS", () => {
  it.each([
    "ccc-tasks",
    "ccc-tasks-header",
    "ccc-tasks-summary",
    "ccc-tasks-status",
    "ccc-tasks-toolbar",
    "ccc-tasks-select",
    "ccc-tasks-layout",
    "ccc-tasks-back",
    "ccc-task-list-region",
    "ccc-task-list-heading",
    "ccc-task-list",
    "ccc-task-row",
    "ccc-task-row-meta",
    "ccc-task-title",
    "ccc-task-row-actions",
    "ccc-task-action",
    "ccc-task-date",
    "ccc-task-row-blocked",
    "ccc-task-list-notice",
    "ccc-task-list-empty",
    "ccc-task-list-error",
    "ccc-task-skeleton",
    "ccc-task-more",
    "ccc-task-detail",
    "ccc-task-form",
    "ccc-task-form-fields",
    "ccc-task-field",
    "ccc-task-form-actions",
    "ccc-task-dirty",
    "ccc-task-note",
    "ccc-task-block",
    "ccc-task-dependencies",
    "ccc-task-dependency",
    "ccc-task-confirm",
    "ccc-attention",
    "ccc-attention-list",
    "ccc-attention-row",
    "ccc-attention-path",
    "ccc-project-tasks",
    "ccc-project-tasks-header",
  ])("has a rule for .%s", (className) => {
    expect(
      NEW_RULES.some((rule) => rule.selectors.some((selector) => names(selector, className))),
      className,
    ).toBe(true);
  });
});

describe("Test 1: the CSS contract of the Tasks family", () => {
  it("has rules to audit", () => {
    expect(NEW_RULES.length).toBeGreaterThan(40);
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

  it.each(["ccc-task-title", "ccc-task-action", "ccc-tasks-back", "ccc-task-dependency"])(
    "gives .%s a hit area of at least --ccc-space-lg in both directions",
    (className) => {
      expect(declared(className, "min-height"), `${className} min-height`).toBe(
        "var(--ccc-space-lg)",
      );
      expect(declared(className, "min-width"), `${className} min-width`).toBe(
        "var(--ccc-space-lg)",
      );
    },
  );

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
          expect(declaration.value).not.toMatch(/\b\d+m?s\b/);
        }
      }
      expect(rule.atStack.some((at) => at.startsWith("@keyframes"))).toBe(false);
    }
    expect(CODE).not.toMatch(/@keyframes\s+ccc-(task|attention|project)/);
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
    expect(thresholds.has("48rem")).toBe(true);
    expect(thresholds.has("34rem")).toBe(true);
  });

  it("lays the destination out as size containers with the 48rem list and detail grid", () => {
    expect(declared("ccc-tasks", "container-type")).toBe("inline-size");
    expect(declared("ccc-project-tasks", "container-type")).toBe("inline-size");
    const wide = ALL_RULES.find(
      (rule) =>
        rule.selectors.includes(".ccc-tasks-layout") &&
        rule.atStack.some((at) => at.includes("min-width: 48rem")),
    );
    expect(wide).toBeDefined();
    expect(wide?.body).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*3fr\)\s*minmax\(20rem,\s*2fr\)/,
    );
    expect(declared("ccc-tasks-layout", "grid-template-columns")).toBe("minmax(0, 1fr)");
  });

  it("makes the detail and form grids one column, then two from 34rem", () => {
    expect(declared("ccc-task-form-fields", "grid-template-columns")).toBe("minmax(0, 1fr)");
    const wide = ALL_RULES.find(
      (rule) =>
        rule.selectors.includes(".ccc-task-form-fields") &&
        rule.atStack.some((at) => at.includes("min-width: 34rem")),
    );
    expect(wide?.body).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });

  it("drops the row actions beneath the meta lines below 34rem, in one column", () => {
    const narrow = ALL_RULES.find(
      (rule) =>
        rule.selectors.includes(".ccc-task-row") &&
        rule.atStack.some((at) => at.includes("max-width: 34rem")),
    );
    expect(narrow?.body).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    const actions = ALL_RULES.find(
      (rule) =>
        rule.selectors.includes(".ccc-task-row .ccc-task-row-actions") &&
        rule.atStack.some((at) => at.includes("max-width: 34rem")),
    );
    expect(actions?.body).toMatch(/order:\s*1/);
  });

  it("places no named grid area, which a Phase 3 audit forbids", () => {
    for (const rule of NEW_RULES) {
      expect(rule.body, rule.selectors.join(", ")).not.toMatch(/grid-area|grid-template-areas/);
    }
  });

  it("shows 'Back to tasks' only where the detail stacks", () => {
    expect(declared("ccc-tasks-back", "display")).toBe("none");
    const stacked = ALL_RULES.find(
      (rule) =>
        rule.selectors.includes(".ccc-tasks-back") &&
        rule.atStack.some((at) => at.includes("max-width: 48rem")),
    );
    expect(stacked?.body).toMatch(/display:\s*inline-flex/);
  });

  it("spends no cream anywhere in the family: the only cream surface is the pressed filter chip", () => {
    for (const rule of NEW_RULES) {
      expect(rule.body, rule.selectors.join(", ")).not.toContain("--ccc-cream");
      expect(
        rule.selectors.some((selector) => selector.includes('[data-surface="cream"]')),
        rule.selectors.join(", "),
      ).toBe(false);
    }
    const pressed = ALL_RULES.filter((rule) =>
      rule.selectors.some(
        (selector) =>
          selector.includes(".ccc-filter-chip") && selector.includes('[aria-pressed="true"]'),
      ),
    );
    expect(pressed.some((rule) => rule.body.includes("var(--ccc-cream)"))).toBe(true);
  });

  it("spends the accent only on the focus ring and the danger colour nowhere", () => {
    for (const rule of NEW_RULES) {
      if (rule.body.includes("--ccc-accent")) {
        expect(
          rule.selectors.every((selector) => selector.includes(":focus-visible")),
          rule.selectors.join(", "),
        ).toBe(true);
      }
      expect(rule.body, rule.selectors.join(", ")).not.toContain("--ccc-danger");
    }
  });

  it.each(["ccc-task-title", "ccc-task-action", "ccc-tasks-back", "ccc-task-dependency"])(
    "gives .%s a visible focus ring",
    (className) => {
      const ring = ALL_RULES.find(
        (rule) =>
          rule.selectors.some((s) => names(s, className) && s.includes(":focus-visible")) &&
          /outline\s*:/.test(rule.body),
      );
      expect(ring, className).toBeDefined();
    },
  );

  it("marks requester-supplied text in a dashed block, as the approvals family does", () => {
    const block = ALL_RULES.find((rule) =>
      rule.selectors.includes('.ccc-task-block[data-origin="requester"]'),
    );
    expect(block?.body).toMatch(/border:[^;]*dashed/);
  });
});

describe("Test 2: states reach CSS through data attributes, and none relies on colour alone", () => {
  const STATE_ATTRIBUTES = ["data-dimmed", "data-overdue", "data-selected", "data-busy"] as const;

  it.each(STATE_ATTRIBUTES)("has a rule for [%s]", (attribute) => {
    const rules = NEW_RULES.filter((rule) =>
      rule.selectors.some((selector) => selector.includes(`[${attribute}`)),
    );
    expect(rules.length, attribute).toBeGreaterThan(0);
  });

  it.each(STATE_ATTRIBUTES)(
    "makes [%s] visible through weight, border shape or an opacity token, never colour alone",
    (attribute) => {
      const rules = NEW_RULES.filter((rule) =>
        rule.selectors.some((selector) => selector.includes(`[${attribute}`)),
      );
      const cues = rules.flatMap((rule) =>
        declarations(rule).filter(
          (declaration) =>
            declaration.property === "font-weight" ||
            declaration.property === "opacity" ||
            declaration.property === "box-shadow" ||
            (declaration.property.startsWith("border") &&
              /dashed|dotted|double/.test(declaration.value)),
        ),
      );
      expect(cues.length, attribute).toBeGreaterThan(0);
      for (const rule of rules) {
        const colourOnly = declarations(rule).every(
          (declaration) =>
            declaration.property === "color" || declaration.property.endsWith("-color"),
        );
        expect(colourOnly, rule.selectors.join(", ")).toBe(false);
      }
    },
  );

  it("dims through the one audited opacity token", () => {
    for (const root of [".ccc-tasks", ".ccc-project-tasks"]) {
      const rule = ALL_RULES.find((candidate) =>
        candidate.selectors.includes(`${root} [data-dimmed="true"]`),
      );
      expect(rule, root).toBeDefined();
      expect(rule?.body).toContain("opacity: var(--ccc-dim-opacity)");
    }
  });

  it("states the overdue date and the selected title in weight 600", () => {
    const overdue = NEW_RULES.find((rule) =>
      rule.selectors.some((selector) => selector.includes('.ccc-task-date[data-overdue="true"]')),
    );
    expect(overdue?.body).toContain("font-weight: var(--ccc-weight-strong)");
    const selected = NEW_RULES.find((rule) =>
      rule.selectors.some((selector) =>
        selector.includes('.ccc-task-row[data-selected="true"] .ccc-task-title'),
      ),
    );
    expect(selected?.body).toContain("font-weight: var(--ccc-weight-strong)");
  });
});

describe("the 06-22 additions to the Tasks family", () => {
  it("clamps the attention title to two lines", () => {
    expect(declared("ccc-attention-title", "line-clamp")).toBe("2");
    expect(declared("ccc-attention-title", "overflow")).toBe("hidden");
  });

  it("gives the three button variants distinct weights without colour or accent", () => {
    const source = STYLESHEET;
    expect(source).toMatch(/\.ccc-tasks \[data-variant="primary"\]/);
    expect(source).toMatch(/\.ccc-tasks \[data-variant="secondary"\]/);
    expect(source).toMatch(/\.ccc-tasks \[data-variant="tertiary"\]/);
  });

  it("hides the pane below 48rem unless a task is chosen", () => {
    const source = STYLESHEET;
    expect(source).toMatch(
      /@container \(max-width: 48rem\)\s*\{\s*\.ccc-tasks-pane\[data-empty="true"\]\s*\{\s*display: none;/,
    );
  });
});
