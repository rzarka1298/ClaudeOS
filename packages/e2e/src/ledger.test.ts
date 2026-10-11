import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLedger,
  findLeaks,
  findRunRootProcesses,
  type LedgerEntry,
  readLedger,
} from "./ledger.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-e2e-ledger-"));
  file = join(dir, "ledger.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENTRIES: LedgerEntry[] = [
  {
    kind: "run",
    runId: "0123abcd",
    runRoot: "/tmp/ccc-uat.abc123",
    startedAt: "2026-10-11T10:00:00.000Z",
    ownerPid: 4242,
    ownerStart: "Sun Oct 11 10:00:00 2026",
  },
  { kind: "account", account: "ccc-uat-0123abcd" },
  { kind: "dir", path: "/tmp/ccc-uat.abc123/vaults" },
  { kind: "pid", role: "service", pid: 777, start: "Sun Oct 11 10:00:01 2026", marker: "main.js" },
  { kind: "leaked", at: "2026-10-11T10:05:00.000Z", pids: [777] },
  { kind: "closed", at: "2026-10-11T10:06:00.000Z" },
];

describe("leak detection (Task 2, Test 2)", () => {
  const pidEntry: LedgerEntry = { kind: "pid", role: "service", pid: 321, start: "T1", marker: "m" };

  it("reports a ledgered pid only when the table has the same pid with the same start time", () => {
    expect(findLeaks([pidEntry], [{ pid: 321, start: "T1", command: "x" }])).toEqual([
      { pid: 321, reason: "ledgered process still alive", role: "service", command: "x" },
    ]);
    expect(findLeaks([pidEntry], [{ pid: 321, start: "T2", command: "x" }])).toEqual([]);
    expect(findLeaks([pidEntry], [{ pid: 322, start: "T1", command: "x" }])).toEqual([]);
    expect(findLeaks([{ kind: "account", account: "ccc-uat-abc" }], [])).toEqual([]);
  });

  it("reports processes naming the run root and excludes the runner's own pid", () => {
    const table = [
      { pid: 10, start: "T", command: "Obsidian --user-data-dir=/tmp/ccc-uat.abc123/wdio" },
      { pid: 11, start: "T", command: "node runner /tmp/ccc-uat.abc123" },
      { pid: 12, start: "T", command: "unrelated /tmp/ccc-uat.zzz999" },
    ];
    expect(findRunRootProcesses(table, "/tmp/ccc-uat.abc123", 11).map((leak) => leak.pid)).toEqual([
      10,
    ]);
  });
});

describe("ledger (Test 8)", () => {
  it("writes JSON lines with mode 0600 and reads them back in order", () => {
    const previous = process.umask(0);
    try {
      for (const entry of ENTRIES) appendLedger(file, entry);
    } finally {
      process.umask(previous);
    }
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readLedger(file)).toEqual(ENTRIES);
  });

  it("returns an empty list for a missing ledger", () => {
    expect(readLedger(join(dir, "none.jsonl"))).toEqual([]);
  });

  it("rejects an unknown kind and a malformed entry on read", () => {
    writeFileSync(file, `${JSON.stringify({ kind: "weird", x: 1 })}\n`);
    expect(() => readLedger(file)).toThrow();
    writeFileSync(file, `${JSON.stringify({ kind: "pid", role: "service", pid: "x" })}\n`);
    expect(() => readLedger(file)).toThrow();
    writeFileSync(file, `${JSON.stringify({ kind: "account", account: "install-secret" })}\n`);
    expect(() => readLedger(file)).toThrow();
  });

  it("ignores a torn last line but not a torn middle line", () => {
    appendLedger(file, ENTRIES[1] as LedgerEntry);
    appendFileSync(file, '{"kind":"dir","pa');
    expect(readLedger(file)).toEqual([ENTRIES[1]]);
    appendFileSync(file, `\n${JSON.stringify(ENTRIES[2])}\n`);
    expect(() => readLedger(file)).toThrow();
  });
});
