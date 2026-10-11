import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunRoot, removeRunRoot } from "./run-root.js";

// A short base under /tmp (the real base is /tmp too), so socket-length checks are realistic.
let base: string;

beforeEach(() => {
  base = mkdtempSync("/tmp/ccc-e2e-rr.");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("createRunRoot (Test 6)", () => {
  it("creates ccc-uat.XXXXXX under the base with mode 0700 even under a permissive umask", () => {
    const previous = process.umask(0);
    try {
      const paths = createRunRoot({ base });
      expect(paths.root).toMatch(/\/ccc-uat\.[A-Za-z0-9]{6}$/);
      expect(paths.root.startsWith(`${base}/`)).toBe(true);
      expect(mode(paths.root)).toBe(0o700);
      for (const dir of [
        paths.runtimeDir,
        paths.claudeConfigDir,
        paths.codexHome,
        paths.vaultsDir,
        paths.pluginStageDir,
        paths.tmpDir,
        paths.wdioDir,
      ]) {
        expect(statSync(dir).isDirectory()).toBe(true);
        expect(mode(dir)).toBe(0o700);
        expect(dir.startsWith(`${paths.root}/`)).toBe(true);
      }
    } finally {
      process.umask(previous);
    }
  });

  it("returns the shared file names and a run id independent of the directory suffix", () => {
    const paths = createRunRoot({ base });
    expect(paths.runId).toMatch(/^[0-9a-f]{8}$/);
    expect(paths.socketPath).toBe(join(paths.runtimeDir, "svc.sock"));
    expect(paths.dbPath).toBe(join(paths.runtimeDir, "operational.db"));
    expect(paths.ledgerPath).toBe(join(paths.root, "ledger.jsonl"));
    expect(paths.resultsPath).toBe(join(paths.root, "results.jsonl"));
    expect(paths.lookPendingPath).toBe(join(paths.root, "look-pending.jsonl"));
    expect(paths.versionsPath).toBe(join(paths.root, "versions.json"));
    // Lazily created by their writers.
    expect(existsSync(paths.ledgerPath)).toBe(false);
    const second = createRunRoot({ base });
    expect(second.root).not.toBe(paths.root);
    expect(second.runId).not.toBe(paths.runId);
  });

  it("keeps the socket path under 104 bytes for the real /tmp base", () => {
    const paths = createRunRoot({ base: "/tmp" });
    try {
      expect(Buffer.byteLength(paths.socketPath)).toBeLessThan(104);
    } finally {
      removeRunRoot(paths.root, { base: "/tmp" });
    }
    expect(existsSync(paths.root)).toBe(false);
  });
});

describe("removeRunRoot (Test 6)", () => {
  it("removes a valid root completely", () => {
    const paths = createRunRoot({ base });
    writeFileSync(join(paths.runtimeDir, "operational.db"), "x");
    mkdirSync(join(paths.vaultsDir, "live"));
    removeRunRoot(paths.root, { base });
    expect(existsSync(paths.root)).toBe(false);
  });

  it("refuses anything that fails the shape check and leaves it alone", () => {
    const stray = join(base, "not-a-run-root");
    mkdirSync(stray);
    writeFileSync(join(stray, "keep"), "x");
    expect(() => removeRunRoot(stray, { base })).toThrow();
    expect(() => removeRunRoot(base, { base })).toThrow();
    expect(() => removeRunRoot("/tmp", { base: "/tmp" })).toThrow();
    expect(existsSync(join(stray, "keep"))).toBe(true);
  });
});
