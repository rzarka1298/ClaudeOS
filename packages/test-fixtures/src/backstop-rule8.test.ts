// scripts/check-boundaries.sh rule 8 (D-18, PROJ-13): no file in
// packages/launchers or packages/service starts a process through a shell.
//
// This runs the REAL script against the REAL tracked tree plus one probe
// file, without touching the repository's index: the index is copied to a
// temporary file, the probe is added to that copy as intent-to-add, and the
// script runs with GIT_INDEX_FILE pointing at the copy, so its
// `git ls-files` sees the probe while `git status` in the checkout never
// sees a staged change. The probe and the temporary index are always
// removed, even when an assertion throws.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

const PROBE = "packages/service/src/__rule8_probe__.ts";
const RULE8 = "starts a process through a shell";

// Assembled at runtime so this file never reads as a spawn call itself.
const FORBIDDEN = ["exec", "Sync"].join("");
const SHELL_PROBE = `import { ${FORBIDDEN} } from "node:child_process";\n\nexport const listing = ${FORBIDDEN}("ls -la");\n`;
const ARGV_PROBE = `import { execFile } from "node:child_process";\n\nexecFile("ls", ["-la"], () => {});\n`;

function git(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const run = spawnSync("git", args, { cwd: REPO_ROOT, env, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
}

/** Runs the backstop over the real tree with `probe` tracked in a scratch index. */
function backstopWithProbe(probe: string): { status: number | null; out: string } {
  const scratch = mkdtempSync(join(tmpdir(), "ccc-rule8-"));
  const probePath = join(REPO_ROOT, PROBE);
  try {
    const indexPath = git(["rev-parse", "--git-path", "index"]);
    const realIndex = isAbsolute(indexPath) ? indexPath : resolve(REPO_ROOT, indexPath);
    const scratchIndex = join(scratch, "index");
    copyFileSync(realIndex, scratchIndex);
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };

    writeFileSync(probePath, probe);
    git(["add", "-N", "--", PROBE], env);

    const run = spawnSync("sh", ["scripts/check-boundaries.sh"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(probePath, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("check-boundaries.sh rule 8 -- no shell spawn in launchers or service (D-18)", () => {
  it("fires on a bare shell-running call in packages/service", () => {
    const result = backstopWithProbe(SHELL_PROBE);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain(RULE8);
    expect(result.out).toContain(PROBE);
  }, 30_000);

  it("stays silent on execFile with an argv array -- the rule discriminates", () => {
    const result = backstopWithProbe(ARGV_PROBE);
    expect(result.out).not.toContain(RULE8);
    expect(result.status).toBe(0);
  }, 30_000);

  it("leaves no probe and no staged change behind", () => {
    backstopWithProbe(SHELL_PROBE);
    expect(existsSync(join(REPO_ROOT, PROBE))).toBe(false);
    expect(git(["ls-files", "--", PROBE])).toBe("");
    expect(git(["status", "--porcelain", "--", PROBE])).toBe("");
  }, 30_000);
});
