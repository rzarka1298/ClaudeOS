import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureScriptDir,
  SCRIPT_DIR_NAME,
  SCRIPT_MAX_AGE_MS,
  sweepStaleScripts,
  writeLaunchScript,
} from "./script-dir.js";

let runtimeDir: string;

function modeBits(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "ccc-script-dir-"));
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("ensureScriptDir (D-20)", () => {
  it("creates <runtime>/launch at mode 0700 and returns it", () => {
    const dir = ensureScriptDir(runtimeDir);
    expect(dir).toBe(join(runtimeDir, SCRIPT_DIR_NAME));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("repairs a pre-existing 0755 launch directory back to 0700", () => {
    const dir = join(runtimeDir, SCRIPT_DIR_NAME);
    mkdirSync(dir, { mode: 0o755 });
    expect(modeBits(dir)).toBe(0o755);
    ensureScriptDir(runtimeDir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a launch directory that is a symlink, leaving its target alone", () => {
    const elsewhere = join(runtimeDir, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o755 });
    symlinkSync(elsewhere, join(runtimeDir, SCRIPT_DIR_NAME));
    expect(() => ensureScriptDir(runtimeDir)).toThrow();
    expect(modeBits(elsewhere)).toBe(0o755);
  });
});

describe("writeLaunchScript (D-20, T-04-11)", () => {
  it("writes a 0700 file named 32 hex characters + .command inside the directory", () => {
    const dir = ensureScriptDir(runtimeDir);
    const path = writeLaunchScript(dir, "#!/bin/sh\necho hi\n");
    expect(dirname(path)).toBe(dir);
    expect(basename(path)).toMatch(/^[0-9a-f]{32}\.command$/);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\necho hi\n");
  });

  it("never reuses a name", () => {
    const dir = ensureScriptDir(runtimeDir);
    const names = new Set<string>();
    for (let i = 0; i < 20; i += 1) names.add(writeLaunchScript(dir, "x"));
    expect(names.size).toBe(20);
    expect(readdirSync(dir)).toHaveLength(20);
  });

  it("fails rather than overwrite when the directory does not exist (wx, no mkdir)", () => {
    expect(() => writeLaunchScript(join(runtimeDir, "absent"), "x")).toThrow();
  });
});

describe("sweepStaleScripts (Pitfall 5)", () => {
  function seed(dir: string, name: string, ageMs: number): string {
    const path = join(dir, name);
    writeFileSync(path, "x", { mode: 0o700 });
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
    return path;
  }

  it("with { all: true } deletes every .command file and leaves other files alone", () => {
    const dir = ensureScriptDir(runtimeDir);
    const a = writeLaunchScript(dir, "x");
    const b = writeLaunchScript(dir, "y");
    const other = seed(dir, "notes.txt", 0);
    expect(sweepStaleScripts(dir, { all: true })).toBe(2);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("with a 10-minute threshold deletes only older .command files, never a fresh one", () => {
    const dir = ensureScriptDir(runtimeDir);
    const old = seed(dir, `${"a".repeat(32)}.command`, SCRIPT_MAX_AGE_MS + 60_000);
    const fresh = writeLaunchScript(dir, "just handed off");
    const almost = seed(dir, `${"b".repeat(32)}.command`, SCRIPT_MAX_AGE_MS - 60_000);
    const oldOther = seed(dir, "old.log", SCRIPT_MAX_AGE_MS * 3);
    expect(sweepStaleScripts(dir, { olderThanMs: SCRIPT_MAX_AGE_MS })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(almost)).toBe(true);
    expect(existsSync(oldOther)).toBe(true);
  });

  it("answers 0 for a directory that does not exist", () => {
    expect(sweepStaleScripts(join(runtimeDir, "absent"), { all: true })).toBe(0);
  });

  it("the module never names the system temporary directory (ADR-0001)", () => {
    const source = readFileSync(join(import.meta.dirname, "script-dir.ts"), "utf8");
    expect(source.includes("tmpdir()")).toBe(false);
  });
});
