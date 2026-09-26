// scripts/check-boundaries.sh — the literal grep backstop (ADR-0019 layer 3).
// Only the fixture-tree exclusions are pinned here: the two fixture trees
// exist to violate the rules, so the backstop skips them, and that skip must
// match their REAL paths only. A substring match let any other path that
// merely contained `lint-fixtures/` escape the scan (judge-r1 finding 9).

import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/check-boundaries.sh";

// Rule 7 (no inline style inside packages/plugin), assembled at runtime so
// this test file is not itself a backstop hit.
const INLINE_STYLE = `export function paint(el: HTMLElement): void {\n  el${"."}style${"."}color = "red";\n}\n`;

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

/** Every repository also tracks one clean source file, so the scan is never empty. */
const CLEAN = { "packages/domain/src/index.ts": "export const answer = 42;\n" };

function backstop(files: Record<string, string>) {
  const repo = gateRepo([SCRIPT], { ...CLEAN, ...files });
  repos.push(repo);
  return repo.run(SCRIPT);
}

describe("check-boundaries.sh fixture exclusions (judge-r1 finding 9)", () => {
  it("skips the real plugin lint-fixtures tree", () => {
    const result = backstop({ "packages/plugin/lint-fixtures/inline-style.ts": INLINE_STYLE });
    expect(result.status).toBe(0);
  });

  it("skips the real boundary-violations tree", () => {
    const result = backstop({
      "packages/test-fixtures/boundary-violations/untrusted/inline-style.ts": `import "obsidian";\n${INLINE_STYLE}`,
    });
    expect(result.status).toBe(0);
  });

  it("still scans a plugin path that merely contains lint-fixtures/", () => {
    const result = backstop({
      "packages/plugin/src/not-lint-fixtures/inline-style.ts": INLINE_STYLE,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("packages/plugin/src/not-lint-fixtures/inline-style.ts");
  });

  it("still scans a plugin path that merely contains boundary-violations/", () => {
    const result = backstop({
      "packages/plugin/src/boundary-violations/inline-style.ts": INLINE_STYLE,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("packages/plugin/src/boundary-violations/inline-style.ts");
  });
});
