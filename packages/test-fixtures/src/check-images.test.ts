// scripts/check-images.sh — the tracked-image allowlist (PRIV-04 layer 3,
// plan 03-10). Each case builds a throwaway git repository holding a copy of
// the real script, stages some files, and runs the gate there, so the test
// measures what git actually tracks rather than a mocked file list.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "..", "..", "scripts", "check-images.sh");
const SNAPSHOTS = "packages/test-fixtures/visual/widgets.spec.ts-snapshots";

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

/** A repository tracking `paths` (each written as a few bytes), plus the gate. */
function repoTracking(paths: readonly string[]): string {
  const repo = mkdtempSync(join(tmpdir(), "ccc-check-images-"));
  repos.push(repo);
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  };
  git("init", "-q");
  mkdirSync(join(repo, "scripts"));
  copyFileSync(SCRIPT, join(repo, "scripts", "check-images.sh"));
  for (const path of paths) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), "not really an image\n");
  }
  git("add", "--", "scripts/check-images.sh", ...paths);
  return repo;
}

function gate(repo: string) {
  const run = spawnSync("sh", ["scripts/check-images.sh"], { cwd: repo, encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe("check-images.sh (PRIV-04 layer 3)", () => {
  it("passes on Linux baselines in the snapshot directory and counts them", () => {
    const result = gate(
      repoTracking([
        `${SNAPSHOTS}/today-ready-chromium-linux.png`,
        `${SNAPSHOTS}/background-full-chromium-linux.png`,
        "README.md",
      ]),
    );
    expect(result.status).toBe(0);
    expect(result.out).toContain("scanned 2 tracked image(s), 0 outside the allowlist.");
  });

  it("fails on an image anywhere else, naming it", () => {
    const result = gate(repoTracking(["docs/vault-screenshot.png"]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("IMAGE OUTSIDE ALLOWLIST: docs/vault-screenshot.png");
    expect(result.out).toContain("scanned 1 tracked image(s), 1 outside the allowlist.");
  });

  it("fails on a macOS baseline even inside the snapshot directory (D-22)", () => {
    const result = gate(repoTracking([`${SNAPSHOTS}/today-ready-chromium-darwin.png`]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("today-ready-chromium-darwin.png");
  });

  it("fails on an image nested below the snapshot directory", () => {
    const result = gate(repoTracking([`${SNAPSHOTS}/extra/x-chromium-linux.png`]));
    expect(result.status).toBe(1);
  });

  it("matches every listed extension case-insensitively", () => {
    const names = ["a.PNG", "b.jpg", "c.JPEG", "d.gif", "e.webp", "f.mp4", "g.MOV", "h.webm"];
    const result = gate(repoTracking(names.map((name) => `media/${name}`)));
    expect(result.status).toBe(1);
    expect(result.out).toContain("scanned 8 tracked image(s), 8 outside the allowlist.");
  });

  it("does not let a space in a filename split one image into two unchecked paths", () => {
    const result = gate(repoTracking(["docs/my vault shot.png"]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("IMAGE OUTSIDE ALLOWLIST: docs/my vault shot.png");
  });
});
