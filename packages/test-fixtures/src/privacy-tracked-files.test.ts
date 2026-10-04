// Owner-state files are never tracked (D-44, PR-03, PROJ-14).
//
// Obsidian writes the plugin's settings (data.json) and the Overview layout
// override (layout.json) into the plugin folder, which the dev vault
// symlinks into this repository. These assertions read what git actually
// TRACKS and IGNORES, rather than grepping .gitignore, so a refactor of the
// ignore file cannot keep the words and lose the guarantee. The CI half is
// scripts/check-privacy.sh rule 4.

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo, REPO_ROOT } from "./gate-repo.js";

const OWNER_STATE = ["packages/plugin/data.json", "packages/plugin/layout.json"] as const;

function gitIgnores(path: string): boolean {
  // exit 0 = ignored, 1 = not ignored; anything else is a broken probe.
  const run = spawnSync("git", ["check-ignore", "-q", path], { cwd: REPO_ROOT });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git check-ignore failed: ${path}`);
  return run.status === 0;
}

describe("plugin owner-state files are untracked and ignored (D-44)", () => {
  it("git tracks neither data.json nor layout.json", () => {
    const run = spawnSync("git", ["ls-files", "--", ...OWNER_STATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  for (const path of OWNER_STATE) {
    it(`${path} is gitignored`, () => {
      expect(gitIgnores(path)).toBe(true);
    });
  }
});

describe("check-privacy.sh rule 4 fires when owner state is tracked (D-44)", () => {
  const repos: GateRepo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.dispose();
  });

  for (const path of OWNER_STATE) {
    it(`fails the gate when ${path} is tracked`, () => {
      const repo = gateRepo(["scripts/check-privacy.sh"], { [path]: "{}\n" });
      repos.push(repo);
      const result = repo.run("scripts/check-privacy.sh");
      expect(result.status).toBe(1);
      expect(result.out).toContain(`${path}: owner state is tracked (D-44)`);
    });
  }

  it("passes when neither file is tracked -- the rule discriminates", () => {
    const repo = gateRepo(["scripts/check-privacy.sh"], { "README.md": "clean\n" });
    repos.push(repo);
    const result = repo.run("scripts/check-privacy.sh");
    expect(result.out).not.toContain("owner state is tracked");
    expect(result.status).toBe(0);
  });
});
