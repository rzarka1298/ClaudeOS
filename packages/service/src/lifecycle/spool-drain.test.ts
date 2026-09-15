import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logging.js";
import { drainSpool } from "./spool-drain.js";

let dir: string;
let spoolPath: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-spool-drain-"));
  spoolPath = join(dir, "hooks.ndjson");
  logPath = join(dir, "service.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLogLines(): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("drainSpool", () => {
  it("returns all records from a spool file with three newline-delimited records and leaves the file at zero length", () => {
    writeFileSync(spoolPath, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const logger = createLogger(logPath);
    const records = drainSpool(spoolPath, logger);
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(statSync(spoolPath).size).toBe(0);
  });

  it("a second drain with no intervening writes returns nothing and does not error", () => {
    writeFileSync(spoolPath, '{"a":1}\n');
    const logger = createLogger(logPath);
    drainSpool(spoolPath, logger);
    expect(() => drainSpool(spoolPath, logger)).not.toThrow();
    expect(drainSpool(spoolPath, logger)).toEqual([]);
  });

  it("retains a trailing partial record with no terminating newline rather than parsing it", () => {
    writeFileSync(spoolPath, '{"a":1}\n{"b":2');
    const logger = createLogger(logPath);
    const records = drainSpool(spoolPath, logger);
    expect(records).toEqual([{ a: 1 }]);
    expect(readFileSync(spoolPath, "utf8")).toBe('{"b":2');
  });

  it("treats an absent spool file as no records, not an error", () => {
    const logger = createLogger(logPath);
    expect(() => drainSpool(spoolPath, logger)).not.toThrow();
    expect(drainSpool(spoolPath, logger)).toEqual([]);
  });

  it("logs and skips a record that fails to parse rather than aborting the whole drain", () => {
    writeFileSync(spoolPath, '{"a":1}\nnot-json\n{"c":3}\n');
    const logger = createLogger(logPath);
    const records = drainSpool(spoolPath, logger);
    expect(records).toEqual([{ a: 1 }, { c: 3 }]);
    const lines = readLogLines();
    const warnLine = lines.find((l) => l.level === 40);
    expect(warnLine).toBeDefined();
  });
});
