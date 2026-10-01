// Audit (04-15): ADR-0023's Phase 4 amendments record the three widened token
// roles, and the stylesheet actually applies them where the ADR says.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADR = readFileSync(
  join(REPO_ROOT, "docs", "adr", "0023-design-system-and-reduced-motion.md"),
  "utf8",
);
const CSS = readFileSync(join(REPO_ROOT, "packages", "plugin", "src", "styles.css"), "utf8");

function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, CSS.indexOf("}", start));
}

describe("ADR-0023 Phase 4 amendments (audit)", () => {
  const section = ADR.slice(ADR.indexOf("### Phase 4"));

  it("has a Phase 4 section naming all three widened roles and no value change", () => {
    expect(ADR).toContain("### Phase 4");
    expect(section).toContain("`--ccc-danger`");
    expect(section).toContain("`--ccc-font-mono`");
    expect(section).toMatch(/\*\*Label\*\* is weight 400 or 600/);
    expect(section).toContain("No token value changed");
  });

  it("the stylesheet applies --ccc-danger to aria-invalid borders and the removal confirm", () => {
    expect(rule('.ccc-text-input[aria-invalid="true"]')).toContain("var(--ccc-danger)");
    const danger = rule(".ccc-button-danger");
    expect(danger).toContain("solid var(--ccc-danger)");
    // Danger text and border, never a danger fill.
    expect(danger).toContain("background: transparent");
  });

  it("every font-weight declared in the stylesheet is 400 or 600 (two weights only)", () => {
    const weights = new Set(
      [...CSS.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim()),
    );
    for (const w of weights) {
      expect(["400", "600", "var(--ccc-weight-regular)", "var(--ccc-weight-strong)"]).toContain(w);
    }
  });
});
