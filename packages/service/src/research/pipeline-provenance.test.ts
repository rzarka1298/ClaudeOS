import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_JOB_ID, ResearchReportItemsPageSchema, type RunId } from "@ccc/domain";
import {
  finishJobRun,
  getResearchReportRecord,
  getResearchSourceRecord,
  listJobRuns,
} from "@ccc/operational-store";
import { readReportNote } from "@ccc/vault-repo";
import { afterEach, describe, expect, it } from "vitest";
import { sourceIdFor } from "./hash.js";
import { type PreparedSource, sourceRecordFor } from "./pipeline.js";
import { reportContentDigest } from "./report-digest.js";
import {
  createKit,
  defaultResponses,
  type Kit,
  THREE,
  URL_ONE,
  URL_THREE,
  URL_TWO,
} from "./test-support/research-kit.js";
import { buildReportItemsPage, findReport } from "./view-model.js";

/**
 * 07-FIX6 (decision D-A, ADR-0030): the pipeline records, in the operational store, each source
 * whose raw note it wrote and read back, and nothing else. The reader's "verified" rests on that
 * row, so a source that failed any stage before the read-back must have none.
 */

let kit: Kit | undefined;
afterEach(() => {
  kit?.close();
  kit = undefined;
});

async function runToEnd(k: Kit): Promise<string> {
  const started = k.services.runNow();
  if (!started.ok) throw new Error(`refused: ${started.code}`);
  await k.services.idle();
  return started.value.runId;
}

function rawFileFor(k: Kit, url: string): string {
  const id = sourceIdFor(url);
  const name = readdirSync(join(k.vaultRoot, "global/raw")).find((n) => n.startsWith(`${id}.`));
  if (name === undefined) throw new Error("raw note missing");
  return join(k.vaultRoot, "global/raw", name);
}

function recordsOf(k: Kit, runId: string): string[] {
  return [URL_ONE, URL_TWO, URL_THREE].filter(
    (url) => getResearchSourceRecord(k.store.db, runId, sourceIdFor(url)) !== null,
  );
}

describe("the pipeline records each source it wrote and read back", () => {
  it("leaves one record per source with the hash, address, path and label the report cites", async () => {
    kit = createKit();
    const runId = await runToEnd(kit);
    expect(recordsOf(kit, runId)).toEqual([URL_ONE, URL_TWO, URL_THREE]);
    const reports = readdirSync(join(kit.vaultRoot, "global/output")).filter((n) =>
      n.startsWith("research-"),
    );
    const read = readReportNote(kit.vaultRoot, `global/output/${reports[0]}`);
    if (!read.readable) throw new Error("report must be readable");
    for (const ref of read.frontmatter.sourceRefs) {
      const record = getResearchSourceRecord(kit.store.db, runId, ref.id);
      expect(record).toMatchObject({
        jobRunId: runId,
        sourceId: ref.id,
        canonicalUrl: ref.canonicalUrl,
        contentHash: ref.contentHash,
        snapshotPath: ref.snapshotPath,
        label: ref.title,
      });
    }
  });

  it("serves a real run's quotes as evidence, end to end", async () => {
    kit = createKit();
    await runToEnd(kit);
    const reports = readdirSync(join(kit.vaultRoot, "global/output")).filter((n) =>
      n.startsWith("research-"),
    );
    const read = readReportNote(kit.vaultRoot, `global/output/${reports[0]}`);
    if (!read.readable) throw new Error("report must be readable");
    const quoted = read.frontmatter.items.filter((item) => item.quote !== undefined);
    expect(quoted.length).toBeGreaterThan(0);
    const found = findReport(kit.vaultRoot, read.frontmatter.id);
    if (found.kind !== "found") throw new Error("expected the report");
    const page = buildReportItemsPage(kit.vaultRoot, kit.store.db, found.entry);
    if (!page.ok) throw new Error("refused");
    const served = ResearchReportItemsPageSchema.parse(page.value).items;
    expect(served.filter((item) => item.quote !== null)).toHaveLength(quoted.length);
    expect(served.some((item) => item.quoteUnverified === true)).toBe(false);
  });

  it("records no row for a source that failed to fetch", async () => {
    kit = createKit({
      responses: { ...defaultResponses(), [URL_TWO]: { ok: false, code: "timeout" } },
    });
    const runId = await runToEnd(kit);
    expect(recordsOf(kit, runId)).toEqual([URL_ONE, URL_THREE]);
  });

  it("records no row for a source whose stored raw note was edited, and records the others", async () => {
    kit = createKit();
    await runToEnd(kit);
    const target = rawFileFor(kit, URL_ONE);
    writeFileSync(target, readFileSync(target, "utf8").replace("twice as fast", "twice as slow"));
    const second = await runToEnd(kit);
    expect(recordsOf(kit, second)).toEqual([URL_TWO, URL_THREE]);
  });

  it("records nothing when every source fails", async () => {
    kit = createKit({
      responses: {
        [URL_ONE]: { ok: false, code: "timeout" },
        [URL_TWO]: { ok: false, code: "timeout" },
        [URL_THREE]: { ok: false, code: "timeout" },
      },
    });
    const runId = await runToEnd(kit);
    expect(recordsOf(kit, runId)).toEqual([]);
    expect(kit.store.db.prepare("SELECT COUNT(*) AS n FROM research_source_records").get()).toEqual(
      { n: 0 },
    );
  });

  it("records a reused, unchanged raw note again for the new run", async () => {
    kit = createKit();
    const first = await runToEnd(kit);
    const second = await runToEnd(kit);
    expect(second).not.toBe(first);
    expect(recordsOf(kit, first)).toEqual([URL_ONE, URL_TWO, URL_THREE]);
    expect(recordsOf(kit, second)).toEqual([URL_ONE, URL_TWO, URL_THREE]);
  });
});

