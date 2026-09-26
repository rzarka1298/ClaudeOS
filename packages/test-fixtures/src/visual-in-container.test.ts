// scripts/ci/visual-in-container.sh must run the CI visual job, not a
// look-alike (judge-r1 finding 6): the container gets the COMMIT (what
// actions/checkout gives CI), not the working tree; baselines are never
// regenerated from uncommitted code; and the job runs on the Node version CI
// pins, not whatever the image bundles. Docker is not needed for these cases:
// the refusal runs before the Docker check, and the Node pin is compared as
// text. The full container run is exercised by hand (03-JUDGE-R1-SUMMARY.md).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo, REPO_ROOT } from "./gate-repo.js";

const SCRIPT = "scripts/ci/visual-in-container.sh";
const SOURCE = readFileSync(join(REPO_ROOT, SCRIPT), "utf8");
const CI = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

function committedRepo(): GateRepo {
  const repo = gateRepo([SCRIPT], { "README.md": "synthetic\n" });
  repos.push(repo);
  repo.git("commit", "-q", "-m", "init");
  return repo;
}

describe("visual-in-container.sh runs what CI runs (judge-r1 finding 6)", () => {
  it("refuses --update-snapshots while a tracked file has uncommitted changes", () => {
    const repo = committedRepo();
    repo.write("README.md", "edited but not committed\n");
    const result = repo.run(SCRIPT, ["--update-snapshots"]);
    expect(result.status).toBe(2);
    expect(result.out).toContain("uncommitted changes");
  });

  it("refuses --update-snapshots while a change is staged but not committed", () => {
    const repo = committedRepo();
    repo.write("README.md", "staged but not committed\n");
    repo.git("add", "README.md");
    const result = repo.run(SCRIPT, ["--update-snapshots"]);
    expect(result.status).toBe(2);
    expect(result.out).toContain("uncommitted changes");
  });

  it("copies the commit with git archive, never the working tree", () => {
    expect(SOURCE).toMatch(/git -C "\$REPO_ROOT" archive/);
    expect(SOURCE).not.toMatch(/rsync[^\n]*"\$REPO_ROOT\/"/);
  });

  it("pins exactly the Node version every CI job sets up, with a checksum", () => {
    const ciVersions = [...CI.matchAll(/node-version:\s*"([0-9.]+)"/g)].map((match) => match[1]);
    expect(ciVersions.length).toBeGreaterThan(0);
    expect(new Set(ciVersions).size).toBe(1);

    const pinned = /^NODE_VERSION="([0-9.]+)"$/m.exec(SOURCE)?.[1];
    expect(pinned).toBe(ciVersions[0]);
    expect(SOURCE).toMatch(/^NODE_SHA256="[0-9a-f]{64}"$/m);
  });
});
