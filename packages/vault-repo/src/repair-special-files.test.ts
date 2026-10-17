// Phase 7 FIX8 review follow-up: repairVault reads every existing index.md before regenerating it.
// That read must not wait on a FIFO (the same defect the index generator had), so the helper child
// opens the FIFO for writing after a delay and the elapsed time exposes a reader that waited.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { repairVault } from "./repair.js";
import { initializeVault } from "./setup.js";

const TEST_BASE = join(homedir(), ".ccc-test");
let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vrepair-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("repairVault reads index files without blocking", () => {
  test("a FIFO named index.md in a managed folder does not hang the repair", () => {
    const fifo = join(vaultRoot, "global", "wiki", "index.md");
    unlinkSync(fifo);
    execFileSync("mkfifo", [fifo]);
    const helper = spawn("sh", ["-c", 'sleep 3; printf x > "$1"', "sh", fifo], {
      stdio: "ignore",
    });
    const started = Date.now();
    try {
      try {
        repairVault(vaultRoot);
      } catch {
        // A refusal is acceptable; only waiting on the pipe is not.
      }
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      helper.kill("SIGKILL");
    }
  });
});
