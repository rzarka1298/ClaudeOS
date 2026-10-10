// Wave 2 audit (plans 05.1-04 truth 9 and 05.1-05 truth 4): lockfile wiring of
// the test-fixtures package, the script header inventory, and the rule count pin.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

describe("test-fixtures dependency links stay inside the lockfile (05.1-04)", () => {
  const lock = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
  const importer = lock.split("\n  packages/test-fixtures:\n")[1]?.split(/\n {2}\S/)[0] ?? "";

  it("links collectors and launchers as workspace packages", () => {
    expect(importer).toContain("version: link:../collectors");
    expect(importer).toContain("version: link:../launchers");
  });

  it("pins better-sqlite3 at the version the other importers already use", () => {
    expect(importer).toMatch(/better-sqlite3:\n\s+specifier: 13\.0\.3\n\s+version: 13\.0\.3/);
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/test-fixtures/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["better-sqlite3"]).toBe("13.0.3");
  });
});

describe("backstop rule inventory (05.1-05)", () => {
  const script = readFileSync(join(REPO_ROOT, "scripts/check-boundaries.sh"), "utf8");

  it("lists rules 1 to 16 contiguously in the header", () => {
    const header = script.split("\n").filter((l) => l.startsWith("#"));
    const numbers = header.flatMap((l) => {
      const m = /^#\s{1,3}(\d+)\. /.exec(l);
      return m?.[1] ? [Number(m[1])] : [];
    });
    expect(numbers).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it("pins the rule count of sixteen in exactly one test file", () => {
    const dir = join(REPO_ROOT, "packages/test-fixtures/src");
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts") && !f.includes("phase051-wiring"))
      .filter((f) => /checked \d+ rules/.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual(["check-boundaries-rules.test.ts"]);
    expect(readFileSync(join(dir, hits[0] ?? ""), "utf8")).toContain("checked 16 rules");
  });
});
