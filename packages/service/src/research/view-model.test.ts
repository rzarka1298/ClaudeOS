import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_JOB_ID,
  RESEARCH_LIST_PAGE_SIZE,
  type ResearchListResponse,
  ResearchListResponseSchema,
  type ResearchReportItem,
  ResearchReportItemsPageSchema,
  ResearchReportSourcesPageSchema,
  ResearchStatusResponseSchema,
  type RunId,
} from "@ccc/domain";
import { appendJobRunStage, finishJobRun, startJobRun } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWorstCaseReport,
  createReportVault,
  type ReportVault,
  THREE_BYTE_CHARACTER,
  testRunId,
} from "./test-support/report-vault.js";
import {
  buildReportItemsPage,
  buildReportList,
  buildReportSourcesPage,
  buildResearchStatus,
  findReport,
  RESEARCH_RESPONSE_BUDGET_BYTES,
} from "./view-model.js";

/**
 * Plan 07-14 Task 2 (D-23, UI-SPEC "View-model requirements", research Pitfall 11, T-07-07):
 * the view models are built from validated frontmatter and the job-run store, paged, and never
 * larger than the response budget; an unreadable report is listed by file name and never served.
 */

let vault: ReportVault;

beforeEach(() => {
  vault = createReportVault();
});
afterEach(() => vault.cleanup());

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const CJK = THREE_BYTE_CHARACTER;

