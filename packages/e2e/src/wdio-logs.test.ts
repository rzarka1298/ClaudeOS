import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepWdioLogs } from "./wdio-logs.js";

const scratch = () => mkdtempSync(join(tmpdir(), "ccc-wdio-logs-test-"));

describe("keepWdioLogs", () => {
  it("copies regular .log files into a fresh random 0700 folder and returns it", () => {
    const base = scratch();
    const wdio = join(base, "wdio");
    mkdirSync(wdio);
    writeFileSync(join(wdio, "wdio-0-0.log"), "hook error");
    writeFileSync(join(wdio, "notes.txt"), "skip");
    const dest = keepWdioLogs({ wdioDir: wdio, destBase: base, runId: "abc" });
    expect(dest).not.toBeNull();
    expect(dest?.startsWith(join(base, "ccc-uat-wdio-logs-abc-"))).toBe(true);
    expect(readdirSync(dest as string)).toEqual(["wdio-0-0.log"]);
    expect(readFileSync(join(dest as string, "wdio-0-0.log"), "utf8")).toBe("hook error");
    expect(statSync(dest as string).mode & 0o777).toBe(0o700);
  });

  it("never follows a symlink and never reuses a pre-placed path", () => {
    const base = scratch();
    const wdio = join(base, "wdio");
    mkdirSync(wdio);
    const secret = join(base, "secret.txt");
    writeFileSync(secret, "private");
    symlinkSync(secret, join(wdio, "evil.log"));
    mkdirSync(join(wdio, "dir.log"));
    // A predictable pre-placed folder (the old naming) is ignored, not written into.
    const planted = join(base, "ccc-uat-wdio-logs-abc");
    mkdirSync(planted);
    const dest = keepWdioLogs({ wdioDir: wdio, destBase: base, runId: "abc" });
    expect(dest).not.toBe(planted);
    expect(readdirSync(dest as string)).toEqual([]);
    expect(readdirSync(planted)).toEqual([]);
  });

  it("returns null when there is no wdio folder", () => {
    const base = scratch();
    expect(keepWdioLogs({ wdioDir: join(base, "none"), destBase: base, runId: "x" })).toBeNull();
  });
});
