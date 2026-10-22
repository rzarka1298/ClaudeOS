import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The CSS contract of the Phase 8 class set (plan 08-10; 08-UI-SPEC "Control
 * colours (binding)", S1 layout table, S2 Controls, R-08, R-09, R-F4).
 *
 * Like `tokens.test.ts` it audits `styles.css` from disk: the file that ships
 * is the file that gets measured. A rule that decides its own colours, states
 * its own focus ring and keeps a hit area is the whole point of D-31, so every
 * assertion below names a property a control must keep under both of
 * Obsidian's control stylesheets, not a snapshot of today's wording.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const STYLESHEET = readFileSync(join(SRC_DIR, "styles.css"), "utf8");
const TOKENS_TEST = readFileSync(join(SRC_DIR, "tokens.test.ts"), "utf8");

/** Blanks comment text while preserving line count, so scans read CODE only. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

interface StyleRule {
  readonly selectors: readonly string[];
  readonly body: string;
  readonly atStack: readonly string[];
}

interface Declaration {
  readonly property: string;
  readonly value: string;
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

function declarationsOf(rule: StyleRule): Declaration[] {
  const declarations: Declaration[] = [];
  for (const chunk of rule.body.split(";")) {
    const text = chunk.trim();
    if (text.length === 0 || text.includes("{")) continue;
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    declarations.push({
      property: text.slice(0, colon).trim(),
      value: text
        .slice(colon + 1)
        .replace(/\s+/g, " ")
        .trim(),
    });
  }
  return declarations;
}

const CODE = codeOnly(STYLESHEET);
const RULES = parseRules(CODE);

const ROOT = ".ccc-command-center";

/**
 * A selector reduced to `<state suffix>` for one class: the optional
 * `.ccc-command-center ` prefix and an optional tag (`select.ccc-select`) are
 * stripped, so `.ccc-command-center select.ccc-select:focus-visible` and
 * `.ccc-select:focus-visible` both yield `:focus-visible`. `null` when the
 * selector is not about this class.
 */
function stateOf(selector: string, className: string): string | null {
  const stripped = selector.startsWith(`${ROOT} `) ? selector.slice(ROOT.length + 1) : selector;
  const match = new RegExp(`^(?:[a-z][a-z0-9]*)?\\.${className}(?![\\w-])(.*)$`).exec(stripped);
  return match ? (match[1] ?? "") : null;
}

/** Merged declarations of every rule whose selector is exactly this class plus `suffix`. */
function declared(className: string, suffix = ""): Declaration[] {
  return RULES.filter((rule) => rule.atStack.length === 0)
    .filter((rule) => rule.selectors.some((selector) => stateOf(selector, className) === suffix))
    .flatMap(declarationsOf);
}

function declaredValue(className: string, property: string, suffix = ""): string | undefined {
  return declared(className, suffix)
    .filter((declaration) => declaration.property === property)
    .at(-1)?.value;
}

/** Every rule (at any at-rule depth) that names this class at all. */
function rulesNaming(className: string): StyleRule[] {
  return RULES.filter((rule) =>
    rule.selectors.some((selector) => stateOf(selector, className) !== null),
  );
}

function listFrom(source: string, anchor: string): string[] {
  const start = source.indexOf(anchor);
  expect(start, `${anchor} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("];", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

// ---------------------------------------------------------------------------

describe("Task 1 (tracer): the root and the new controls state their own colours (D-31, R-08)", () => {
  it("Test 1: the root rule declares color-scheme: dark, and the pinned floor list is unchanged", () => {
    const rootRules = RULES.filter(
      (rule) => rule.atStack.length === 0 && rule.selectors.includes(ROOT),
    );
    const root = rootRules.find((rule) =>
      declarationsOf(rule).some((d) => d.property === "container-type"),
    );
    expect(root, "no root rule that declares container-type").toBeDefined();
    const scheme = declarationsOf(root as StyleRule).find((d) => d.property === "color-scheme");
    expect(scheme?.value).toBe("dark");

    // The host-variable floor is the 15 names tokens.test.ts pins; Phase 8 adds none.
    expect(listFrom(TOKENS_TEST, "const FLOOR_VARIABLES = [").sort()).toEqual(
      [
        "--text-normal",
        "--text-muted",
        "--text-faint",
        "--interactive-normal",
        "--interactive-hover",
        "--input-shadow",
        "--input-shadow-hover",
        "--background-modifier-form-field",
        "--background-modifier-form-field-hover",
        "--background-modifier-border",
        "--background-modifier-border-hover",
        "--background-modifier-border-focus",
        "--dropdown-background",
        "--dropdown-background-hover",
        "--input-placeholder-color",
      ].sort(),
    );
  });

  const NEW_CONTROLS = [
    "ccc-switch",
    "ccc-select",
    "ccc-settings-nav-item",
    "ccc-bundle-preview",
  ] as const;

  it("Test 2: the four new controls are in CONTROLS, and every rule that sets color sets --text-color to the same value", () => {
    const controls = listFrom(TOKENS_TEST, "const CONTROLS = [");
    for (const name of NEW_CONTROLS) expect(controls, name).toContain(name);

    let checked = 0;
    const offenders: string[] = [];
    for (const name of NEW_CONTROLS) {
      const named = rulesNaming(name);
      expect(named.length, `no rule names .${name}`).toBeGreaterThan(0);
      for (const rule of named) {
        const declarations = declarationsOf(rule);
        const colour = declarations.find((d) => d.property === "color");
        if (colour === undefined) continue;
        checked += 1;
        const carrier = declarations.find((d) => d.property === "--text-color");
        if (carrier?.value !== colour.value)
          offenders.push(`${rule.selectors.join(", ")} { color }`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(NEW_CONTROLS.length);
    expect(offenders).toEqual([]);
  });

  it("Test 3: .ccc-select neutralises the host arrow and states its own face, ink and edge", () => {
    expect(declaredValue("ccc-select", "appearance")).toBe("none");
    expect(declaredValue("ccc-select", "background-image")).toBe("none");
    expect(declaredValue("ccc-select", "background-color")).toBe("var(--ccc-surface)");
    expect(declaredValue("ccc-select", "color")).toBe("var(--ccc-ink)");
    expect(declaredValue("ccc-select", "--text-color")).toBe("var(--ccc-ink)");
    expect(declaredValue("ccc-select", "border")).toBe(
      "var(--ccc-border-hairline) solid var(--ccc-ink-muted)",
    );
  });

  it("Test 3: the wrap draws the decorative arrow in ink, as CSS content, never as text", () => {
    const arrow = declared("ccc-select-wrap", "::after");
    expect(arrow.find((d) => d.property === "content")?.value).toBe('"▾"');
    expect(arrow.find((d) => d.property === "color")?.value).toBe("var(--ccc-ink)");
    expect(arrow.find((d) => d.property === "pointer-events")?.value).toBe("none");
    expect(declaredValue("ccc-select-wrap", "position")).toBe("relative");
  });

  it("Test 4: the switch is told apart by On and Off rules, with an inset ink bar and a weight change", () => {
    const on = '[aria-checked="true"]';
    const off = '[aria-checked="false"]';
    expect(declaredValue("ccc-switch", "border", on)).toContain("var(--ccc-ink)");
    expect(declaredValue("ccc-switch", "background-color", on)).toBe("var(--ccc-surface)");
    expect(declaredValue("ccc-switch", "font-weight", on)).toBe("var(--ccc-weight-strong)");
    expect(declaredValue("ccc-switch", "box-shadow", on)).toBe(
      "inset var(--ccc-focus-ring) 0 0 0 var(--ccc-ink)",
    );
    expect(declaredValue("ccc-switch", "color", on)).toBe("var(--ccc-ink)");

    expect(declaredValue("ccc-switch", "border", off)).toContain("var(--ccc-ink-muted)");
    expect(declaredValue("ccc-switch", "background-color", off)).toBe("transparent");
    expect(declaredValue("ccc-switch", "font-weight", off)).toBe("var(--ccc-weight-regular)");
    expect(declaredValue("ccc-switch", "color", off)).toBe("var(--ccc-ink-muted)");
  });

  it("Test 4: disabled looks come from aria-disabled only, never :disabled", () => {
    expect(declaredValue("ccc-switch", "opacity", '[aria-disabled="true"]')).toBe("0.55");
    for (const name of NEW_CONTROLS) {
      for (const rule of rulesNaming(name)) {
        for (const selector of rule.selectors) expect(selector, name).not.toMatch(/:disabled/);
      }
    }
  });

  it.each(NEW_CONTROLS)(
    "Test 5: .%s has the 2px accent focus ring and a hit area of --ccc-space-lg",
    (name) => {
      const ring = declared(name, ":focus-visible");
      expect(ring.find((d) => d.property === "outline")?.value).toBe(
        "var(--ccc-focus-ring) solid var(--ccc-accent)",
      );
      expect(declaredValue(name, "min-block-size")).toBe("var(--ccc-space-lg)");
      expect(declaredValue(name, "min-inline-size")).toBe("var(--ccc-space-lg)");
    },
  );

  it("the Settings frame is a container whose nav grid steps down at 48rem, 34rem and 24rem", () => {
    const panel = RULES.find(
      (rule) =>
        rule.atStack.length === 0 &&
        rule.selectors.includes(`${ROOT} .ccc-research`) &&
        rule.selectors.includes(`${ROOT} .ccc-settings`),
    );
    expect(panel, ".ccc-settings joins the .ccc-research panel selector list").toBeDefined();

    const layout = (query: string, property: string): string | undefined =>
      RULES.filter((rule) => rule.atStack.some((at) => at === `@container ${query}`))
        .filter((rule) =>
          rule.selectors.some((selector) => stateOf(selector, "ccc-settings-layout") === ""),
        )
        .flatMap(declarationsOf)
        .find((d) => d.property === property)?.value;

    expect(declaredValue("ccc-settings-layout", "display")).toBe("grid");
    expect(declaredValue("ccc-settings-layout", "grid-template-columns")).toMatch(
      /^minmax\(calc\(var\(--ccc-space-3xl\) \* 2\.5\), calc\(var\(--ccc-space-3xl\) \* 3\.5\)\) minmax\(0, 1fr\)$/,
    );
    expect(declaredValue("ccc-settings-layout", "gap")).toBe("var(--ccc-space-lg)");
    expect(layout("(max-width: 48rem)", "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(layout("(max-width: 48rem)", "gap")).toBe("var(--ccc-space-md)");

    // Below 34rem a row's control wraps under its text; below 24rem a nav item is full width.
    const stacked = RULES.filter((rule) =>
      rule.atStack.some((at) => at === "@container (max-width: 34rem)"),
    ).some((rule) =>
      rule.selectors.some((selector) => stateOf(selector, "ccc-setting-row-control") === ""),
    );
    expect(stacked).toBe(true);
    const narrow = RULES.filter((rule) =>
      rule.atStack.some((at) => at === "@container (max-width: 24rem)"),
    ).some((rule) =>
      rule.selectors.some((selector) => stateOf(selector, "ccc-settings-nav-item") === ""),
    );
    expect(narrow).toBe(true);
  });

  it("the selected nav item is told apart by weight, fill and an inset ink bar, never by accent", () => {
    const selected = '[aria-current="page"]';
    expect(declaredValue("ccc-settings-nav-item", "font-weight", selected)).toBe(
      "var(--ccc-weight-strong)",
    );
    expect(declaredValue("ccc-settings-nav-item", "background-color", selected)).toBe(
      "var(--ccc-surface)",
    );
    expect(declaredValue("ccc-settings-nav-item", "color", selected)).toBe("var(--ccc-ink)");
    expect(declaredValue("ccc-settings-nav-item", "box-shadow", selected)).toBe(
      "inset var(--ccc-focus-ring) 0 0 0 var(--ccc-ink)",
    );
    expect(declaredValue("ccc-settings-nav-item", "color")).toBe("var(--ccc-ink-muted)");
    expect(declaredValue("ccc-settings-nav-item", "overflow-wrap")).toBe("break-word");
  });

  it("the display path wraps anywhere and stays selectable mono text", () => {
    expect(declaredValue("ccc-display-path", "overflow-wrap")).toBe("anywhere");
    expect(declaredValue("ccc-display-path", "font-family")).toBe("var(--ccc-font-mono)");
    expect(declaredValue("ccc-display-path", "font-size")).toBe("var(--ccc-text-label)");
    expect(declaredValue("ccc-display-path", "user-select")).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Task 2: status chips, health rows, the bundle and the Overview slice classes
// ---------------------------------------------------------------------------

/** The text of the Phase 8 section: from its banner comment to the next section's banner. */
const BANNER = STYLESHEET.indexOf("Phase 8 - Settings, Diagnostics");
const SECTION_START = BANNER < 0 ? -1 : STYLESHEET.lastIndexOf("/*", BANNER);
const SECTION_END = STYLESHEET.indexOf("/* Phase 05.1 wave-5 visual fixes");
const SECTION_SOURCE =
  SECTION_START < 0 ? "" : codeOnly(STYLESHEET.slice(SECTION_START, SECTION_END));
const SECTION_RULES = parseRules(SECTION_SOURCE);

const TOKEN_NAMES = new Set(
  RULES.filter((rule) => rule.selectors.includes(":where(.ccc-command-center)")).flatMap((rule) =>
    declarationsOf(rule).map((d) => d.property),
  ),
);

describe("Task 2: status chips never use colour alone (D-07, D-33, R-05, R-06, R-F4)", () => {
  const STATUS = (status: string): string => `[data-status="${status}"]`;

  it("Test 1: each data-status value maps to the ink and border style of the UI-SPEC table", () => {
    const table: ReadonlyArray<readonly [string, string, string]> = [
      ["ok", "var(--ccc-ink)", "solid"],
      ["setup-needed", "var(--ccc-ink-muted)", "dashed"],
      ["degraded", "var(--ccc-ink)", "solid"],
      ["failing", "var(--ccc-danger)", "solid"],
      ["unknown", "var(--ccc-ink-muted)", "dotted"],
      ["not-in-version", "var(--ccc-ink-muted)", "dotted"],
    ];
    for (const [status, ink, style] of table) {
      expect(declaredValue("ccc-badge", "color", STATUS(status)), `${status} ink`).toBe(ink);
      expect(declaredValue("ccc-badge", "border-style", STATUS(status)), `${status} border`).toBe(
        style,
      );
    }
  });

  it("Test 1: all chip borders use --ccc-ink-muted, and only failing uses the danger colour", () => {
    expect(declaredValue("ccc-badge", "border-color", "[data-status]")).toBe(
      "var(--ccc-ink-muted)",
    );
    const dangerous = SECTION_RULES.filter((rule) =>
      rule.selectors.some((selector) => stateOf(selector, "ccc-badge")?.startsWith("[data-status")),
    )
      .filter((rule) => rule.body.includes("--ccc-danger"))
      .flatMap((rule) => rule.selectors);
    expect(dangerous.every((selector) => selector.includes(STATUS("failing")))).toBe(true);
    expect(dangerous.length).toBeGreaterThan(0);
    // setup-needed is guidance, never an error: no danger ink anywhere in its rules.
    for (const rule of rulesNaming("ccc-badge")) {
      if (rule.selectors.some((selector) => selector.includes(STATUS("setup-needed")))) {
        expect(rule.body).not.toContain("--ccc-danger");
      }
    }
  });

  it("Test 2: a health row is two columns above 34rem and one below, with a hairline between rows", () => {
    expect(declaredValue("ccc-health-row", "display")).toBe("grid");
    expect(declaredValue("ccc-health-row", "grid-template-columns")).toBe(
      "minmax(0, 1fr) minmax(0, 2fr)",
    );
    const narrow = RULES.filter((rule) =>
      rule.atStack.includes("@container (max-width: 34rem)"),
    ).filter((rule) => rule.selectors.some((s) => stateOf(s, "ccc-health-row") === ""));
    expect(
      narrow.flatMap(declarationsOf).find((d) => d.property === "grid-template-columns")?.value,
    ).toBe("minmax(0, 1fr)");
    expect(declaredValue("ccc-health-row", "border-block-start", " + .ccc-health-row")).toBe(
      "var(--ccc-border-hairline) solid var(--ccc-border)",
    );
    expect(declaredValue("ccc-health-row", "padding-block-start", " + .ccc-health-row")).toBe(
      "var(--ccc-space-lg)",
    );
    expect(declaredValue("ccc-health-list", "gap")).toBe("var(--ccc-space-lg)");
    // The health block measures its own width, not the pane's.
    expect(declaredValue("ccc-health", "container-type")).toBe("inline-size");
  });

  it("Test 2: commands and display paths wrap anywhere", () => {
    expect(declaredValue("ccc-health-command", "overflow-wrap")).toBe("anywhere");
    expect(declaredValue("ccc-health-command", "font-family")).toBe("var(--ccc-font-mono)");
    expect(declaredValue("ccc-health-command", "font-size")).toBe("var(--ccc-text-label)");
    expect(declaredValue("ccc-display-path", "overflow-wrap")).toBe("anywhere");
  });

  it("Test 3: the bundle preview is mono at the label size, wraps, and scrolls vertically only", () => {
    expect(declaredValue("ccc-bundle-preview", "font-family")).toBe("var(--ccc-font-mono)");
    expect(declaredValue("ccc-bundle-preview", "font-size")).toBe("var(--ccc-text-label)");
    expect(declaredValue("ccc-bundle-preview", "color")).toBe("var(--ccc-ink)");
    expect(declaredValue("ccc-bundle-preview", "background-color")).toBe("var(--ccc-surface)");
    expect(declaredValue("ccc-bundle-preview", "white-space")).toBe("pre-wrap");
    expect(declaredValue("ccc-bundle-preview", "overflow-wrap")).toBe("anywhere");
    expect(declaredValue("ccc-bundle-preview", "max-block-size")).toBe(
      "calc(var(--ccc-space-3xl) * 5)",
    );
    expect(declaredValue("ccc-bundle-preview", "overflow-y")).toBe("auto");
    expect(declaredValue("ccc-bundle-preview", "overflow-x")).toBe("hidden");
  });

  it("Test 4: the Today and Technology blocks use only existing tokens and no new size", () => {
    const names = ["ccc-today-section", "ccc-today-note", "ccc-intel-latest"];
    for (const name of names) {
      const named = rulesNaming(name);
      expect(named.length, `no rule names .${name}`).toBeGreaterThan(0);
      for (const rule of named) {
        for (const { property, value } of declarationsOf(rule)) {
          const tokens = [...value.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1] ?? "");
          for (const token of tokens) {
            expect(TOKEN_NAMES.has(token), `${name} { ${property} } uses unknown ${token}`).toBe(
              true,
            );
          }
          const literals = value
            .replace(/var\(--[\w-]+\)/g, "")
            .match(/(?<![\w-])(?:\d*\.)?\d+(?:px|rem|em|ms|s|vh|vw|%|ch|ex|pt)\b/g);
          const sizes = (literals ?? []).filter((literal) => !/^0+(\.0+)?[a-z%]*$/.test(literal));
          expect(sizes, `${name} { ${property}: ${value} }`).toEqual([]);
        }
      }
    }
    // The Today label step is the Label role: Label size, 600, tracked, uppercase, muted.
    expect(declaredValue("ccc-today-section", "font-size")).toBe("var(--ccc-text-label)");
    expect(declaredValue("ccc-today-section", "font-weight")).toBe("var(--ccc-weight-strong)");
    expect(declaredValue("ccc-today-section", "text-transform")).toBe("uppercase");
    expect(declaredValue("ccc-today-section", "color")).toBe("var(--ccc-ink-muted)");
    expect(declaredValue("ccc-today-note", "font-size")).toBe("var(--ccc-text-label)");
  });

  it("every class of the UI-SPEC class list has a rule", () => {
    const CLASSES = [
      "ccc-settings",
      "ccc-settings-header",
      "ccc-settings-status",
      "ccc-settings-layout",
      "ccc-settings-nav",
      "ccc-settings-nav-item",
      "ccc-settings-content",
      "ccc-setting-row",
      "ccc-setting-row-text",
      "ccc-setting-row-control",
      "ccc-switch",
      "ccc-select-wrap",
      "ccc-select",
      "ccc-display-path",
      "ccc-health",
      "ccc-health-summary",
      "ccc-health-list",
      "ccc-health-row",
      "ccc-health-parts",
      "ccc-health-part",
      "ccc-health-command",
      "ccc-bundle",
      "ccc-bundle-preview",
      "ccc-today-section",
      "ccc-today-note",
      "ccc-intel-latest",
    ];
    expect(CLASSES.filter((name) => rulesNaming(name).length === 0)).toEqual([]);
  });

  it("Test 5 (global guard): the Phase 8 section adds no !important, hex colour, custom property, px or foreign animation", () => {
    expect(SECTION_START).toBeGreaterThan(-1);
    expect(SECTION_END).toBeGreaterThan(SECTION_START);
    expect(SECTION_RULES.length).toBeGreaterThan(30);
    expect(SECTION_SOURCE).not.toMatch(/!\s*important/);
    expect(SECTION_SOURCE).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab)\s*\(/i);
    expect(SECTION_SOURCE).not.toMatch(/\b\d*\.?\d+px\b/);
    expect(SECTION_SOURCE).not.toMatch(/@keyframes|animation\s*:/);
    // The only custom property a rule here may state is the label carrier.
    const customProperties = SECTION_RULES.flatMap(declarationsOf)
      .map((d) => d.property)
      .filter((property) => property.startsWith("--") && property !== "--text-color");
    expect(customProperties).toEqual([]);
    // Every transition drives from a motion token; every selector sits under the root.
    for (const rule of SECTION_RULES) {
      for (const selector of rule.selectors) {
        expect(selector.startsWith(`${ROOT} `), selector).toBe(true);
      }
      for (const { property, value } of declarationsOf(rule)) {
        if (/^(transition|animation)(-duration)?$/.test(property) && value !== "none") {
          expect(value, `${rule.selectors.join(", ")} { ${property} }`).toContain(
            "var(--ccc-motion-fast)",
          );
        }
      }
    }
    // Every var() reference resolves to an existing --ccc-* token.
    const unknown = [...SECTION_SOURCE.matchAll(/var\((--[\w-]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((token) => !TOKEN_NAMES.has(token));
    expect(unknown).toEqual([]);
  });
});
