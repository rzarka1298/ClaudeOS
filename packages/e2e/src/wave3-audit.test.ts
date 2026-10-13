import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyRatification } from "./apply-ratification.js";
import { LOOK_PENDING_FILE, listPending } from "./look.js";
import { checkRatifiable } from "./ratify.js";
import { renderReport } from "./report.js";
import { parseReport } from "./report-io.js";

const RUN = "0a1b2c3d";
const HEAD = "a".repeat(40);

function item(n: number, run: string, extra: string[], results: string[]): string[] {
  const id = String(n).padStart(2, "0");
  return [
    `### ${n}. Item ${n}`,
    `run: ${run}`,
    ...(run === "owner"
      ? ["owner-why: banner-click"]
      : ["via: dom", `spec: packages/e2e/specs/a.e2e.ts::[06-UAT#${id}]`]),
    ...extra,
    "expected: |",
    "  x",
    ...results,
    "",
  ];
}

function wrap(body: string[]): string {
  return ["---", "status: testing", "phase: 06-demo", "---", "", "## Tests", "", ...body].join("\n");
}

function unchangedOrRefused(text: string): void {
  let out = text;
  try {
    out = applyRatification(text, RUN).text;
  } catch {
    return;
  }
  expect(out).toBe(text);
}

describe("wave 3 audit: Q1 result write", () => {
  it("never writes an owner item even if it carries a matching auto-result", () => {
    unchangedOrRefused(
      wrap(item(1, "owner", [`auto-result: pass @ ${RUN} 2026-10-11`], ["result: [pending]"])),
    );
  });

  it("leaves an item with two result lines untouched", () => {
    unchangedOrRefused(
      wrap(
        item(
          1,
          "auto",
          [`auto-result: pass @ ${RUN} 2026-10-11`],
          ["result: [pending]", "result: [pending]"],
        ),
      ),
    );
  });
});

describe("wave 3 audit: ratify unknown status", () => {
  it("refuses an automated row whose status is not a recognised word", () => {
    const mk = (n: number) => ({
      number: n,
      title: `T${n}`,
      runClass: "auto" as const,
      resolution: { kind: "status" as const, item: n, status: "pass" as const, reason: "r", message: "" },
    });
    const rendered = renderReport({
      runId: "0123abcd",
      profile: "standard",
      startedAt: "2026-10-11T10:00:00.000Z",
      finishedAt: "2026-10-11T10:05:00.000Z",
      appVersion: "1",
      installerVersion: "1",
      gitHead: HEAD,
      gitClean: true,
      buildHash: "0123456789ab",
      phasePrefix: "06",
      rows: [mk(1), mk(5)],
    });
    const lines = rendered.split("\n");
    const idx = lines.findIndex((l) => /\b5\b/.test(l) && l.includes("pass"));
    expect(idx).toBeGreaterThan(-1);
    lines[idx] = (lines[idx] as string).replace("pass", "passed-ish");
    const reasons = checkRatifiable({
      report: parseReport(lines.join("\n")),
      runId: "0123abcd",
      currentHead: HEAD,
      changedFiles: [],
      currentClean: true,
    });
    expect(reasons.join(" ")).toMatch(/5/);
  });
});

describe("wave 3 audit: look state integrity", () => {
  it("rejects a look-pending record whose count differs from its labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "w3a-"));
    writeFileSync(
      join(dir, LOOK_PENDING_FILE),
      JSON.stringify({
        runId: "0123abcd",
        reportPath: null,
        items: [{ item: 1, labels: ["a"], count: 5 }],
      }),
    );
    expect(() => listPending(dir)).toThrow();
  });
});
