import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readBoundedRegularFile,
  readBoundedRegularFileAsync,
  readBoundedRegularFileDetailed,
} from "./bounded-read.js";
import {
  nodePathExistsAsync,
  readClaudeSettingsFacts,
  readClaudeSettingsFactsAsync,
  readInstallRecord,
  readInstallRecordAsync,
} from "./integration-status.js";

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

// ---------------------------------------------------------------------------
// FIX2A F5 and F1: a missing file is a fact ("not installed"), an unreadable one is not; and the
// per-request reads are asynchronous, so a stalled file system cannot hold the event loop.

describe("FIX2A F5: missing is distinguished from unreadable", () => {
  it("the detailed read tells a missing path (ENOENT) from every other failure", () => {
    const file = join(dir, "a.json");
    writeFileSync(file, "{}");
    expect(readBoundedRegularFileDetailed(file, 1024)).toEqual({ kind: "text", text: "{}" });
    expect(readBoundedRegularFileDetailed(join(dir, "missing"), 1024)).toEqual({ kind: "missing" });
    expect(readBoundedRegularFileDetailed(dir, 1024)).toEqual({ kind: "unreadable" });
    const big = join(dir, "big");
    writeFileSync(big, "x".repeat(2000));
    expect(readBoundedRegularFileDetailed(big, 1999)).toEqual({ kind: "unreadable" });
    const fifo = join(dir, "fifo");
    makeFifo(fifo);
    expect(readBoundedRegularFileDetailed(fifo, 1024)).toEqual({ kind: "unreadable" });
  });

  it("the async read gives the same answers, and a FIFO or /dev/zero does not hang it", async () => {
    const file = join(dir, "a.json");
    writeFileSync(file, '{"a":1}');
    expect(await readBoundedRegularFileAsync(file, 1024)).toEqual({
      kind: "text",
      text: '{"a":1}',
    });
    expect(await readBoundedRegularFileAsync(join(dir, "missing"), 1024)).toEqual({
      kind: "missing",
    });
    expect(await readBoundedRegularFileAsync(dir, 1024)).toEqual({ kind: "unreadable" });
    const fifo = join(dir, "fifo");
    makeFifo(fifo);
    expect(await readBoundedRegularFileAsync(fifo, 1024)).toEqual({ kind: "unreadable" });
    const zero = join(dir, "zero");
    symlinkSync("/dev/zero", zero);
    expect(await readBoundedRegularFileAsync(zero, 1024 * 1024)).toEqual({ kind: "unreadable" });
    const big = join(dir, "big");
    writeFileSync(big, "x".repeat(2000));
    expect(await readBoundedRegularFileAsync(big, 1999)).toEqual({ kind: "unreadable" });
  });

  it("an already-aborted signal reads nothing", async () => {
    const file = join(dir, "a.json");
    writeFileSync(file, "{}");
    const controller = new AbortController();
    controller.abort();
    expect(await readBoundedRegularFileAsync(file, 1024, controller.signal)).toEqual({
      kind: "unreadable",
    });
  });

  it("settings: no settings.json at all reads not-installed for hooks and the status line (a fresh install)", async () => {
    const absent = join(dir, "absent-settings.json");
    const expected = {
      hooks: "not-installed",
      statusLine: "not-installed",
      disableAllHooks: false,
      cleanupPeriodDays: 30,
      hookNodePath: null,
    };
    expect(readClaudeSettingsFacts(absent, runtimeDirOf())).toEqual(expected);
    expect(await readClaudeSettingsFactsAsync(absent, runtimeDirOf())).toEqual(expected);
  });

  it("settings: only an unreadable, non-regular, oversize or invalid file reads unknown", async () => {
    const unknown = {
      hooks: "unknown",
      statusLine: "unknown",
      disableAllHooks: null,
      cleanupPeriodDays: 30,
      hookNodePath: null,
    };
    const asDirectory = join(dir, "dir-settings.json");
    mkdirSync(asDirectory);
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, "{ not json");
    const notObject = join(dir, "array.json");
    writeFileSync(notObject, "[]");
    const fifo = join(dir, "fifo-settings.json");
    makeFifo(fifo);
    const huge = join(dir, "huge.json");
    writeFileSync(huge, " ".repeat(1024 * 1024 + 1));
    for (const path of [asDirectory, invalid, notObject, fifo, huge]) {
      expect(readClaudeSettingsFacts(path, runtimeDirOf()), path).toEqual(unknown);
      expect(await readClaudeSettingsFactsAsync(path, runtimeDirOf()), path).toEqual(unknown);
    }
  });

  it("install record: absent or unreadable is null, a good one reads, sync and async alike", async () => {
    expect(readInstallRecord(runtimeDirOf())).toBeNull();
    expect(await readInstallRecordAsync(runtimeDirOf())).toBeNull();
    mkdirSync(join(runtimeDirOf(), "hooks"), { recursive: true });
    writeFileSync(
      join(runtimeDirOf(), "hooks", "install.json"),
      JSON.stringify({ nodePath: "/opt/n", claudeBin: "/opt/c" }),
    );
    expect(await readInstallRecordAsync(runtimeDirOf())).toEqual({
      nodePath: "/opt/n",
      claudeBin: "/opt/c",
    });
  });
});

