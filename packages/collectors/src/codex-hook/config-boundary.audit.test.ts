import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexStdin, CODEX_TEST_EVENTS } from "../test-support/codex-hook-stdin.js";
import { COMPILED_CODEX_HOOK_ENTRY, runCompiled } from "../test-support/run-compiled.js";

// Wave 3 audit (plan 05.1-16 truth 3, D-19): the hook never takes Codex's single notify slot and
// never writes Codex configuration. The plan states it as a boundary ("this plan adds a process
// entry only") but no test proved it. Run the compiled hook for every event against a throwaway
// HOME and CODEX_HOME and prove every byte it wrote is under the runtime spool directory.

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(relative(root, full));
    }
  };
  visit(root);
  return out.sort();
}

let base: string;
let home: string;
let codexHome: string;
let runtimeDir: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-codex-hook-audit-")));
  home = join(base, "home");
  codexHome = join(base, "codex-home");
  runtimeDir = join(base, "runtime");
  for (const d of [home, codexHome, runtimeDir]) mkdirSync(d, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("the Codex hook writes no Codex configuration (D-19)", () => {
  it("creates nothing in HOME or CODEX_HOME for any of the five events, and only spool files in the runtime directory", async () => {
    for (const event of CODEX_TEST_EVENTS) {
      const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
        args: ["--runtime-dir", runtimeDir],
        stdin: buildCodexStdin(event),
        env: { HOME: home, CODEX_HOME: codexHome },
      });
      expect(result.code, event).toBe(0);
      expect(result.stdout.length, event).toBe(0);
    }
    expect(walk(home)).toEqual([]);
    expect(walk(codexHome)).toEqual([]);
    const written = walk(runtimeDir);
    expect(written.length).toBeGreaterThan(0);
    for (const file of written) {
      expect(file, file).toMatch(/^spool\/codex-hooks\.(ndjson|dropped)$/);
    }
  });

  it("the shipped hook sources never name the notify slot or a Codex configuration file", () => {
    const dir = join(__dirname);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.sort()).toEqual(["entry.ts", "limits.ts", "minimize.ts"]);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8")
        // The notify word may appear in prose comments that explain the boundary; strip them.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/notify/i);
      expect(text, file).not.toMatch(/config\.toml|hooks\.json|CODEX_HOME|\.codex/);
    }
  });
});
