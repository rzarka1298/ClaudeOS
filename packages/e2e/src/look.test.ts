import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOOK_PENDING_FILE, listPending, recordVerdict, writeLookHandoff } from "./look.js";
import { type ReportRow, renderReport } from "./report.js";
import { parseReport } from "./report-io.js";
import type { LookPendingItem } from "./run-uat.js";

const lookRow = (number: number): ReportRow => ({
  number,
  title: `Look item ${number}`,
  runClass: "auto+look",
  resolution: {
    kind: "status",
    item: number,
    status: "inconclusive (look pending)",
    reason: "tests passed; no look verdict yet",
    message: "",
  },
});

const passRow: ReportRow = {
  number: 5,
  title: "Deny",
  runClass: "auto",
  resolution: { kind: "status", item: 5, status: "pass", reason: "all tests passed", message: "" },
};

function report(runId = "0123abcd"): string {
  return renderReport({
    runId,
    profile: "standard",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:05:00.000Z",
    appVersion: "1.14.4",
    installerVersion: "1.13.7",
    gitHead: "a".repeat(40),
    gitClean: true,
    buildHash: "0123456789ab",
    phasePrefix: "06",
    rows: [passRow, lookRow(12), lookRow(20)],
  });
}

let base: string;
let shots: string;
let reportPath: string;

function image(item: number, label: string): string {
  const name = `${String(item).padStart(2, "0")}-${label}.png`;
  const path = join(shots, name);
  writeFileSync(path, "not really a png");
  return path;
}

function handoff(items: LookPendingItem[], runId = "0123abcd", withReport = true): void {
  writeLookHandoff({ shotsDir: shots, runId, reportPath: withReport ? reportPath : null, items });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "look-test-"));
  shots = join(base, "ccc-uat-shots-0123abcd");
  mkdirSync(shots, { mode: 0o700 });
  reportPath = join(base, "06-UAT-AUTO-REPORT.md");
  writeFileSync(reportPath, report());
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("writeLookHandoff and listPending (Test 2)", () => {
  it("writes a private state file and lists the pending items with labels and counts", () => {
    handoff([{ item: 12, labels: ["pane", "settings"], count: 2 }]);
    expect(statSync(join(shots, LOOK_PENDING_FILE)).mode & 0o077).toBe(0);
    const state = listPending(shots);
    expect(state.runId).toBe("0123abcd");
    expect(state.items).toEqual([{ item: 12, labels: ["pane", "settings"], count: 2 }]);
  });

  it("deletes the whole shots folder at once when nothing awaits a look", () => {
    image(12, "pane");
    handoff([]);
    expect(existsSync(shots)).toBe(false);
  });

  it("refuses a folder that is not a screenshots folder, and a listing with no state", () => {
    const other = join(base, "elsewhere");
    mkdirSync(other);
    expect(() =>
      writeLookHandoff({ shotsDir: other, runId: "0123abcd", reportPath: null, items: [] }),
    ).toThrow();
    expect(() => listPending(shots)).toThrow();
  });
});

describe("recordVerdict (Tests 2 and 3)", () => {
  it("pass: deletes both images, updates the report row and leaves other items pending", () => {
    const first = image(12, "pane");
    const second = image(12, "settings");
    const other = image(20, "banner");
    handoff([
      { item: 12, labels: ["pane", "settings"], count: 2 },
      { item: 20, labels: ["banner"], count: 1 },
    ]);
    const result = recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 2 });
    expect(result).toEqual({ item: 12, status: "pass", remaining: 1 });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(other)).toBe(true);
    const row = parseReport(readFileSync(reportPath, "utf8")).rows.find((r) => r.number === 12);
    expect(row?.status).toBe("pass");
    expect(listPending(shots).items.map((entry) => entry.item)).toEqual([20]);
  });

  it("removes the whole folder when the last pending item is recorded", () => {
    image(12, "pane");
    image(12, "settings");
    handoff([{ item: 12, labels: ["pane", "settings"], count: 2 }]);
    const result = recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 2 });
    expect(result.remaining).toBe(0);
    expect(existsSync(shots)).toBe(false);
    const rows = parseReport(readFileSync(reportPath, "utf8")).rows;
    expect(rows.find((r) => r.number === 12)?.status).toBe("pass");
    expect(rows.find((r) => r.number === 20)?.status).toBe("inconclusive (look pending)");
  });

  it("a fail verdict turns the row to fail", () => {
    image(12, "pane");
    handoff([{ item: 12, labels: ["pane"], count: 1 }]);
    const result = recordVerdict({ shotsDir: shots, item: 12, verdict: "fail", images: 1 });
    expect(result.status).toBe("fail");
    expect(
      parseReport(readFileSync(reportPath, "utf8")).rows.find((r) => r.number === 12)?.status,
    ).toBe("fail");
  });

  it("refuses a different image count and changes nothing", () => {
    const first = image(12, "pane");
    image(12, "settings");
    handoff([{ item: 12, labels: ["pane", "settings"], count: 2 }]);
    const before = readFileSync(reportPath, "utf8");
    expect(() =>
      recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 3 }),
    ).toThrow();
    expect(() =>
      recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 1 }),
    ).toThrow();
    expect(readFileSync(reportPath, "utf8")).toBe(before);
    expect(existsSync(first)).toBe(true);
    expect(listPending(shots).items).toHaveLength(1);
  });

  it("refuses an item that is not pending, and a second record for the same item", () => {
    image(12, "pane");
    image(20, "banner");
    handoff([
      { item: 12, labels: ["pane"], count: 1 },
      { item: 20, labels: ["banner"], count: 1 },
    ]);
    expect(() => recordVerdict({ shotsDir: shots, item: 5, verdict: "pass", images: 1 })).toThrow();
    recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 1 });
    expect(() =>
      recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 1 }),
    ).toThrow();
  });

  it("can never pass an item that recorded no images", () => {
    handoff([{ item: 12, labels: [], count: 0 }]);
    const before = readFileSync(reportPath, "utf8");
    expect(() =>
      recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 0 }),
    ).toThrow();
    expect(() =>
      recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 1 }),
    ).toThrow();
    expect(readFileSync(reportPath, "utf8")).toBe(before);
  });

  it("refuses when a recorded image is missing, changing nothing", () => {
    image(12, "pane");
    handoff([{ item: 12, labels: ["pane", "settings"], count: 2 }]);
    const before = readFileSync(reportPath, "utf8");
    expect(() =>
      recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 2 }),
    ).toThrow();
    expect(readFileSync(reportPath, "utf8")).toBe(before);
    expect(existsSync(join(shots, "12-pane.png"))).toBe(true);
  });

  it("refuses a report of another run or a row that is not awaiting a look", () => {
    image(12, "pane");
    writeFileSync(reportPath, report("deadbeef"));
    handoff([{ item: 12, labels: ["pane"], count: 1 }]);
    expect(() =>
      recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 1 }),
    ).toThrow();
    writeFileSync(reportPath, report());
    image(5, "pane");
    handoff([{ item: 5, labels: ["pane"], count: 1 }]);
    expect(() => recordVerdict({ shotsDir: shots, item: 5, verdict: "pass", images: 1 })).toThrow();
  });

  it("records a verdict with no report path, deleting the images", () => {
    const only = image(12, "pane");
    handoff([{ item: 12, labels: ["pane"], count: 1 }], "0123abcd", false);
    recordVerdict({ shotsDir: shots, item: 12, verdict: "pass", images: 1 });
    expect(existsSync(only)).toBe(false);
  });
});