function list(cursor?: string, limit?: number): ResearchListResponse {
  const result = buildReportList(vault.root, {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (!result.ok) throw new Error(`list refused: ${result.code}`);
  return ResearchListResponseSchema.parse(result.value);
}

describe("Test 1 (budget): pages never reach the response budget and drop whole items", () => {
  it("keeps every items page of a worst-case report under 57,344 bytes and covers all 25 items", () => {
    expect(RESEARCH_RESPONSE_BUDGET_BYTES).toBe(57344);
    const lookup = findReport(vault.root, addWorstCaseReport(vault, 25).noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const seen: ResearchReportItem[] = [];
    let cursor: string | undefined;
    let truncatedPages = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = buildReportItemsPage(vault.root, vault.store.db, lookup.entry, cursor);
      if (!result.ok) throw new Error(`page refused: ${result.code}`);
      const parsed = ResearchReportItemsPageSchema.parse(result.value);
      expect(parsed.items.length).toBeLessThanOrEqual(10);
      expect(bytes(parsed)).toBeLessThan(57344);
      if (parsed.truncated) truncatedPages += 1;
      seen.push(...parsed.items);
      if (parsed.nextCursor === null) break;
      cursor = parsed.nextCursor;
    }
    // Whole items were dropped from a page, and the next cursor covered them.
    expect(truncatedPages).toBeGreaterThan(0);
    expect(seen.map((item) => item.index)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("does not mark a page truncated when everything fit", () => {
    const built = vault.addReport();
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const result = buildReportItemsPage(vault.root, vault.store.db, lookup.entry);
    if (!result.ok) throw new Error("refused");
    expect(result.value.truncated).toBe(false);
    expect(result.value.nextCursor).toBeNull();
  });

  it("refuses an items cursor that does not decode to an offset inside the report", () => {
    const built = vault.addReport();
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    for (const cursor of ["abc", "AAAA", "ZZZZZZ", "x".repeat(200), "-_-_"]) {
      const result = buildReportItemsPage(vault.root, vault.store.db, lookup.entry, cursor);
      expect(result, cursor).toEqual({ ok: false, code: "invalid-cursor" });
    }
  });

  it("pages the sources page under the budget too", () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({
      url: `https://s${index}.example.invalid/feed.atom`,
      title: CJK.repeat(200),
      author: CJK.repeat(200),
      text: "The maintainers confirmed that the alpha parser is now twice as fast in this release.",
    }));
    const built = vault.addReport({ sources });
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const numbers: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page += 1) {
      const result = buildReportSourcesPage(vault.root, vault.store.db, lookup.entry, cursor);
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      const parsed = ResearchReportSourcesPageSchema.parse(result.value);
      expect(bytes(parsed)).toBeLessThan(57344);
      numbers.push(...parsed.sources.map((source) => source.number));
      if (parsed.nextCursor === null) break;
      cursor = parsed.nextCursor;
    }
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

describe("Test 2 (list): newest first, paged, unreadable rows by file name", () => {
  function day(offset: number): string {
    const date = new Date(Date.UTC(2026, 8, 1 + offset, 10, 0, 0));
    return date.toISOString();
  }

  it("lists reports newest first in pages of 25 with an opaque cursor", () => {
    const ids: string[] = [];
    for (let at = 0; at < 30; at += 1) {
      ids.push(vault.addReport({ generatedAt: day(at) }).noteId);
    }
    const first = list();
    expect(first.rows).toHaveLength(RESEARCH_LIST_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const second = list(first.nextCursor ?? undefined);
    expect(second.rows).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const order = [...first.rows, ...second.rows].map((row) =>
      row.readable ? row.noteId : "unreadable",
    );
    expect(order).toEqual([...ids].reverse());
  });

  it("orders two reports of one day by their generation instant", () => {
    const early = vault.addReport({ generatedAt: "2026-10-14T08:00:00.000Z" });
    const late = vault.addReport({ generatedAt: "2026-10-14T20:00:00.000Z" });
    const rows = list().rows.map((row) => (row.readable ? row.noteId : ""));
    expect(rows).toEqual([late.noteId, early.noteId]);
  });

  it("lists a report with invalid frontmatter as unreadable with its file name only", () => {
    const good = vault.addReport({ generatedAt: "2026-10-10T10:00:00.000Z" });
    const name = `research-2026-10-20-${testRunId()}.md`;
    writeFileSync(join(vault.root, "global", "output", name), "---\nnot: a report\n---\nbody\n");
    const rows = list().rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      readable: false,
      fileName: name,
      notePath: `global/output/${name}`,
    });
    expect(rows[1]?.readable && rows[1].noteId).toBe(good.noteId);
  });

  it("ignores a note in the folder that is not a report, and the folder index", () => {
    vault.addReport();
    writeFileSync(join(vault.root, "global", "output", "meeting-notes.md"), "# Notes\n");
    writeFileSync(join(vault.root, "global", "output", "research-notes.md"), "# Notes\n");
    expect(list().rows).toHaveLength(1);
  });

  it("does not list a report that was never finalised", () => {
    vault.addReport({ unfinalised: true });
    expect(list().rows).toEqual([]);
  });

  it("answers invalid-cursor for a cursor that does not decode to a list position", () => {
    vault.addReport();
    for (const cursor of ["abc", "AAAA", "e30", Buffer.from("[1]").toString("base64url")]) {
      expect(buildReportList(vault.root, { cursor }), cursor).toEqual({
        ok: false,
        code: "invalid-cursor",
      });
    }
  });

  it("fills a vault-relative notePath on every readable row", () => {
    vault.addReport();
    const row = list().rows[0];
    expect(row?.readable).toBe(true);
    if (row === undefined || !row.readable) return;
    expect(row.notePath).toMatch(/^global\/output\/research-[0-9-]+-[0-9a-z]{25}\.md$/);
    expect(row.notePath.startsWith("/")).toBe(false);
    expect(row.notePath.includes("..")).toBe(false);
  });

  it("lists nothing when the output folder is a link that leaves the vault", () => {
    const outside = join(homedir(), ".ccc-test", `outside-${testRunId()}`);
    mkdirSync(outside, { recursive: true });
    try {
      writeFileSync(join(outside, `research-2026-10-20-${testRunId()}.md`), "---\n---\n");
      const folder = join(vault.root, "global", "output");
      rmSync(folder, { recursive: true, force: true });
      symlinkSync(outside, folder);
      expect(list().rows).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("a report file that is a link leaving the vault (T-07-07)", () => {
  it("is listed as unreadable with its vault-relative path only, and is never found or served", () => {
    const built = vault.addReport({ generatedAt: "2026-10-10T10:00:00.000Z" });
    const outside = join(homedir(), ".ccc-test", `outside-${testRunId()}`);
    mkdirSync(outside, { recursive: true });
    try {
      const name = `research-2026-10-21-${testRunId()}.md`;
      writeFileSync(join(outside, name), readFileSync(join(vault.root, built.path), "utf8"));
      symlinkSync(join(outside, name), join(vault.root, "global", "output", name));
      const rows = list().rows;
      const linked = rows.find((row) => !row.readable);
      expect(linked).toEqual({
        readable: false,
        fileName: name,
        notePath: `global/output/${name}`,
      });
      expect(JSON.stringify(rows).includes(outside)).toBe(false);
      // The linked copy carries the same note id; it is not served (the real report is).
      const lookup = findReport(vault.root, built.noteId);
      expect(lookup.kind).toBe("found");
      if (lookup.kind === "found") expect(lookup.entry.name).not.toBe(name);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Test 3 (reader pages)", () => {
  it("carries the header fields and numbers citations by source order", () => {
    const built = vault.addReport({
      generatedAt: "2026-10-14T10:00:00.000Z",
      sources: [
        {
          url: "https://one.example.invalid/a",
          title: "First source",
          text: "The maintainers confirmed that the alpha parser is now twice as fast in this release.",
        },
        {
          url: "https://two.example.invalid/b",
          title: "Second source",
          text: "Version 1.9 fixes a crash when reading empty archives from the cache.",
        },
      ],
      items: [
        {
          kind: "source-fact",
          text: "The parser is faster.",
          quote: "the alpha parser is now twice as fast",
          cites: [0],
        },
        {
          kind: "unverified-claim",
          text: "A crash is fixed.",
          quote: "fixes a crash when reading empty archives",
          cites: [1],
        },
        { kind: "inference", text: "Both look like quality work.", cites: [1, 0] },
      ],
    });
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    // The run note exists in the vault, so the header names it vault-relative.
    mkdirSync(join(vault.root, "automation-runs"), { recursive: true });
    writeFileSync(join(vault.root, "automation-runs", `${built.runId}.md`), "# Run\n");
    const result = buildReportItemsPage(vault.root, vault.store.db, lookup.entry);
    if (!result.ok) throw new Error("refused");
    const page = ResearchReportItemsPageSchema.parse(result.value);
    expect(page.header.noteId).toBe(built.noteId);
    expect(page.header.notePath).toBe(built.path);
    expect(page.header.runNotePath).toBe(`automation-runs/${built.runId}.md`);
    // The report's run is recorded with the report (a genuine, finished run).
    expect(page.header.runOutcome).toBe("success");
    expect(page.header.kindCounts).toEqual({
      "source-fact": 1,
      "unverified-claim": 1,
      inference: 1,
    });
    expect(page.items[0]?.citations).toEqual([{ number: 1, title: "First source" }]);
    expect(page.items[0]?.quoteSourceNumber).toBe(1);
    expect(page.items[1]?.quoteSourceNumber).toBe(2);
    expect(page.items[2]?.citations.map((citation) => citation.number)).toEqual([1, 2]);
    expect(page.items[2]?.quote).toBeNull();
  });

  it("names no run note when the run note is missing", () => {
    const built = vault.addReport();
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const result = buildReportItemsPage(vault.root, vault.store.db, lookup.entry);
    if (!result.ok) throw new Error("refused");
    expect(result.value.header.runNotePath).toBeNull();
  });

  it("serves text and quotes as plain text, with no backslash escapes", () => {
    const built = vault.addReport({
      sources: [
        {
          url: "https://one.example.invalid/a",
          text: "Use the [x] flag and the *args option to keep the run_once setting stable.",
        },
      ],
      items: [
        {
          kind: "source-fact",
          text: "The *args option and [x] flag are kept_stable.",
          quote: "the [x] flag and the *args option to keep the run_once setting",
          cites: [0],
        },
      ],
    });
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const result = buildReportItemsPage(vault.root, vault.store.db, lookup.entry);
    if (!result.ok) throw new Error("refused");
    expect(result.value.items[0]?.text).toBe("The *args option and [x] flag are kept_stable.");
    expect(result.value.items[0]?.quote).toBe(
      "the [x] flag and the *args option to keep the run_once setting",
    );
    expect(JSON.stringify(result.value)).not.toContain("\\\\");
  });

  it("carries every reference field and the sanitise counts on the sources page", () => {
    const built = vault.addReport({
      sources: [
        {
          url: "https://one.example.invalid/a",
          title: "Only source",
          author: "A writer",
          text: "Some text that is long enough to keep.",
        },
      ],
      items: [],
    });
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const result = buildReportSourcesPage(vault.root, vault.store.db, lookup.entry);
    if (!result.ok) throw new Error("refused");
    const page = ResearchReportSourcesPageSchema.parse(result.value);
    const source = page.sources[0];
    expect(source?.number).toBe(1);
    expect(source?.title).toBe("Only source");
    expect(source?.author).toBe("A writer");
    expect(source?.canonicalUrl).toBe("https://one.example.invalid/a");
    expect(source?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(source?.snapshotPath).toBe(built.rawPaths[0]);
    expect(source?.counts).toEqual({
      scripts: 0,
      styles: 0,
      comments: 0,
      hiddenBlocks: 0,
      mediaDropped: 0,
      linksDropped: 0,
      controlChars: 0,
      commandLikeLines: 0,
    });
  });
});

describe("Test 4 (errors)", () => {
  it("answers missing for an unknown note id and for a report that was never finalised", () => {
    vault.addReport();
    expect(findReport(vault.root, "z".repeat(25)).kind).toBe("missing");
    const draft = vault.addReport({ unfinalised: true, generatedAt: "2026-10-12T10:00:00.000Z" });
    expect(findReport(vault.root, draft.noteId).kind).toBe("missing");
  });

  it("answers unreadable for a report that was edited into something invalid", () => {
    const built = vault.addReport();
    const path = join(vault.root, built.path);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("type: report", "type: invalid-type"));
    expect(findReport(vault.root, built.noteId).kind).toBe("unreadable");
  });

  it("puts no absolute path in any response", () => {
    const built = vault.addReport();
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const responses = [
      buildReportList(vault.root, {}),
      buildReportItemsPage(vault.root, vault.store.db, lookup.entry),
      buildReportSourcesPage(vault.root, vault.store.db, lookup.entry),
      { ok: true, value: buildResearchStatus(vault.store.db, null) },
    ];
    const text = JSON.stringify(responses);
    expect(text.includes(vault.root)).toBe(false);
    expect(text.includes(homedir())).toBe(false);
  });
});

describe("Test 5 (status)", () => {
  const T = (n: number): string => `2026-10-14T10:0${n}:00.000Z`;

  function finishedRun(
    outcome: "success" | "partial" | "failure",
    start: string,
    end: string,
    extra: { reportNoteId?: string | null } = {},
  ): RunId {
    const runId = testRunId() as RunId;
    startJobRun(vault.store.db, {
      jobRunId: runId,
      jobKey: RESEARCH_JOB_ID,
      idempotencyKey: `${RESEARCH_JOB_ID}:manual:${runId}`,
      trigger: "manual",
      startedAt: start,
    });
    finishJobRun(vault.store.db, runId, {
      outcome,
      endedAt: end,
      sourceCount: outcome === "failure" ? 0 : 2,
      sourceTotal: 3,
      reportNoteId: outcome === "failure" ? null : (extra.reportNoteId ?? "n".repeat(25)),
      unavailableSources:
        outcome === "partial" ? [{ sourceId: "a".repeat(32), code: "timeout" }] : [],
      errorCode: outcome === "failure" ? "all-sources-failed" : null,
    });
    return runId;
  }

  it("maps the store's four members and the configured sources and topic label", () => {
    const success = finishedRun("partial", T(1), T(2));
    const failure = finishedRun("failure", T(3), T(4));
    const running = testRunId() as RunId;
    startJobRun(vault.store.db, {
      jobRunId: running,
      jobKey: RESEARCH_JOB_ID,
      idempotencyKey: `${RESEARCH_JOB_ID}:manual:${running}`,
      trigger: "manual",
      startedAt: T(5),
    });
    appendJobRunStage(vault.store.db, running, { stage: "capture", at: T(5), noteIds: [] });
    const status = ResearchStatusResponseSchema.parse(
      buildResearchStatus(vault.store.db, {
        topicLabel: "Tooling",
        sources: [{ label: "One", host: "one.example.invalid" }],
      }),
    );
    expect(status.lastSuccess).toMatchObject({
      runId: success,
      outcome: "partial",
      sourceCount: 2,
      sourceTotal: 3,
    });
    expect(status.lastFailure).toMatchObject({ runId: failure, errorCode: "all-sources-failed" });
    expect(status.inFlight).toMatchObject({ runId: running, stage: "capture" });
    expect(status.latestUnknown).toBeNull();
    expect(status.configuredSources).toEqual([{ label: "One", host: "one.example.invalid" }]);
    expect(status.topicLabel).toBe("Tooling");
  });

  it("shows nothing for an install that never ran, and null sources for an unusable allowlist", () => {
    const status = ResearchStatusResponseSchema.parse(buildResearchStatus(vault.store.db, null));
    expect(status).toEqual({
      lastSuccess: null,
      lastFailure: null,
      inFlight: null,
      latestUnknown: null,
      configuredSources: null,
      topicLabel: null,
    });
  });
});