function reportNames(k: Kit): string[] {
  return readdirSync(join(k.vaultRoot, "global/output")).filter((n) => n.startsWith("research-"));
}

function rowCount(k: Kit, table: "research_source_records" | "research_report_records"): number {
  return (k.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function lastRun(k: Kit) {
  const row = listJobRuns(k.store.db, RESEARCH_JOB_ID, 1)[0];
  if (row === undefined) throw new Error("no job run");
  return row;
}

describe("07-FIX6b: the pipeline records the report it finalised", () => {
  it("leaves one report record per run: the report's note id and the digest of the report as parsed from the vault", async () => {
    kit = createKit();
    const runId = await runToEnd(kit);
    const name = reportNames(kit)[0];
    const read = readReportNote(kit.vaultRoot, `global/output/${name}`);
    if (!read.readable) throw new Error("report must be readable");
    const record = getResearchReportRecord(kit.store.db, runId);
    expect(record).not.toBeNull();
    expect(record?.reportNoteId).toBe(read.frontmatter.id);
    expect(record?.contentDigest).toBe(reportContentDigest(read.frontmatter));
    expect(read.frontmatter.stage).toBe("output");
    expect(rowCount(kit, "research_report_records")).toBe(1);
  });

  it("records each run's own report", async () => {
    kit = createKit();
    const first = await runToEnd(kit);
    const second = await runToEnd(kit);
    const a = getResearchReportRecord(kit.store.db, first);
    const b = getResearchReportRecord(kit.store.db, second);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.reportNoteId).not.toBe(b?.reportNoteId);
  });

  it("records nothing for a run that published no report", async () => {
    kit = createKit({
      responses: {
        [URL_ONE]: { ok: false, code: "timeout" },
        [URL_TWO]: { ok: false, code: "timeout" },
        [URL_THREE]: { ok: false, code: "timeout" },
      },
    });
    await runToEnd(kit);
    expect(rowCount(kit, "research_report_records")).toBe(0);
  });

  it("takes the record back with the report when the output stage cannot be logged", async () => {
    kit = createKit();
    kit.store.db.exec(
      `CREATE TRIGGER fail_output BEFORE UPDATE OF stage_log ON job_runs
       WHEN NEW.stage_log LIKE '%"output"%'
       BEGIN SELECT RAISE(ABORT, 'store down'); END;`,
    );
    const runId = await runToEnd(kit);
    expect(lastRun(kit).outcome).toBe("failure");
    expect(reportNames(kit)).toEqual([]);
    expect(getResearchReportRecord(kit.store.db, runId)).toBeNull();
    expect(rowCount(kit, "research_report_records")).toBe(0);
  });

  it("takes the record back with the report when the run cannot record its success", async () => {
    kit = createKit();
    kit.store.db.exec(
      `CREATE TRIGGER refuse_completed BEFORE UPDATE OF state ON job_runs
       WHEN NEW.state = 'completed'
       BEGIN SELECT RAISE(ABORT, 'store refuses'); END;`,
    );
    const runId = await runToEnd(kit);
    expect(lastRun(kit).state).toBe("failed");
    expect(reportNames(kit)).toEqual([]);
    expect(getResearchReportRecord(kit.store.db, runId)).toBeNull();
  });

  it("ends the run as vault-write-failed with nothing published when the report record cannot be written", async () => {
    kit = createKit({
      beforeServices: (db) => db.exec("DROP TABLE research_report_records"),
    });
    await runToEnd(kit);
    const row = lastRun(kit);
    expect(row.outcome).toBe("failure");
    expect(row.errorCode).toBe("vault-write-failed");
    expect(row.reportNoteId).toBeNull();
    expect(reportNames(kit)).toEqual([]);
  });

  it("serves a report edited in place after the run with its quotes withheld", async () => {
    kit = createKit();
    await runToEnd(kit);
    const name = reportNames(kit)[0] ?? "";
    const file = join(kit.vaultRoot, "global/output", name);
    const before = readFileSync(file, "utf8");
    const after = before.replace(/^sourceTotal: 3$/m, "sourceTotal: 4");
    expect(after).not.toBe(before);
    writeFileSync(file, after);
    const read = readReportNote(kit.vaultRoot, `global/output/${name}`);
    if (!read.readable) throw new Error("report must stay readable");
    const found = findReport(kit.vaultRoot, read.frontmatter.id);
    if (found.kind !== "found") throw new Error("expected the report");
    const page = buildReportItemsPage(kit.vaultRoot, kit.store.db, found.entry);
    if (!page.ok) throw new Error("refused");
    const served = ResearchReportItemsPageSchema.parse(page.value).items;
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((item) => item.quote === null)).toBe(true);
    expect(served.some((item) => item.quoteUnverified === true)).toBe(true);
  });
});