function runtimeDirOf(): string {
  return join(dir, "runtime");
}

describe("FIX6A Codex-1: at most one open per path and cap in flight", () => {
  /** A handle for a regular, empty file: the read ends at once. */
  const emptyFile = () => ({
    stat: () => Promise.resolve({ isFile: () => true, size: 0 }),
    read: () => Promise.resolve({ bytesRead: 0 }),
    close: vi.fn(() => Promise.resolve()),
  });

  it("N checks over a never-settling open start exactly one open, and each caller still times out on its own signal", async () => {
    const open = vi.fn(() => new Promise<never>(() => undefined));
    const fs = { open } as never;
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const reads = controllers.map((c) =>
      readBoundedRegularFileAsync("/Users/username/.claude/settings.json", 1024, c.signal, fs),
    );
    await Promise.resolve();
    for (const c of controllers) c.abort();
    for (const read of reads) expect(await read).toEqual({ kind: "unreadable" });
    expect(open).toHaveBeenCalledTimes(1);
    // A later check, while the first open is still stuck, joins it: still one open.
    const later = new AbortController();
    const laterRead = readBoundedRegularFileAsync(
      "/Users/username/.claude/settings.json",
      1024,
      later.signal,
      fs,
    );
    later.abort();
    expect(await laterRead).toEqual({ kind: "unreadable" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("once the open settles, the next check starts a fresh one", async () => {
    let release: (handle: ReturnType<typeof emptyFile>) => void = () => undefined;
    const open = vi.fn(
      () =>
        new Promise<ReturnType<typeof emptyFile>>((resolve) => {
          release = resolve;
        }),
    );
    const fs = { open } as never;
    const path = "/Users/username/.claude/settings.json";
    const first = new AbortController();
    const stuck = readBoundedRegularFileAsync(path, 1024, first.signal, fs);
    first.abort();
    expect(await stuck).toEqual({ kind: "unreadable" });
    const handle = emptyFile();
    release(handle);
    // Let the abandoned shared read finish and close its handle.
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
    open.mockImplementation(() => Promise.resolve(emptyFile()));
    expect(await readBoundedRegularFileAsync(path, 1024, undefined, fs)).toEqual({
      kind: "text",
      text: "",
    });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("different paths do not share a flight", async () => {
    const open = vi.fn(() => new Promise<never>(() => undefined));
    const fs = { open } as never;
    const c = new AbortController();
    const a = readBoundedRegularFileAsync("/Users/username/a", 1024, c.signal, fs);
    const b = readBoundedRegularFileAsync("/Users/username/b", 1024, c.signal, fs);
    await Promise.resolve();
    c.abort();
    await Promise.all([a, b]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("a caller whose signal never fires still gets the shared answer", async () => {
    const open = vi.fn(() => Promise.resolve(emptyFile()));
    const fs = { open } as never;
    const [a, b] = await Promise.all([
      readBoundedRegularFileAsync("/Users/username/x", 1024, undefined, fs),
      readBoundedRegularFileAsync("/Users/username/x", 1024, undefined, fs),
    ]);
    expect(a).toEqual({ kind: "text", text: "" });
    expect(b).toEqual(a);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("FIX6A Codex-1: the node path access check is single-flight per path", () => {
  it("N checks over a never-settling access start exactly one access; once it settles the next starts fresh", async () => {
    let release: () => void = () => undefined;
    const access = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const fs = { access };
    const path = "/Users/username/.nvm/node";
    const checks = Array.from({ length: 5 }, () => nodePathExistsAsync(path, fs));
    expect(access).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all(checks)).toEqual([true, true, true, true, true]);
    access.mockImplementation(() => Promise.reject(new Error("ENOENT")));
    expect(await nodePathExistsAsync(path, fs)).toBe(false);
    expect(access).toHaveBeenCalledTimes(2);
  });
});
