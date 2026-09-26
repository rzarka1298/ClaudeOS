// scripts/check-privacy.sh — a file the gate cannot READ must fail the gate
// (judge-r1 finding 5). The former `tr < file | awk` pipeline took awk's exit
// status, so a read failure fed awk nothing and counted as a clean file, and
// the caller's `|| true` hid whatever was left. Each case runs a copy of the
// real script in a throwaway repository.

import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const SCRIPT = "scripts/check-privacy.sh";

// Assembled at runtime so this file is not itself a privacy-gate hit.
const HOME_PATH = ["", "Users", "realperson", "notes"].join("/");

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    for (const path of ["notes/secret.md", ".privacy-denylist.local"]) {
      try {
        chmodSync(join(repo.root, path), 0o644);
      } catch {
        // not every case creates both files
      }
    }
    repo.dispose();
  }
});

function repoWith(files: Record<string, string | Uint8Array>): GateRepo {
  const repo = gateRepo([SCRIPT], files);
  repos.push(repo);
  return repo;
}

// A root process can read a mode-000 file, which would make the unreadable
// cases vacuous rather than wrong.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("check-privacy.sh read failures (judge-r1 finding 5)", () => {
  it("passes a readable clean tree and counts it", () => {
    const result = repoWith({ "notes/secret.md": "nothing personal here\n" }).run(SCRIPT);
    expect(result.status).toBe(0);
    // The gate excludes its own source, so the one tracked note is the count.
    expect(result.out).toContain("scanned 1 tracked files, 0 violation(s) found.");
  });

  it("still flags a home path, including one after a NUL byte in a binary file", () => {
    const binary = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]),
      Buffer.from(`\0${HOME_PATH}\n`),
    ]);
    const result = repoWith({ "notes/shot.png": binary }).run(SCRIPT);
    expect(result.status).toBe(1);
    expect(result.out).toContain("notes/shot.png:");
  });

  it.skipIf(runningAsRoot)("fails, naming the file, when a tracked file cannot be read", () => {
    const repo = repoWith({ "notes/secret.md": `${HOME_PATH}\n` });
    chmodSync(join(repo.root, "notes/secret.md"), 0o000);
    const result = repo.run(SCRIPT);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("could not read notes/secret.md");
  });

  it.skipIf(runningAsRoot)(
    "fails when the denylist pass cannot read a tracked file (rule 3)",
    () => {
      const repo = repoWith({ "notes/secret.md": "clean text\n" });
      repo.write(".privacy-denylist.local", "zz-not-present-zz\n");
      chmodSync(join(repo.root, "notes/secret.md"), 0o000);
      const result = repo.run(SCRIPT);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("could not read notes/secret.md");
    },
  );
});
