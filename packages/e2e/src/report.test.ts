import { beforeAll, describe, expect, it } from "vitest";
import { type ReportInput, type ReportRow, renderReport, resolveReportPath } from "./report.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const ROWS: ReportRow[] = [
  {
    number: 1,
    title: "Banner look",
    runClass: "auto+look",
    resolution: {
      kind: "status",
      item: 1,
      status: "inconclusive (look pending)",
      reason: "tests passed; no look verdict yet",
      message: "",
    },
  },
  {
    number: 2,
    title: "Click the banner",
    runClass: "owner",
    resolution: {
      kind: "owner",
      item: 2,
      partials: [
        {
          title: "[06-UAT#02] handler opens approvals",
          state: "passed",
          durationMs: 40,
          message: "",
        },
        {
          title: "[06-UAT#02] focus on deny",
          state: "failed",
          durationMs: 9,
          message: "expected 1 to equal 2",
        },
      ],
    },
  },
  {
    number: 5,
    title: "Reload twice | stale banner",
    runClass: "auto",
    resolution: {
      kind: "status",
      item: 5,
      status: "fail",
      reason: "1 test failed",
      message: `expected 3 to equal 4 ![shot](data:image/png;base64,AAAAAAAA) ${"x ".repeat(400)}`,
    },
  },
  {
    number: 21,
    title: "Ten thousand tasks",
    runClass: "auto",
    resolution: {
      kind: "status",
      item: 21,
      status: "skipped-profile",
      reason: "runs only in the full profile",
      message: "",
    },
  },
  {
    number: 6,
    title: "Request pane",
    runClass: "auto",
    resolution: {
      kind: "status",
      item: 6,
      status: "pass",
      reason: "all tests passed",
      message: "",
    },
  },
];

const INPUT: ReportInput = {
  runId: "0a1b2c3d",
  profile: "standard",
  startedAt: "2026-10-11T10:00:00Z",
  finishedAt: "2026-10-11T10:12:30Z",
  appVersion: "1.14.4",
  installerVersion: "1.12.7",
  gitHead: HEAD,
  gitClean: true,
  buildHash: "abcdef012345",
  phasePrefix: "06",
  rows: ROWS,
};

describe("renderReport (Test 6)", () => {
  let text = "";
  beforeAll(() => {
    text = renderReport(INPUT);
  });

  it("opens with front matter holding the run facts and the unratified marker", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    for (const line of [
      "run-id: 0a1b2c3d",
      "profile: standard",
      "started: 2026-10-11T10:00:00Z",
      "finished: 2026-10-11T10:12:30Z",
      "app-version: 1.14.4",
      "installer-version: 1.12.7",
      `git-head: ${HEAD}`,
      "git-clean: true",
      "ratified: pending",
    ]) {
      expect(front.split("\n"), line).toContain(line);
    }
    expect(front).toMatch(/^build-hash: [0-9a-f]{12}$/m);
  });

  it("has one table row per item with its class and status", () => {
    const rows = text.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    expect(rows).toHaveLength(ROWS.length);
    expect(rows[0]).toContain("auto+look");
    expect(rows[0]).toContain("inconclusive (look pending)");
    expect(text).toMatch(/^\| 5 \| .*\| auto \| fail \|/m);
    expect(text).toMatch(/^\| 21 \| .*\| skipped-profile \|/m);
  });

  it("lists owner partials in their own section, not in the item table", () => {
    const [table, partials] = text.split(/^## Owner partials$/m);
    expect(partials).toContain("[06-UAT#02] handler opens approvals");
    expect(partials).toContain("passed");
    expect(partials).toContain("expected 1 to equal 2");
    expect(table).not.toContain("handler opens approvals");
    expect(text).toMatch(/^\| 2 \| .*\| owner \| owner \|/m);
  });

  it("keeps a pipe in a title from breaking the table", () => {
    expect(text).toContain("Reload twice \\| stale banner");
  });

  it("holds no image reference, no data URL and no pending auto-result", () => {
    expect(text).not.toMatch(/!\[/);
    expect(text).not.toMatch(/data:[a-z]+\/[a-z0-9.+-]+/i);
    expect(text).not.toMatch(/<img/i);
    expect(text).not.toMatch(/auto-result:[^\n]*pending/i);
    expect(text).not.toMatch(/\[pending\]/i);
  });

  it("truncates a long message", () => {
    const row = text.split("\n").find((line) => line.startsWith("| 5 |")) ?? "";
    expect(row.length).toBeLessThan(500);
  });

  it("is byte-identical on a second render of the same input", () => {
    expect(renderReport({ ...INPUT })).toBe(text);
  });

  it("states the counts of the automated outcomes", () => {
    expect(text).toMatch(/^- auto-passed: 1$/m);
    expect(text).toMatch(/^- auto-failed: 1$/m);
    expect(text).toMatch(/^- owner-pending: 1$/m);
  });

  it("refuses a build hash that is not twelve hex characters", () => {
    expect(() => renderReport({ ...INPUT, buildHash: "abc" })).toThrowError(
      "The report needs a twelve-character hexadecimal build hash.",
    );
    expect(() => renderReport({ ...INPUT, buildHash: "ABCDEF012345" })).toThrowError(
      "The report needs a twelve-character hexadecimal build hash.",
    );
  });

  it("refuses a run id that is not eight hex characters", () => {
    expect(() => renderReport({ ...INPUT, runId: "nope" })).toThrowError(
      "The report needs an eight-character hexadecimal run id.",
    );
  });
});

describe("renderReport sanitising (Task 2, Test 7)", () => {
  const home = ["", "Users", "dana"].join("/");
  const email = ["dana", "corp.io"].join("@");
  const hex = "ab12".repeat(12);

  it("removes a home path, an email and a long hex string from every message", () => {
    const text = renderReport({
      ...INPUT,
      homeDir: home,
      rows: [
        {
          number: 5,
          title: `Probe in ${home}/notes`,
          runClass: "auto",
          resolution: {
            kind: "status",
            item: 5,
            status: "fail",
            reason: "1 test failed",
            message: `opened ${home}/vault/x.md for ${email} with ${hex}`,
          },
        },
        {
          number: 2,
          title: "Owner",
          runClass: "owner",
          resolution: {
            kind: "owner",
            item: 2,
            partials: [
              {
                title: "[06-UAT#02] partial",
                state: "failed",
                durationMs: 3,
                message: `saw ${email} at ${home}/x`,
              },
            ],
          },
        },
      ],
    });
    expect(text).not.toContain(home);
    expect(text).not.toContain(email);
    expect(text).not.toContain(hex);
    expect(text).toContain("/Users/USERNAME/vault/x.md");
    expect(text).toContain("[email]");
    expect(text).toContain("[hash]");
  });
});

describe("resolveReportPath", () => {
  it("puts the report in the phase folder named by the prefix", () => {
    expect(resolveReportPath({ phaseDir: "/repo/.planning/phases/06-x", phasePrefix: "06" })).toBe(
      "/repo/.planning/phases/06-x/06-UAT-AUTO-REPORT.md",
    );
  });

  it("prefers an explicit --out path", () => {
    expect(
      resolveReportPath({
        phaseDir: "/repo/.planning/phases/06-x",
        phasePrefix: "06",
        out: "/tmp/report.md",
      }),
    ).toBe("/tmp/report.md");
  });

  it("returns null (stdout) when neither a phase folder nor --out exists", () => {
    expect(resolveReportPath({ phasePrefix: "06" })).toBeNull();
    expect(
      resolveReportPath({ phaseDir: undefined, phasePrefix: "06", out: undefined }),
    ).toBeNull();
  });
});
