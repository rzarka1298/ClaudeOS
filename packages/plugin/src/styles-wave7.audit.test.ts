import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Audit (wave-7 finding 7, the 04-15 visual review at 360 px): the Phase 4
 * section's layout fixes, each pinned to the rule that carries it. Every
 * value stays a token — `styles-phase4.audit.test.ts` keeps that true.
 */
const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
const MARKER = SOURCE.indexOf("Phase 4 — Projects & Launchers");
const SECTION = SOURCE.slice(MARKER);
const CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

const RULES: readonly Rule[] = [...CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " ")),
  body: m[2] ?? "",
}));

/** Every declaration body whose selector list names `selector` exactly. */
function bodiesFor(selector: string): string {
  return RULES.filter((r) => r.selectors.includes(selector))
    .map((r) => r.body)
    .join(";");
}

describe("Phase 4 layout at narrow widths (wave-7 finding 7)", () => {
  it("the disconnected banner wraps between words, never mid-word", () => {
    const banner = bodiesFor(".ccc-banner");
    expect(banner).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(banner).toMatch(/flex-wrap:\s*wrap/);
  });

  it("launcher fieldsets draw the hairline border token, not the browser default", () => {
    for (const selector of ["fieldset.ccc-radio-group", "fieldset.ccc-template-rows"]) {
      const body = bodiesFor(selector);
      expect(body, selector).toMatch(
        /border:\s*var\(--ccc-border-hairline\)\s+solid\s+var\(--ccc-border\)/,
      );
      expect(body, selector).toMatch(/margin:\s*0/);
      expect(body, selector).toMatch(/border-radius:\s*var\(--ccc-radius-sm\)/);
    }
  });

  it("the Suggestions and Scan folders sections sit a section step below the grid", () => {
    expect(bodiesFor(".ccc-projects-section > .ccc-projects-section")).toMatch(
      /margin-block-start:\s*var\(--ccc-space-lg\)/,
    );
  });

  it("a project card stacks its rows from the top and keeps its footer at the bottom", () => {
    // `.ccc-card`'s `auto 1fr auto` rows hand a stretched card's spare
    // height to its SECOND child, opening a gap mid-card (04-UI-SPEC S3
    // anatomy is one top-down stack, footer last).
    expect(bodiesFor(".ccc-project-card")).toMatch(/display:\s*flex/);
    expect(bodiesFor(".ccc-project-card")).toMatch(/flex-direction:\s*column/);
    expect(bodiesFor(".ccc-project-card > :last-child")).toMatch(/margin-block-start:\s*auto/);
  });

  it("the danger button's comment names the two removals that use it", () => {
    const at = SECTION.indexOf(".ccc-button-danger {");
    const comment = SECTION.slice(SECTION.lastIndexOf("/*", at), at);
    expect(comment).toContain("S5 remove scan folder");
    expect(comment).not.toContain("launcher reset");
  });
});
