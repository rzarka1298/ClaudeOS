// Audit (03-09; recount 05-13): behavioural checks on the visual matrix
// contract that the plan's own tests left to inspection — the cell count,
// the off-Linux skip guard, the determinism pins, and that no fixture leaks
// into the plugin. 05-13 Task 3 added a second spec file (`agent-runs.spec.ts`,
// 4 fixed cells for the Agent runs destination), and plan
// 04-15 added a fifth motion cell (Project shortcuts, reduced), so the total
// is now 73 tests across 2 files (68 original + 1 + 4).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PLAYWRIGHT = join(REPO_ROOT, "node_modules", ".bin", "playwright");

function listTests(env: NodeJS.ProcessEnv): string {
  return execFileSync(PLAYWRIGHT, ["test", "--list"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("visual matrix (audit)", () => {
  it("lists exactly 73 cells: 8 widgets x 8 presentations + 5 motion cells + 4 Agent runs cells", () => {
    const out = listTests({ CCC_VISUAL_ALLOW_LOCAL: "1" });
    expect(out).toMatch(/Total: 73 tests in 2 files/);
    for (const cell of [
      "background — full",
      "background — reduced",
      "service-health — ready — motion full",
      "service-health — ready — motion reduced",
      "agent-runs — selected-waiting",
      "agent-runs — selected-stale",
      "agent-runs — narrow-detail",
      "agent-runs — disconnected",
      "project-shortcuts — ready — reduced",
    ]) {
      expect(out).toContain(cell);
    }
  }, 60_000);

  it("pins UTC, en-US, a 1024x768 viewport at scale 1 and disabled animations", () => {
    const config = readFileSync(join(REPO_ROOT, "playwright.config.ts"), "utf8");
    expect(config).toContain('timezoneId: "UTC"');
    expect(config).toContain('locale: "en-US"');
    expect(config.match(/viewport: \{ width: 1024, height: 768 \}/g)?.length).toBe(2);
    expect(config.match(/deviceScaleFactor: 1,/g)?.length).toBe(2);
    expect(config).toContain('animations: "disabled"');
    expect(config).toContain("{platform}");
    // Plan 03-10: "none" everywhere, not only on CI (visual-baseline-guard.test.ts
    // proves the resolved value and the --update-snapshots refusal).
    expect(config).toContain('updateSnapshots: "none"');
  });

  it.each(["widgets.spec.ts", "agent-runs.spec.ts"])(
    "%s skips the whole file on a non-Linux host unless the local override is set",
    (fileName) => {
      const spec = readFileSync(
        join(REPO_ROOT, "packages", "test-fixtures", "visual", fileName),
        "utf8",
      );
      expect(spec).toMatch(
        /test\.skip\(\s*process\.platform !== "linux" && !process\.env\.CCC_VISUAL_ALLOW_LOCAL/,
      );
    },
  );

  it("never lets the plugin source reach the synthetic fixtures", () => {
    const pluginSrc = join(REPO_ROOT, "packages", "plugin", "src");
    const leaks = filesUnder(pluginSrc)
      .filter((path) => /\.(ts|tsx|css)$/.test(path))
      .filter((path) => /test-fixtures|widget-fixtures/.test(readFileSync(path, "utf8")));
    expect(leaks).toEqual([]);
  });
});
