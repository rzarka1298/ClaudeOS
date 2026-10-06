// scripts/check-images.sh — the tracked-image allowlist (PRIV-04 layer 3,
// plan 03-10; judge-r1 findings 1, 3 and 4). Each case builds a throwaway git
// repository holding a copy of the real gate, stages some files, and runs the
// gate there, so the test measures what git actually tracks rather than a
// mocked file list.
//
// The gate's allowlist is the exact set of baselines the Playwright tests
// declare, printed by `scripts/list-visual-baselines.mjs`. In a throwaway
// repository that lister is replaced by a stub that prints a fixed list (or
// fails), so these cases pin the gate's own logic; the last describe block
// runs the REAL lister against the real suite and the committed baselines.
//
// 05-13 Task 3 gave `list-visual-baselines.mjs` a second, spec-file-scoped
// path shape (`{specFile}-snapshots/{baseline}.png`, since Playwright's own
// `{testFileName}` snapshotPathTemplate token now gives `agent-runs.spec.ts`
// its own snapshot directory alongside `widgets.spec.ts`'s). Every fixture
// path below carries that same `widgets.spec.ts-snapshots/` prefix, so the
// stub lister and the tracked-file fixtures agree with the gate's real
// (now spec-file-aware) allowlist matching.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo, REPO_ROOT } from "./gate-repo.js";

const SCRIPT = "scripts/check-images.sh";
const LISTER = "scripts/list-visual-baselines.mjs";
const VISUAL_DIR = "packages/test-fixtures/visual";
const SNAPSHOTS = `${VISUAL_DIR}/widgets.spec.ts-snapshots`;

/** The baselines the stub lister declares unless a case says otherwise —
 * already carrying the spec-file-scoped prefix the real lister emits. */
const DECLARED = [
  "widgets.spec.ts-snapshots/background-full-chromium-linux.png",
  "widgets.spec.ts-snapshots/today-ready-chromium-linux.png",
];
const DECLARED_PATHS = DECLARED.map((name) => `${VISUAL_DIR}/${name}`);

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

/** A stub lister printing `names`, or failing with exit 2 when `names` is null. */
function stubLister(names: readonly string[] | null): string {
  if (names === null) {
    return 'process.stderr.write("stub lister: playwright failed\\n");\nprocess.exit(2);\n';
  }
  return `process.stdout.write(${JSON.stringify(names.map((name) => `${name}\n`).join(""))});\n`;
}

/**
 * A repository tracking the declared baselines plus `paths` (each a few
 * bytes), with the gate and a stub lister declaring `declared`.
 */
function repoTracking(
  paths: readonly string[],
  declared: readonly string[] | null = DECLARED,
  trackDeclared = true,
): GateRepo {
  const files: Record<string, string> = { [LISTER]: stubLister(declared) };
  const tracked = trackDeclared ? [...DECLARED_PATHS, ...paths] : [...paths];
  for (const path of tracked) files[path] = "not really an image\n";
  const repo = gateRepo([SCRIPT], files);
  repos.push(repo);
  return repo;
}

function gate(repo: GateRepo) {
  return repo.run(SCRIPT);
}

