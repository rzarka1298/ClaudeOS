// Audit (04-03 truth 2): the D-18 no-restricted-syntax block also fires on
// namespace/default imports of child_process, a bare execSync call and a
// `shell: true` property, in both packages/launchers and packages/service.
// Linted via --stdin so no file is written into product packages.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ESLINT_BIN = join(REPO_ROOT, "node_modules", ".bin", "eslint");

function restricted(code: string, pkg: "launchers" | "service"): string[] {
  const args = [
    "--config",
    join(REPO_ROOT, "eslint.config.mjs"),
    "--format",
    "json",
    "--stdin",
    "--stdin-filename",
    join(REPO_ROOT, "packages", pkg, "src", "index.ts"),
  ];
  let out: string;
  try {
    out = execFileSync(ESLINT_BIN, args, { cwd: REPO_ROOT, input: code, encoding: "utf8" });
  } catch (err) {
    out = (err as { stdout: string }).stdout;
  }
  const results = JSON.parse(out) as Array<{
    messages: Array<{ ruleId: string | null; message: string }>;
  }>;
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

const CASES: Array<[string, string]> = [
  ["namespace import", 'import * as cp from "node:child_process";\nexport const x = cp;\n'],
  ["default import", 'import cp from "child_process";\nexport const x = cp;\n'],
  [
    "shell: true option",
    'import { spawn } from "node:child_process";\nspawn("/bin/ls", [], { shell: true });\n',
  ],
  ["bare execSync call", 'declare const execSync: (c: string) => void;\nexecSync("ls");\n'],
];

describe("D-18 spawn lint selectors (audit)", () => {
  for (const pkg of ["launchers", "service"] as const) {
    for (const [name, code] of CASES) {
      it(`fires on a ${name} in packages/${pkg}`, () => {
        expect(restricted(code, pkg).length).toBeGreaterThanOrEqual(1);
      });
    }
    it(`stays silent on a named execFile import in packages/${pkg}`, () => {
      const code =
        'import { execFile } from "node:child_process";\nexecFile("/bin/ls", ["-la"], () => {});\n';
      expect(restricted(code, pkg)).toEqual([]);
    });
  }
});
