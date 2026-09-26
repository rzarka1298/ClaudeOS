#!/usr/bin/env node
// Prints, one per line and sorted, the exact file name of every visual
// baseline the Playwright suite expects — derived from the TESTS, never from
// the snapshot directory (judge-r1 finding 1). `scripts/check-images.sh`
// admits a tracked baseline only if it is on this list and fails on any name
// on this list that is not tracked.
//
// Source of truth: `playwright test --list --reporter=json`. Every screenshot
// cell in `packages/test-fixtures/visual/widgets.spec.ts` is registered through
// `cell()`, which attaches a `baseline` annotation naming the one snapshot the
// cell may write. The file name is then `{stem}-{projectName}-linux.png`, the
// same shape `snapshotPathTemplate` in playwright.config.ts produces on the
// Linux container (D-22).
//
// Refuses (exit 2, nothing on stdout) rather than printing a partial list:
// Playwright failing, a load error in any spec, zero tests, a test with no
// baseline annotation, a malformed name, or a duplicate. An empty or partial
// allowlist would turn the gate into a pass.
//
// Needs the workspace built: the spec imports WIDGET_IDS from @ccc/plugin,
// which resolves through that package's dist/.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYWRIGHT = join(REPO_ROOT, "node_modules", ".bin", "playwright");
const ANNOTATION = "baseline";
const PLATFORM = "linux";
const STEM = /^[a-z0-9][a-z0-9-]*\.png$/;

function refuse(message) {
  process.stderr.write(`scripts/list-visual-baselines.mjs: ${message}\n`);
  process.exit(2);
}

// The environment a comparison run has on a developer's machine. The
// container marker is dropped so an --update-snapshots guard can never fire
// here, and nothing is written: --list runs no test body.
const env = { ...process.env, CCC_VISUAL_ALLOW_LOCAL: "1" };
delete env.CCC_VISUAL_CONTAINER;

const run = spawnSync(PLAYWRIGHT, ["test", "--list", "--reporter=json"], {
  cwd: REPO_ROOT,
  env,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (run.error) refuse(`could not run playwright: ${run.error.message}`);
if (run.status !== 0) refuse(`playwright test --list exited ${run.status}\n${run.stderr}`);

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  refuse("playwright test --list did not print a JSON report");
}
if (Array.isArray(report.errors) && report.errors.length > 0) {
  refuse(`playwright reported ${report.errors.length} load error(s); refusing a partial list`);
}

const names = new Set();
let tests = 0;

function visit(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      tests++;
      const declared = (test.annotations ?? []).filter((a) => a.type === ANNOTATION);
      if (declared.length !== 1) {
        refuse(`"${spec.title}" declares ${declared.length} baseline annotations (exactly 1 required)`);
      }
      const stem = declared[0].description ?? "";
      if (!STEM.test(stem)) refuse(`"${spec.title}" declares a malformed baseline name "${stem}"`);
      const name = `${stem.slice(0, -".png".length)}-${test.projectName}-${PLATFORM}.png`;
      if (names.has(name)) refuse(`two cells declare the same baseline ${name}`);
      names.add(name);
    }
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites ?? []) visit(suite);

if (tests === 0 || names.size === 0) refuse("playwright listed no visual cells");

process.stdout.write(`${[...names].sort().join("\n")}\n`);
