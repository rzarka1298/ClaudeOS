import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoundedRegularFile } from "./bounded-read.js";
import { readClaudeSettingsFacts, readInstallRecord } from "./integration-status.js";

/**
 * FIX1A MINOR 6: Claude's settings and the installer record are read through a
 * descriptor that must be a regular file and a byte cap. A FIFO, or a symlink
 * to a device such as /dev/zero, reads as unreadable/unknown instead of
 * blocking the service or reading without limit. Real FIFO and symlink in an
 * OS temp dir; nothing under the real home is touched.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-bounded-read-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeFifo(path: string): void {
  execFileSync("/usr/bin/mkfifo", [path]);
}

describe("readBoundedRegularFile", () => {
  it("reads a regular file, and follows a symlink to one", () => {
    const file = join(dir, "a.json");
    writeFileSync(file, '{"a":1}');
    expect(readBoundedRegularFile(file, 1024)).toBe('{"a":1}');
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    expect(readBoundedRegularFile(link, 1024)).toBe('{"a":1}');
  });

  it("returns null for a missing path, a directory and a file over the cap", () => {
    expect(readBoundedRegularFile(join(dir, "missing"), 1024)).toBeNull();
    expect(readBoundedRegularFile(dir, 1024)).toBeNull();
    const big = join(dir, "big");
    writeFileSync(big, "x".repeat(2000));
    expect(readBoundedRegularFile(big, 1999)).toBeNull();
    expect(readBoundedRegularFile(big, 2000)).toBe("x".repeat(2000));
  });

  it("returns null for a FIFO without blocking", () => {
    const fifo = join(dir, "fifo");
    makeFifo(fifo);
    expect(readBoundedRegularFile(fifo, 1024)).toBeNull();
  });

  it("returns null for a symlink to /dev/zero, quickly and without reading it", () => {
    const link = join(dir, "zero");
    symlinkSync("/dev/zero", link);
    const startedAt = Date.now();
    expect(readBoundedRegularFile(link, 1024 * 1024)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe("the Claude readers on hostile files", () => {
  const runtimeDir = () => join(dir, "runtime");

  it("settings: a FIFO or a /dev/zero symlink reads as unknown", () => {
    const settings = join(dir, "settings.json");
    makeFifo(settings);
    expect(readClaudeSettingsFacts(settings, runtimeDir()).hooks).toBe("unknown");
    expect(readClaudeSettingsFacts(settings, runtimeDir()).disableAllHooks).toBeNull();

    const zero = join(dir, "settings-zero.json");
    symlinkSync("/dev/zero", zero);
    expect(readClaudeSettingsFacts(zero, runtimeDir()).hooks).toBe("unknown");
  });

  it("install record: a FIFO or a /dev/zero symlink reads as null", () => {
    mkdirSync(join(runtimeDir(), "hooks"), { recursive: true });
    const record = join(runtimeDir(), "hooks", "install.json");
    makeFifo(record);
    expect(readInstallRecord(runtimeDir())).toBeNull();
    rmSync(record);
    symlinkSync("/dev/zero", record);
    expect(readInstallRecord(runtimeDir())).toBeNull();
  });

  it("an ordinary settings file and record still read", () => {
    mkdirSync(join(runtimeDir(), "hooks"), { recursive: true });
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ disableAllHooks: true, cleanupPeriodDays: 7 }));
    const facts = readClaudeSettingsFacts(settings, runtimeDir());
    expect(facts.disableAllHooks).toBe(true);
    expect(facts.cleanupPeriodDays).toBe(7);
    writeFileSync(
      join(runtimeDir(), "hooks", "install.json"),
      JSON.stringify({ nodePath: "/opt/n", claudeBin: "/opt/c" }),
    );
    expect(readInstallRecord(runtimeDir())).toEqual({ nodePath: "/opt/n", claudeBin: "/opt/c" });
  });
});
