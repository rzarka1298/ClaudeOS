import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepWdioLogs, purgeStaleWdioLogs } from "./wdio-logs.js";

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

  it("also keeps the service logs (live and archived) from the runtime directory, never following a link", () => {
    const base = scratch();
    const wdio = join(base, "wdio");
    const rt = join(base, "rt");
    mkdirSync(wdio);
    mkdirSync(join(rt, "logs"), { recursive: true });
    mkdirSync(join(rt, "kept-logs"));
    writeFileSync(join(wdio, "wdio.log"), "w");
    writeFileSync(join(rt, "logs", "service.log"), "live");
    writeFileSync(join(rt, "kept-logs", "1-service.log"), "old");
    const secret = join(base, "secret.txt");
    writeFileSync(secret, "private");
    symlinkSync(secret, join(rt, "logs", "evil.log"));
    const dest = keepWdioLogs({ wdioDir: wdio, destBase: base, runId: "svc", runtimeDir: rt });
    expect(readdirSync(dest as string).sort()).toEqual([
      "service-kept-1-service.log",
      "service-service.log",
      "wdio.log",
    ]);
    expect(readFileSync(join(dest as string, "service-service.log"), "utf8")).toBe("live");
  });

  it("keeps service logs even when there is no wdio folder", () => {
    const base = scratch();
    const rt = join(base, "rt");
    mkdirSync(join(rt, "logs"), { recursive: true });
    writeFileSync(join(rt, "logs", "service.log"), "live");
    const dest = keepWdioLogs({
      wdioDir: join(base, "none"),
      destBase: base,
      runId: "x",
      runtimeDir: rt,
    });
    expect(readdirSync(dest as string)).toEqual(["service-service.log"]);
  });

  it("returns null when there is no wdio folder", () => {
    const base = scratch();
    expect(keepWdioLogs({ wdioDir: join(base, "none"), destBase: base, runId: "x" })).toBeNull();
  });
});

describe("purgeStaleWdioLogs (review IN-02)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const make = (base: string, name: string, ageMs: number, now: number): string => {
    const dir = join(base, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "wdio-0-0.log"), "x");
    utimesSync(dir, (now - ageMs) / 1000, (now - ageMs) / 1000);
    return dir;
  };

  it("removes only ccc-uat-wdio-logs folders older than the age limit, never other names", () => {
    const base = scratch();
    const now = Date.now();
    make(base, "ccc-uat-wdio-logs-old-aaaaaa", 8 * DAY, now);
    make(base, "ccc-uat-wdio-logs-new-bbbbbb", 1 * DAY, now);
    make(base, "ccc-uat-shots-old", 30 * DAY, now);
    make(base, "unrelated", 30 * DAY, now);
    const removed = purgeStaleWdioLogs({ base, maxAgeMs: 7 * DAY, now });
    expect(removed).toEqual(["ccc-uat-wdio-logs-old-aaaaaa"]);
    expect(readdirSync(base).sort()).toEqual([
      "ccc-uat-shots-old",
      "ccc-uat-wdio-logs-new-bbbbbb",
      "unrelated",
    ]);
  });

  it("unlinks a symlink with a matching name without following it, and tolerates a missing base", () => {
    const base = scratch();
    const target = scratch();
    writeFileSync(join(target, "keep.txt"), "keep");
    symlinkSync(target, join(base, "ccc-uat-wdio-logs-link-cccccc"));
    const now = Date.now() + 60_000;
    expect(purgeStaleWdioLogs({ base, maxAgeMs: 0, now })).toEqual([
      "ccc-uat-wdio-logs-link-cccccc",
    ]);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
    expect(purgeStaleWdioLogs({ base: join(base, "missing"), maxAgeMs: DAY, now })).toEqual([]);
  });
});
