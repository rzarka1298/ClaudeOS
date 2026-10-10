// Wave-2 audit (plan 06-02): the REAL approval and executors folders are
// compiler-confined (TS6307 on a planted escape), and the real tree lints with
// zero boundary violations.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const ESLINT_BIN = join(REPO_ROOT, "node_modules", ".bin", "eslint");

function run(bin: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(bin, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64e6 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const planted: string[] = [];
afterEach(() => {
  for (const f of planted.splice(0)) rmSync(f, { force: true });
});

describe("real nested projects reject a relative import out of the folder (T-06-31)", () => {
  for (const folder of ["approval", "executors"] as const) {
    const dir = join(REPO_ROOT, "packages", "service", "src", folder);

    test(`${folder}: the unmodified project compiles`, () => {
      const r = run(TSC_BIN, ["-p", dir, "--noEmit", "--pretty", "false"]);
      expect(r.out).not.toContain("TS6307");
      expect(r.code).toBe(0);
    });

    test(`${folder}: a planted ../main.js import fails with TS6307`, () => {
      const file = join(dir, `audit-escape-${process.pid}.ts`);
      planted.push(file);
      writeFileSync(file, 'import "../main.js";\nexport const x = 1;\n');
      const r = run(TSC_BIN, ["-p", dir, "--noEmit", "--pretty", "false"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("TS6307");
    });
  }
});

describe("the real tree has zero boundary violations", () => {
  test("eslint over service, domain and plugin sources reports no boundaries/* message", () => {
    const r = run(ESLINT_BIN, [
      "--config",
      join(REPO_ROOT, "eslint.config.mjs"),
      "--format",
      "json",
      "packages/service/src",
      "packages/domain/src",
      "packages/plugin/src",
    ]);
    const results = JSON.parse(r.out) as Array<{
      filePath: string;
      messages: Array<{ ruleId: string | null }>;
    }>;
    expect(results.length).toBeGreaterThan(20);
    const bad = results.flatMap((f) =>
      f.messages
        .filter((m) => m.ruleId?.startsWith("boundaries/") === true)
        .map((m) => `${f.filePath}:${m.ruleId}`),
    );
    expect(bad).toEqual([]);
  });
});