describe("check-images.sh (PRIV-04 layer 3)", () => {
  it("passes when the tracked baselines are exactly the declared set, and counts them", () => {
    const result = gate(repoTracking(["README.md"]));
    expect(result.status).toBe(0);
    expect(result.out).toContain(
      "scanned 2 tracked image(s), 0 outside the allowlist; 2 baseline(s) are expected, 0 missing.",
    );
  });

  it("fails on an image anywhere else, naming it", () => {
    const result = gate(repoTracking(["docs/vault-screenshot.png"]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("IMAGE OUTSIDE ALLOWLIST: docs/vault-screenshot.png");
    expect(result.out).toContain(
      "scanned 3 tracked image(s), 1 outside the allowlist; 2 baseline(s) are expected, 0 missing.",
    );
  });

  it("fails on a macOS baseline even inside the snapshot directory (D-22)", () => {
    const result = gate(repoTracking([`${SNAPSHOTS}/today-ready-chromium-darwin.png`]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("today-ready-chromium-darwin.png");
  });

  it("fails on an image directly in the visual/ directory, not inside any *-snapshots directory", () => {
    const result = gate(repoTracking([`${VISUAL_DIR}/loose-chromium-linux.png`]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("not inside a *-snapshots directory");
  });

  it("fails on an image nested below a spec file's own snapshot directory", () => {
    const result = gate(repoTracking([`${SNAPSHOTS}/extra/x-chromium-linux.png`]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("nested below the snapshot directory");
  });

  it("fails on a planted iPhone photo (.heic), naming it (judge-r1 finding 3)", () => {
    const result = gate(repoTracking(["docs/IMG_0001.HEIC"]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("IMAGE OUTSIDE ALLOWLIST: docs/IMG_0001.HEIC");
  });

  it("catches every image and document type, in any case (judge-r1 finding 3)", () => {
    const extensions = [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "heic",
      "heif",
      "tif",
      "tiff",
      "bmp",
      "svg",
      "pdf",
      "ico",
      "mp4",
      "mov",
      "webm",
    ];
    const names = extensions.flatMap((ext, i) => [
      `lower${i}.${ext}`,
      `upper${i}.${ext.toUpperCase()}`,
    ]);
    const result = gate(repoTracking(names.map((name) => `media/${name}`)));
    expect(result.status).toBe(1);
    const n = names.length;
    expect(result.out).toContain(
      `scanned ${n + 2} tracked image(s), ${n} outside the allowlist; 2 baseline(s) are expected, 0 missing.`,
    );
  });

  it("does not let a space in a filename split one image into two unchecked paths", () => {
    const result = gate(repoTracking(["docs/my vault shot.png"]));
    expect(result.status).toBe(1);
    expect(result.out).toContain("IMAGE OUTSIDE ALLOWLIST: docs/my vault shot.png");
  });
});

describe("the allowlist is the set the tests declare, not a name shape (judge-r1 finding 1)", () => {
  it("fails on an orphan *-chromium-linux.png that no visual test declares", () => {
    const orphan = `${SNAPSHOTS}/my-vault-inbox-chromium-linux.png`;
    const result = gate(repoTracking([orphan]));
    expect(result.status).toBe(1);
    expect(result.out).toContain(`ORPHAN BASELINE: ${orphan}`);
  });

  it("fails when a declared baseline is not tracked, naming it", () => {
    const result = gate(
      repoTracking([], [...DECLARED, "widgets.spec.ts-snapshots/github-ready-chromium-linux.png"]),
    );
    expect(result.status).toBe(1);
    expect(result.out).toContain(`MISSING BASELINE: ${SNAPSHOTS}/github-ready-chromium-linux.png`);
  });

  it("fails, and does not pass on the old name rule, when the lister cannot run", () => {
    const result = gate(repoTracking([], null));
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("could not derive the expected baselines");
  });

  it("fails when the lister declares nothing", () => {
    const result = gate(repoTracking([], []));
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("declares no baselines");
  });
});

describe("an empty scan never passes (judge-r1 finding 4)", () => {
  it("fails when no image is tracked while baselines are expected", () => {
    const result = gate(repoTracking(["README.md"], DECLARED, false));
    expect(result.status).toBe(1);
    expect(result.out).toContain("scanned 0 tracked image(s)");
    expect(result.out).toContain("2 baseline(s) are expected");
  });

  it("fails when git ls-files fails (not a repository)", () => {
    const repo = repoTracking(["README.md"]);
    // Removing .git makes every `git ls-files` in the gate fail.
    spawnSync("rm", ["-rf", join(repo.root, ".git")]);
    const result = gate(repo);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("git ls-files failed");
  });
});

describe("the real lister against the real suite", () => {
  it("declares exactly the committed baselines, across every spec file's own snapshot directory", () => {
    const run = spawnSync("node", [join(REPO_ROOT, LISTER)], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const listed = run.stdout.split("\n").filter((line) => line.length > 0);
    const specSnapshotDirs = readdirSync(join(REPO_ROOT, VISUAL_DIR)).filter((name) =>
      name.endsWith("-snapshots"),
    );
    const committed = specSnapshotDirs.flatMap((dirName) =>
      readdirSync(join(REPO_ROOT, VISUAL_DIR, dirName))
        .filter((name) => name.endsWith("-chromium-linux.png"))
        .map((name) => `${dirName}/${name}`),
    );
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual([...committed].sort());
  }, 60_000);
});