describe("07-FIX6b: a source that cannot be recorded fails alone", () => {
  it("builds no record for a source without an https address", () => {
    const source = {
      sourceId: "a".repeat(32),
      ref: {
        sourceType: "feed-entry",
        id: "a".repeat(32),
        title: "No address",
        author: null,
        publishedAt: null,
        retrievedAt: "2026-10-15T09:00:00.000Z",
        contentHash: "b".repeat(64),
        snapshotPath: `global/raw/${"a".repeat(32)}.bbbbbbbb.md`,
        accessClass: "public",
      },
    } as unknown as Pick<PreparedSource, "sourceId" | "ref">;
    expect(sourceRecordFor(source, "r".repeat(25), "2026-10-15T09:00:00.000Z")).toBeNull();
  });

  it("refuses ONE source whose record conflicts with the one already made, and the run goes on", async () => {
    // The same address under two labels is one source id with two different records.
    kit = createKit({
      sources: [
        { label: "Alpha releases", url: URL_ONE, kind: "feed" },
        { label: "Alpha again", url: URL_ONE, kind: "feed" },
        { label: "Beta releases", url: URL_TWO, kind: "feed" },
      ],
    });
    const runId = await runToEnd(kit);
    const row = lastRun(kit);
    expect(row.state).toBe("completed");
    expect(row.outcome).toBe("partial");
    expect(row.errorCode).toBeNull();
    expect(getResearchSourceRecord(kit.store.db, runId, sourceIdFor(URL_ONE))?.label).toBe(
      "Alpha releases",
    );
    expect(getResearchSourceRecord(kit.store.db, runId, sourceIdFor(URL_TWO))).not.toBeNull();
    expect(reportNames(kit)).toHaveLength(1);
  });
});

describe("07-FIX6b: a run that has ended cannot take a source record, and the pipeline stops cleanly", () => {
  it("stops without a record, a report or a throw when the run was ended under it", async () => {
    let live: Kit | undefined;
    let ended = false;
    kit = createKit({
      sources: [...THREE],
      onEffect: (operation) => {
        if (operation !== "research.write-notes" || ended || live === undefined) return;
        ended = true;
        const row = listJobRuns(live.store.db, RESEARCH_JOB_ID, 1)[0];
        if (row === undefined) throw new Error("no job run");
        finishJobRun(live.store.db, row.jobRunId as RunId, {
          outcome: "failure",
          endedAt: "2026-10-15T09:00:01.000Z",
          sourceCount: 0,
          sourceTotal: 3,
          reportNoteId: null,
          unavailableSources: [],
          errorCode: "interrupted",
        });
      },
    });
    live = kit;
    await runToEnd(kit);
    expect(ended).toBe(true);
    expect(rowCount(kit, "research_source_records")).toBe(0);
    expect(rowCount(kit, "research_report_records")).toBe(0);
    expect(reportNames(kit)).toEqual([]);
    expect(lastRun(kit).outcome).toBe("failure");
  });
});

describe("07-FIX6b: a store fault while recording a source ends the run as a vault write failure", () => {
  it("fails the run with vault-write-failed and publishes nothing", async () => {
    kit = createKit({
      beforeServices: (db) => db.exec("DROP TABLE research_source_records"),
    });
    await runToEnd(kit);
    const row = lastRun(kit);
    expect(row.outcome).toBe("failure");
    expect(row.errorCode).toBe("vault-write-failed");
    expect(row.reportNoteId).toBeNull();
    expect(reportNames(kit)).toEqual([]);
  });
});
