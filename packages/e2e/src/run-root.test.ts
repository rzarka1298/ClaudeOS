import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
        paths.codexCandidatesDir,
        paths.codexBridgeHome,
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

  it("creates the two Codex isolation folders under the root, mode 0700, with distinct names (Test 4)", () => {
    const paths = createRunRoot({ base });
    expect(paths.codexCandidatesDir).toBe(join(paths.root, "codex-candidates"));
    expect(paths.codexBridgeHome).toBe(join(paths.root, "codex-bridge"));
    expect(paths.codexCandidatesDir).not.toBe(paths.codexBridgeHome);
    for (const dir of [paths.codexCandidatesDir, paths.codexBridgeHome]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(mode(dir)).toBe(0o700);
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

  it("resets locked folders and read-only files first, so a drill that left a mode behind cannot block teardown (B-MINOR 2)", () => {
    const paths = createRunRoot({ base });
    const locked = join(paths.vaultsDir, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "note.md"), "x");
    writeFileSync(join(paths.runtimeDir, "frozen"), "x", { mode: 0o400 });
    chmodSync(join(locked, "inner"), 0o500);
    chmodSync(locked, 0o000);
    chmodSync(paths.wdioDir, 0o500);
    removeRunRoot(paths.root, { base });
    expect(existsSync(paths.root)).toBe(false);
  });

  it("never follows a link while resetting modes", () => {
    const paths = createRunRoot({ base });
    const outside = mkdtempSync("/tmp/ccc-e2e-rr-out.");
    try {
      chmodSync(outside, 0o755);
      symlinkSync(outside, join(paths.vaultsDir, "link"));
      chmodSync(paths.codexHome, 0o500);
      removeRunRoot(paths.root, { base });
      expect(existsSync(paths.root)).toBe(false);
      expect(mode(outside)).toBe(0o755);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("FIX2A F8: never changes the mode of a regular file, so a hard link to a file outside the sandbox keeps its mode", () => {
    const paths = createRunRoot({ base });
    const outside = mkdtempSync("/tmp/ccc-e2e-rr-out.");
    try {
      const readOnly = join(outside, "read-only.txt");
      const sealed = join(outside, "sealed.txt");
      writeFileSync(readOnly, "x", { mode: 0o444 });
      writeFileSync(sealed, "y", { mode: 0o000 });
      chmodSync(readOnly, 0o444);
      chmodSync(sealed, 0o000);
      // The links live in a locked folder inside the sandbox, so teardown must reach them.
      const locked = join(paths.vaultsDir, "locked");
      mkdirSync(locked, { recursive: true });
      linkSync(readOnly, join(locked, "read-only-link.txt"));
      linkSync(sealed, join(locked, "sealed-link.txt"));
      chmodSync(locked, 0o000);
      removeRunRoot(paths.root, { base });
      expect(existsSync(paths.root)).toBe(false);
      expect(mode(readOnly)).toBe(0o444);
      expect(mode(sealed)).toBe(0o000);
    } finally {
      chmodSync(join(outside, "sealed.txt"), 0o600);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("FIX2A F8: still restores a locked folder so a read-only file inside it cannot block the removal", () => {
    const paths = createRunRoot({ base });
    const dir = join(paths.vaultsDir, "frozen-tree");
    mkdirSync(join(dir, "deep"), { recursive: true });
    writeFileSync(join(dir, "deep", "ro.txt"), "x", { mode: 0o400 });
    chmodSync(join(dir, "deep"), 0o500);
    chmodSync(dir, 0o500);
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
