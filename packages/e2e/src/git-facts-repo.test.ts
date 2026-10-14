import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGitFacts } from "./git-facts.js";
import { isRunCurrent } from "./staleness.js";

/** Wave 2 review MEDIUM-3: real-repository checks of the changed-file listing. */

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function scratchRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ccc-gitfacts-")));
  run(dir, "init", "-q");
  run(dir, "config", "user.email", ["t", "example.invalid"].join("@"));
  run(dir, "config", "user.name", "t");
  run(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "packages/service/src"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "packages/service/src/a.ts"), "export const a = 1;\n".repeat(20));
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("readGitFacts and planning evidence (Codex review: report updates blocked ratification)", () => {
  it("a modified tracked planning file does not make the tree unclean; a product change does", async () => {
    const dir = scratchRepo();
    try {
      mkdirSync(join(dir, ".planning/phases/06"), { recursive: true });
      writeFileSync(join(dir, ".planning/phases/06/06-UAT.md"), "one\n");
      run(dir, "add", ".");
      run(dir, "commit", "-q", "-m", "evidence");
      writeFileSync(join(dir, ".planning/phases/06/06-UAT.md"), "two\n");
      expect((await readGitFacts({ cwd: dir })).clean).toBe(true);
      writeFileSync(join(dir, "packages/service/src/a.ts"), "export const a = 2;\n");
      expect((await readGitFacts({ cwd: dir })).clean).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readGitFacts against a real repository (MEDIUM-3)", () => {
  it("a product file moved out of packages/ is reported, so the run is stale", async () => {
    const dir = scratchRepo();
    try {
      const since = run(dir, "rev-parse", "HEAD");
      renameSync(join(dir, "packages/service/src/a.ts"), join(dir, "docs/a.ts"));
      run(dir, "add", "-A");
      run(dir, "commit", "-q", "-m", "move");
      const facts = await readGitFacts({ cwd: dir, since });
      expect(facts.changedSince).toContain("packages/service/src/a.ts");
      expect(
        isRunCurrent({
          recordedHead: since,
          currentHead: facts.head,
          changedFiles: facts.changedSince,
          recordedClean: true,
          currentClean: facts.clean,
        }).current,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a non-ASCII path unquoted", async () => {
    const dir = scratchRepo();
    try {
      const since = run(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "packages/service/src/é.ts"), "export {};\n");
      run(dir, "add", "-A");
      run(dir, "commit", "-q", "-m", "accent");
      const facts = await readGitFacts({ cwd: dir, since });
      expect(facts.changedSince).toEqual(["packages/service/src/é.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readGitFacts counts untracked product files (Wave 3 WR-06)", () => {
  it("an untracked file under packages/ makes the tree unclean", async () => {
    const dir = scratchRepo();
    try {
      writeFileSync(join(dir, "packages/service/src/new.ts"), "export {};\n");
      expect((await readGitFacts({ cwd: dir })).clean).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an untracked document outside packages/ and scripts/ leaves it clean", async () => {
    const dir = scratchRepo();
    try {
      writeFileSync(join(dir, "docs/note.md"), "x\n");
      expect((await readGitFacts({ cwd: dir })).clean).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
