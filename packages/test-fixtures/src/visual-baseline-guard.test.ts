// Where a visual baseline may be WRITTEN (D-22; 03-09 review MAJOR and MINOR,
// carried into plan 03-10 as carry-forwards 1 and 2).
//
// A baseline is a Linux-container artifact. Three things used to let one be
// written somewhere else:
//   1. off CI the config resolved `updateSnapshots` to "missing", so a plain
//      Mac run wrote `*-chromium-darwin.png` next to the Linux baselines;
//   2. nothing stopped `--update-snapshots` on a host that is not the pinned
//      container (a Mac with the local override, or a Linux laptop whose host
//      fonts differ from the image's);
//   3. git would have happily tracked a stray darwin/win32 PNG in the
//      snapshot directory.
// These tests read what Playwright actually RESOLVES (its JSON reporter
// prints the effective config) and what git actually IGNORES, rather than
// grepping the config text, so a refactor of the config cannot keep the words
// and lose the guarantee.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PLAYWRIGHT = join(REPO_ROOT, "node_modules", ".bin", "playwright");
const SNAPSHOT_DIR = "packages/test-fixtures/visual/widgets.spec.ts-snapshots";

/** The environment a developer's shell would have: no CI flag, no container marker. */
function hostEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CCC_VISUAL_ALLOW_LOCAL: "1", ...extra };
  delete env.CI;
  if (!("CCC_VISUAL_CONTAINER" in extra)) delete env.CCC_VISUAL_CONTAINER;
  return env;
}

function listRun(args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync(PLAYWRIGHT, ["test", "--list", "--reporter=json", ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
}

function resolvedUpdateSnapshots(env: NodeJS.ProcessEnv): string {
  const run = listRun([], env);
  expect(run.status, run.stderr).toBe(0);
  const report = JSON.parse(run.stdout) as { config: { updateSnapshots: string } };
  return report.config.updateSnapshots;
}

function gitIgnores(path: string): boolean {
  // exit 0 = ignored, 1 = not ignored; anything else is a broken probe.
  const run = spawnSync("git", ["check-ignore", "-q", path], { cwd: REPO_ROOT });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git check-ignore failed: ${path}`);
  return run.status === 0;
}

describe("visual baselines are written only inside the pinned container (D-22)", () => {
  it("a default run never writes a missing baseline: updateSnapshots resolves to none", () => {
    expect(resolvedUpdateSnapshots(hostEnv())).toBe("none");
  }, 60_000);

  it("refuses --update-snapshots outside the pinned container, naming the sanctioned script", () => {
    const run = listRun(["--update-snapshots"], hostEnv());
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("scripts/ci/visual-in-container.sh");
  }, 60_000);

  it.skipIf(process.platform === "linux")(
    "refuses --update-snapshots off Linux even when the container marker is spoofed",
    () => {
      const run = listRun(["--update-snapshots"], hostEnv({ CCC_VISUAL_CONTAINER: "1" }));
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("scripts/ci/visual-in-container.sh");
    },
    60_000,
  );

  it("git admits only *-chromium-linux.png into the snapshot directory", () => {
    expect(gitIgnores(`${SNAPSHOT_DIR}/today-ready-chromium-linux.png`)).toBe(false);
    expect(gitIgnores(`${SNAPSHOT_DIR}/today-ready-chromium-darwin.png`)).toBe(true);
    expect(gitIgnores(`${SNAPSHOT_DIR}/today-ready-chromium-win32.png`)).toBe(true);
    expect(gitIgnores(`${SNAPSHOT_DIR}/notes.txt`)).toBe(true);
  });
});
