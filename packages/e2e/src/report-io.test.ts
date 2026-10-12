import { describe, expect, it } from "vitest";
import { type ReportRow, renderReport } from "./report.js";
import { addFrontMatterNote, parseReport, setRatified, updateReportOutcome } from "./report-io.js";

const status = (
  number: number,
  title: string,
  runClass: "auto" | "auto+look",
  value: "pass" | "fail" | "inconclusive (look pending)" | "skipped-profile",
  message = "",
): ReportRow => ({
  number,
  title,
  runClass,
  resolution: { kind: "status", item: number, status: value, reason: `reason ${value}`, message },
});

const SAMPLE_ROWS: ReportRow[] = [
  status(1, "Banner look", "auto+look", "inconclusive (look pending)"),
  {
    number: 2,
    title: "Click the banner",
    runClass: "owner",
    resolution: {
      kind: "owner",
      item: 2,
      partials: [{ title: "[06-UAT#02] part", state: "passed", durationMs: 5, message: "" }],
    },
  },
  status(5, "Deny | with pipe", "auto", "pass"),
  status(7, "Approve", "auto", "fail", "boom"),
  status(21, "Scale", "auto", "skipped-profile"),
];

function sampleReport(): string {
  return renderReport({
    runId: "0123abcd",
    profile: "standard",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:05:00.000Z",
    appVersion: "1.14.4",
    installerVersion: "1.13.7",
    gitHead: "a".repeat(40),
    gitClean: true,
    buildHash: "0123456789ab",
    phasePrefix: "06",
    rows: SAMPLE_ROWS,
  });
}

function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.flatMap((line, index) => (line === b[index] ? [] : [index]));
}

describe("parseReport (Test 1)", () => {
  it("reads back the front matter, the item outcomes and the owner partials", () => {
    const parsed = parseReport(sampleReport());
    expect(parsed.frontMatter["run-id"]).toBe("0123abcd");
    expect(parsed.frontMatter.profile).toBe("standard");
    expect(parsed.frontMatter["git-head"]).toBe("a".repeat(40));
    expect(parsed.frontMatter["git-clean"]).toBe("true");
    expect(parsed.frontMatter.ratified).toBe("pending");
    expect(parsed.rows.map((row) => [row.number, row.runClass, row.status])).toEqual([
      [1, "auto+look", "inconclusive (look pending)"],
      [2, "owner", "owner"],
      [5, "auto", "pass"],
      [7, "auto", "fail"],
      [21, "auto", "skipped-profile"],
    ]);
    expect(parsed.rows[2]?.title).toContain("Deny");
    expect(parsed.rows[3]?.note).toContain("boom");
    expect(parsed.partials).toHaveLength(1);
    expect(parsed.partials[0]?.item).toBe(2);
    expect(parsed.partials[0]?.lines.join("\n")).toContain("part");
    expect(parsed.counts).toEqual({ "auto-passed": 1, "auto-failed": 1, "owner-pending": 1 });
  });

  it("refuses text that is not a report", () => {
    expect(() => parseReport("just words")).toThrow();
  });
});

describe("updateReportOutcome (Test 1)", () => {
  it("changes only that item's row and the summary counts", () => {
    const before = sampleReport();
    const after = updateReportOutcome(before, 1, "pass", "the look verdict passed");
    const changed = changedLines(before, after);
    expect(changed).toHaveLength(2);
    const parsed = parseReport(after);
    expect(parsed.rows[0]?.status).toBe("pass");
    expect(parsed.rows[0]?.note).toBe("the look verdict passed");
    expect(parsed.rows[0]?.title).toBe("Banner look");
    expect(parsed.counts["auto-passed"]).toBe(2);
    expect(after.split("\n")[changed[0] as number]).toContain("auto-passed");
  });

  it("counts a failed verdict in auto-failed", () => {
    const after = updateReportOutcome(sampleReport(), 1, "fail", "the look verdict failed");
    expect(parseReport(after).counts["auto-failed"]).toBe(2);
  });

  it("refuses an owner row and an item that is not in the report", () => {
    expect(() => updateReportOutcome(sampleReport(), 2, "pass", "x")).toThrow();
    expect(() => updateReportOutcome(sampleReport(), 99, "pass", "x")).toThrow();
  });

  it("keeps a pipe in a title from shifting the cells", () => {
    const after = updateReportOutcome(sampleReport(), 5, "fail", "changed");
    expect(parseReport(after).rows[2]?.status).toBe("fail");
    expect(parseReport(after).rows[2]?.title).toContain("with pipe");
  });
});

describe("setRatified (Test 1)", () => {
  it("changes only the ratified line", () => {
    const before = sampleReport();
    const after = setRatified(before, "Owner accepts run 0123abcd", "2026-10-12");
    const changed = changedLines(before, after);
    expect(changed).toHaveLength(1);
    expect(after.split("\n")[changed[0] as number]).toBe(
      "ratified: Owner accepts run 0123abcd (2026-10-12)",
    );
  });

  it("refuses an empty, multi-line, control-character or overlong statement", () => {
    for (const bad of ["", "   ", "two\nlines", `bell${String.fromCharCode(7)}`, "x".repeat(300)]) {
      expect(() => setRatified(sampleReport(), bad, "2026-10-12")).toThrow();
    }
  });

  it("refuses a malformed date and an already ratified report", () => {
    expect(() => setRatified(sampleReport(), "ok", "yesterday")).toThrow();
    const once = setRatified(sampleReport(), "ok", "2026-10-12");
    expect(() => setRatified(once, "again", "2026-10-13")).toThrow();
  });

  it("sanitises a home path out of the statement", () => {
    const after = setRatified(sampleReport(), "see /Users/someone/notes ok", "2026-10-12");
    expect(after).not.toContain("someone");
  });
});

describe("addFrontMatterNote", () => {
  it("inserts one line before the unratified marker and changes nothing else", () => {
    const before = sampleReport();
    const after = addFrontMatterNote(before, "version-mismatch", "app-differs-from-decision");
    const lines = after.split("\n");
    expect(lines.length).toBe(before.split("\n").length + 1);
    expect(lines.indexOf("ratified: pending")).toBe(
      lines.indexOf("version-mismatch: app-differs-from-decision") + 1,
    );
    expect(after.replace("version-mismatch: app-differs-from-decision\n", "")).toBe(before);
  });

  it("refuses a key or value outside the plain vocabulary", () => {
    expect(() => addFrontMatterNote(sampleReport(), "Bad Key", "x")).toThrow();
    expect(() => addFrontMatterNote(sampleReport(), "note", "/Users/a/b")).toThrow();
  });
});
