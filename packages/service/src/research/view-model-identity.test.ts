import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_JOB_ID, type RunId } from "@ccc/domain";
import { finishJobRun, startJobRun } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReportVault, type ReportVault, testRunId } from "./test-support/report-vault.js";
import { buildReportItemsPage, buildReportList, findReport } from "./view-model.js";

/**
 * Wave 5 fix round (opus m2, Codex 4): a report is identified by its note id and tied to its file
 * name, and its run record is looked up directly.
 */

let vault: ReportVault;
beforeEach(() => {
  vault = createReportVault();
});
afterEach(() => vault.cleanup());

const OUTPUT = "global/output";

function reportFileOf(path: string): string {
  return join(vault.root, path);
}

describe("two files that claim one note id", () => {
  it("answers unreadable instead of choosing one", () => {
    const real = vault.addReport({ generatedAt: "2026-10-14T10:00:00.000Z" });
    const planted = vault.addReport({ generatedAt: "2026-10-15T10:00:00.000Z" });
    // The planted file is well formed and named for its own content; only its id is the real one's.
    const plantedFile = reportFileOf(planted.path);
    const text = readFileSync(plantedFile, "utf8");
    writeFileSync(plantedFile, text.replace(planted.noteId, real.noteId));
    expect(findReport(vault.root, real.noteId).kind).toBe("unreadable");
  });

  it("answers unreadable when the planted file is invalid but carries the id line", () => {
    const real = vault.addReport({ generatedAt: "2026-10-14T10:00:00.000Z" });
    const planted = vault.addReport({ generatedAt: "2026-10-15T10:00:00.000Z" });
    const plantedFile = reportFileOf(planted.path);
    const text = readFileSync(plantedFile, "utf8");
    writeFileSync(
      plantedFile,
      text.replace(planted.noteId, real.noteId).replace(/^type: .*$/m, "type: nope"),
    );
    expect(findReport(vault.root, real.noteId).kind).toBe("unreadable");
  });

  it("still finds a report whose id is unique", () => {
    const real = vault.addReport({ generatedAt: "2026-10-14T10:00:00.000Z" });
    vault.addReport({ generatedAt: "2026-10-15T10:00:00.000Z" });
    expect(findReport(vault.root, real.noteId).kind).toBe("found");
  });
});

describe("a file name that does not match what the file says", () => {
  it("lists and serves a report under another run id's name as unreadable", () => {
    const real = vault.addReport({ generatedAt: "2026-10-14T10:00:00.000Z" });
    const otherName = `research-2026-10-14-${testRunId()}.md`;
    renameSync(reportFileOf(real.path), join(vault.root, OUTPUT, otherName));
    expect(findReport(vault.root, real.noteId).kind).toBe("unreadable");
    const list = buildReportList(vault.root, {});
    if (!list.ok) throw new Error("list refused");
    expect(list.value.rows).toEqual([
      { readable: false, fileName: otherName, notePath: `${OUTPUT}/${otherName}` },
    ]);
  });

  it("lists and serves a report under another day's name as unreadable", () => {
    const real = vault.addReport({ generatedAt: "2026-10-14T10:00:00.000Z" });
    const otherName = `research-2026-10-13-${real.runId}.md`;
    renameSync(reportFileOf(real.path), join(vault.root, OUTPUT, otherName));
    expect(findReport(vault.root, real.noteId).kind).toBe("unreadable");
  });
});

describe("the run record of an old report", () => {
  it("is found however many runs came after it", () => {
    const real = vault.addReport({ generatedAt: "2026-10-14T10:00:00.000Z" });
    const at = (n: number): string =>
      new Date(Date.UTC(2026, 9, 14, 11, 0, 0) + n * 1000).toISOString();
    // The report's own run is registered with the report (it started at 09:59:00 and ended at
    // 10:00:30), then more runs than any bounded history window holds come after it.
    for (let n = 0; n < 210; n += 1) {
      const id = testRunId() as RunId;
      startJobRun(vault.store.db, {
        jobRunId: id,
        jobKey: RESEARCH_JOB_ID,
        idempotencyKey: `${RESEARCH_JOB_ID}:manual:${id}`,
        trigger: "manual",
        startedAt: at(n),
      });
      finishJobRun(vault.store.db, id, {
        outcome: "failure",
        endedAt: at(n),
        sourceCount: 0,
        sourceTotal: 1,
        reportNoteId: null,
        unavailableSources: [],
        errorCode: "all-sources-failed",
      });
    }
    const found = findReport(vault.root, real.noteId);
    if (found.kind !== "found") throw new Error("expected the report");
    const page = buildReportItemsPage(vault.root, vault.store.db, found.entry);
    if (!page.ok) throw new Error("items refused");
    expect(page.value.header).toMatchObject({
      runStartedAt: "2026-10-14T09:59:00.000Z",
      runEndedAt: "2026-10-14T10:00:30.000Z",
      runOutcome: "success",
    });
  });
});
