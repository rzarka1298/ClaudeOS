import { describe, expect, it } from "vitest";
import { checkRatifiable, ratifyReport } from "./ratify.js";
import { type ReportRow, renderReport } from "./report.js";
import { type ParsedReport, parseReport } from "./report-io.js";

const HEAD = "a".repeat(40);
const NEWER = "b".repeat(40);

const row = (
  number: number,
  value: "pass" | "fail" | "inconclusive" | "inconclusive (look pending)" | "skipped-profile",
  runClass: "auto" | "auto+look" = "auto",
): ReportRow => ({
  number,
  title: `Item ${number}`,
  runClass,
  resolution: { kind: "status", item: number, status: value, reason: "r", message: "" },
});

const OWNER: ReportRow = {
  number: 2,
  title: "Owner item",
  runClass: "owner",
  resolution: { kind: "owner", item: 2, partials: [] },
};

function report(
  rows: ReportRow[],
  over: { gitClean?: boolean; gitHead?: string; runId?: string } = {},
) {
  return renderReport({
    runId: over.runId ?? "0123abcd",
    profile: "standard",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:05:00.000Z",
    appVersion: "1.14.4",
    installerVersion: "1.13.7",
    gitHead: over.gitHead ?? HEAD,
    gitClean: over.gitClean ?? true,
    buildHash: "0123456789ab",
    phasePrefix: "06",
    rows,
  });
}

const GOOD = [row(1, "pass", "auto+look"), row(5, "pass"), row(21, "skipped-profile"), OWNER];

function check(
  text: string,
  over: Partial<{ runId: string; currentHead: string; changedFiles: string[] | null }> = {},
) {
  const parsed: ParsedReport = parseReport(text);
  return checkRatifiable({
    report: parsed,
    runId: over.runId ?? "0123abcd",
    currentHead: over.currentHead ?? HEAD,
    changedFiles: over.changedFiles === undefined ? [] : over.changedFiles,
  });
}

describe("checkRatifiable (Test 4)", () => {
  it("returns no reasons for an all-pass, clean, current run", () => {
    expect(check(report(GOOD))).toEqual([]);
  });

  it("refuses any failed item", () => {
    expect(check(report([...GOOD, row(7, "fail")])).join(" ")).toContain("7");
  });

  it("refuses an inconclusive item and a pending look", () => {
    expect(check(report([...GOOD, row(8, "inconclusive")])).length).toBeGreaterThan(0);
    expect(
      check(report([...GOOD, row(12, "inconclusive (look pending)", "auto+look")])).join(" "),
    ).toContain("12");
  });

  it("refuses a dirty tree", () => {
    expect(check(report(GOOD, { gitClean: false })).join(" ")).toMatch(/dirty/);
  });

  it("refuses a stale run, when a product file changed since", () => {
    const reasons = check(report(GOOD), {
      currentHead: NEWER,
      changedFiles: ["packages/plugin/src/main.ts"],
    });
    expect(reasons.join(" ")).toMatch(/stale|changed/);
  });

  it("accepts a newer HEAD when only planning files changed", () => {
    expect(
      check(report(GOOD), { currentHead: NEWER, changedFiles: [".planning/STATE.md"] }),
    ).toEqual([]);
  });

  it("refuses when the changed files cannot be listed for a newer HEAD", () => {
    expect(check(report(GOOD), { currentHead: NEWER, changedFiles: null }).length).toBeGreaterThan(
      0,
    );
  });

  it("refuses an already ratified report", () => {
    const ratified = report(GOOD).replace("ratified: pending", "ratified: ok (2026-10-12)");
    expect(check(ratified).join(" ")).toMatch(/already ratified/);
  });

  it("refuses a report whose front matter lacks a field", () => {
    const broken = report(GOOD).replace(/^git-head: .*$/m, "");
    expect(check(broken).join(" ")).toMatch(/git-head/);
  });

  it("refuses a run id that is not the requested one", () => {
    expect(check(report(GOOD), { runId: "deadbeef" }).join(" ")).toMatch(/run id/);
  });

  it("refuses a report without an item mapping or with a version mismatch", () => {
    const unmapped = report(GOOD).replace(
      "ratified: pending",
      "item-mapping: unavailable\nratified: pending",
    );
    expect(check(unmapped).join(" ")).toMatch(/mapping/);
    const drift = report(GOOD).replace(
      "ratified: pending",
      "version-mismatch: not-observed\nratified: pending",
    );
    expect(check(drift).join(" ")).toMatch(/version/);
  });

  it("refuses a report with no passed automated item", () => {
    expect(check(report([OWNER])).length).toBeGreaterThan(0);
  });
});

describe("ratifyReport (Test 5)", () => {
  const input = {
    runId: "0123abcd",
    statement: "Owner ratifies run 0123abcd",
    date: "2026-10-12",
    currentHead: HEAD,
    changedFiles: [] as string[],
  };

  it("writes the statement and the date into the front matter and nothing else", () => {
    const before = report(GOOD);
    const result = ratifyReport(before, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = before.split("\n");
    const b = result.text.split("\n");
    expect(b.length).toBe(a.length);
    const changed = a.flatMap((line, index) => (line === b[index] ? [] : [index]));
    expect(changed).toHaveLength(1);
    expect(b[changed[0] as number]).toBe("ratified: Owner ratifies run 0123abcd (2026-10-12)");
  });

  it("returns the reasons and no text when the run is not ratifiable", () => {
    const result = ratifyReport(report([...GOOD, row(7, "fail")]), input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("refuses an empty or multi-line statement", () => {
    expect(() => ratifyReport(report(GOOD), { ...input, statement: "" })).toThrow();
    expect(() => ratifyReport(report(GOOD), { ...input, statement: "a\nb" })).toThrow();
  });
});
