// Audit (04-03 truth 2): the D-18 no-restricted-syntax block also fires on
// namespace/default imports of child_process, a bare execSync call, any
// `shell` property whose value is not the literal false, and any dynamic
// import of child_process (e.g. `(await import(...)).exec(...)`), in both
// packages/launchers and packages/service.
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
  [
    "shell: string option",
    'import { spawn } from "node:child_process";\nspawn("/bin/ls", [], { shell: "/bin/sh" });\n',
  ],
  [
    "shell: variable option",
    'import { spawn } from "node:child_process";\ndeclare const sh: string;\nspawn("/bin/ls", [], { shell: sh });\n',
  ],
  [
    "shorthand shell option",
    'import { spawn } from "node:child_process";\ndeclare const shell: boolean;\nspawn("/bin/ls", [], { shell });\n',
  ],
  [
    "quoted shell key",
    'import { spawn } from "node:child_process";\nspawn("/bin/ls", [], { "shell": "/bin/sh" });\n',
  ],
  [
    'shell: "false" string (truthy)',
    'import { spawn } from "node:child_process";\nspawn("/bin/ls", [], { shell: "false" });\n',
  ],
  [
    "exec through a dynamic import",
    'export async function run(): Promise<void> {\n  (await import("node:child_process")).exec("ls");\n}\n',
  ],
  ["dynamic import of child_process", 'export const cp = import("child_process");\n'],
];

describe("D-18 spawn lint selectors (audit)", () => {
  for (const pkg of ["launchers", "service"] as const) {
    for (const [name, code] of CASES) {
      it(`fires on a ${name} in packages/${pkg}`, () => {
        expect(restricted(code, pkg).length).toBeGreaterThanOrEqual(1);
      });
    }
    it(`stays silent on shell: false and a RegExp exec in packages/${pkg}`, () => {
      const code =
        'import { spawn } from "node:child_process";\nspawn("/bin/ls", ["-la"], { shell: false });\nexport const m = /a/.exec("a");\n';
      expect(restricted(code, pkg)).toEqual([]);
    });
    it(`stays silent on a named execFile import in packages/${pkg}`, () => {
      const code =
        'import { execFile } from "node:child_process";\nexecFile("/bin/ls", ["-la"], () => {});\n';
      expect(restricted(code, pkg)).toEqual([]);
    });
  }
});
