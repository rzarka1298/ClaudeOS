import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Audit (04-05 truth 7): the Phase 4 stylesheet section introduces no new
 * colour, size, weight, radius or duration literal, and every new
 * interactive class shows the existing accent focus ring.
 */
const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
const MARKER = SOURCE.indexOf("Phase 4 — Projects & Launchers");
const SECTION = CODE.slice(MARKER);

interface Rule {
  readonly selector: string;
  readonly body: string;
}

const RULES: readonly Rule[] = [...SECTION.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? "").trim(),
  body: m[2] ?? "",
}));

const DECLARATIONS = RULES.flatMap((rule) =>
  rule.body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.includes(":"))
    .map((d) => {
      const i = d.indexOf(":");
      return { selector: rule.selector, prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
    }),
);

/** Removes token references and the offset idiom so only literals remain. */
function literalsOf(value: string): string {
  return value.replace(/var\(--ccc-[a-z0-9-]+\)/g, "").replace(/calc\(\s*-1\s*\*\s*\)/g, "");
}

describe("Phase 4 stylesheet section (D-39, UI-SPEC Non-Negotiables 1-3)", () => {
  it("is present and has rules to audit", () => {
    expect(MARKER).toBeGreaterThan(0);
    expect(RULES.length).toBeGreaterThan(10);
  });

  it("names no colour literal", () => {
    const offenders = DECLARATIONS.filter((d) =>
      /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|lab|color)\(/i.test(literalsOf(d.value)),
    );
    expect(offenders).toEqual([]);
  });

  // Layout measures the UI-SPEC names verbatim (04-UI-SPEC.md, projects grid
  // and Launchers section): reused values, not new scale entries.
  const SPEC_MEASURES = new Set(["16rem", "100%", "68ch"]);

  it("names no size, radius or duration literal beyond zero and the spec's layout measures", () => {
    const offenders = DECLARATIONS.filter((d) =>
      [
        ...literalsOf(d.value).matchAll(
          /(?<![a-z-])(?:\d*\.)?\d+(?:px|rem|em|ms|s|vh|vw|%|ch|ex|pt)\b/gi,
        ),
      ]
        .map((m) => m[0])
        .some((lit) => !/^0+(\.0+)?[a-z%]*$/i.test(lit) && !SPEC_MEASURES.has(lit)),
    );
    expect(offenders).toEqual([]);
  });

  it("names no numeric font-weight", () => {
    const offenders = DECLARATIONS.filter(
      (d) => d.prop === "font-weight" && /\d/.test(literalsOf(d.value)),
    );
    expect(offenders).toEqual([]);
  });

  it.each([".ccc-button-danger", ".ccc-text-input", ".ccc-radio-group input"])(
    "%s shows the existing accent focus ring",
    (cls) => {
      const rule = RULES.find((r) =>
        r.selector.split(",").some((s) => s.trim() === `${cls}:focus-visible`),
      );
      expect(rule).toBeDefined();
      expect(rule?.body).toMatch(
        /outline:\s*var\(--ccc-focus-ring\)\s+solid\s+var\(--ccc-accent\)/,
      );
    },
  );
});
