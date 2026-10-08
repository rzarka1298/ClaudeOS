// Audit (06-audit-w7, plan 06-26): the cell list in visual-matrix.audit.test.ts
// proves the cells are registered; nothing proved every registered cell has a
// committed Linux baseline, that no stray or non-Linux image is committed, or
// that only the two named cells run under reduced motion.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VISUAL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "visual");

/** `<case>-<width>[-reduced]` names the spec derives for every cell. */
function declaredBaselines(spec: string): string[] {
  const source = readFileSync(join(VISUAL, spec), "utf8");
  const names: string[] = [];
  const pattern =
    /\{ (?:view: "[\w-]+", )?(\w+): "([\w-]+)", width: "(full|narrow)", motion: "(full|reduced)" \}/g;
  for (const m of source.matchAll(pattern)) {
    names.push(`${m[2]}-${m[3]}${m[4] === "reduced" ? "-reduced" : ""}-chromium-linux.png`);
  }
  return names;
}

describe.each([
  ["approvals.spec.ts", 21],
  ["tasks.spec.ts", 19],
])("%s Phase 6 baselines", (spec, count) => {
  const dir = join(VISUAL, `${spec}-snapshots`);

  it("has exactly one committed chromium-linux image per declared cell and no other file", () => {
    const declared = declaredBaselines(spec).sort();
    expect(declared).toHaveLength(count);
    expect(readdirSync(dir).sort()).toEqual(declared);
  });
});

describe("reduced motion cells", () => {
  it("are exactly the destructive pending request and the Today task view", () => {
    const reduced = [
      ...declaredBaselines("approvals.spec.ts"),
      ...declaredBaselines("tasks.spec.ts"),
    ]
      .filter((name) => name.includes("-reduced-"))
      .sort();
    expect(reduced).toEqual([
      "approvals-pending-destructive-full-reduced-chromium-linux.png",
      "tasks-today-full-reduced-chromium-linux.png",
    ]);
  });

  it("are rendered with the reduced motion mode passed to the harness", () => {
    for (const spec of ["approvals.spec.ts", "tasks.spec.ts"]) {
      const source = readFileSync(join(VISUAL, spec), "utf8");
      expect(source).toMatch(/harnessUrl\(\{[^}]*\bmotion\b[^}]*\}\)/);
    }
  });
});
