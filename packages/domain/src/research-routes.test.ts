// The research route, view-model and event contracts (plan 07-03 task 3; D-23,
// D-25, DIAG-05, UI-SPEC "View-model requirements", research Pattern 8 and
// Pitfall 11, threat T-07-07). Fixed paths, strict bodies, a closed error code
// and no filesystem path anywhere on the wire.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_BASE } from "./api.js";
import * as browser from "./index.browser.js";
import { RESEARCH_JOB_ID, SANITISE_COUNT_KEYS } from "./research.js";
import {
  isReportNotePath,
  RESEARCH_CURSOR_MAX_LENGTH,
  RESEARCH_ERROR_CODES,
  RESEARCH_LIST_PAGE_SIZE,
  RESEARCH_LIST_PATH,
  RESEARCH_REPORT_PATH,
  RESEARCH_RUN_PATH,
  RESEARCH_STATUS_PATH,
  ResearchErrorBodySchema,
  ResearchListRequestSchema,
  ResearchListResponseSchema,
  ResearchReportRequestSchema,
  ResearchReportResponseSchema,
  ResearchRunRequestSchema,
  ResearchRunResponseSchema,
  ResearchStatusRequestSchema,
  ResearchStatusResponseSchema,
  ResearchUpdatedPayloadSchema,
} from "./research-routes.js";
import { rawSnapshotPathFor } from "./source-reference.js";

const NOTE_ID = "abcdefghi0123456789abcdef";
const RUN_ID = "zyxwvutsr9876543210fedcba";
const SRC_ID = "0123456789abcdef0123456789abcdef";
const HASH = "c".repeat(64);
const NOW = "2026-10-13T09:05:00Z";

describe("Test 1 (paths)", () => {
  it("are fixed paths under API_BASE with no parameter segment", () => {
    expect(RESEARCH_RUN_PATH).toBe(`${API_BASE}/research/run`);
    expect(RESEARCH_LIST_PATH).toBe(`${API_BASE}/research/list`);
    expect(RESEARCH_REPORT_PATH).toBe(`${API_BASE}/research/report`);
    expect(RESEARCH_STATUS_PATH).toBe(`${API_BASE}/research/status`);
    for (const path of [
      RESEARCH_RUN_PATH,
      RESEARCH_LIST_PATH,
      RESEARCH_REPORT_PATH,
      RESEARCH_STATUS_PATH,
    ]) {
      expect(path).not.toMatch(/[:{}*?]/);
      expect(path.split("/").filter((segment) => segment !== "")).toHaveLength(4);
    }
  });
});

describe("Test 2 (requests)", () => {
  it("takes an empty strict body for run and for status", () => {
    for (const schema of [ResearchRunRequestSchema, ResearchStatusRequestSchema]) {
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ path: "/etc/passwd" }).success).toBe(false);
      expect(schema.safeParse({ extra: 1 }).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    }
  });

  it("takes an optional URL-safe cursor of at most 256 characters and a limit of at most 25 for list", () => {
    const parses = (body: unknown) => ResearchListRequestSchema.safeParse(body).success;
    expect(RESEARCH_CURSOR_MAX_LENGTH).toBe(256);
    expect(RESEARCH_LIST_PAGE_SIZE).toBe(25);
    expect(parses({})).toBe(true);
    expect(parses({ cursor: "abc_DEF-123", limit: 25 })).toBe(true);
    expect(parses({ cursor: "a".repeat(256) })).toBe(true);
    expect(parses({ cursor: "a".repeat(257) })).toBe(false);
    expect(parses({ cursor: "" })).toBe(false);
    expect(parses({ cursor: "../../etc" })).toBe(false);
    expect(parses({ cursor: "a b" })).toBe(false);
    expect(parses({ limit: 26 })).toBe(false);
    expect(parses({ limit: 0 })).toBe(false);
    expect(parses({ limit: 1.5 })).toBe(false);
    expect(parses({ extra: 1 })).toBe(false);
    expect(parses({ path: "global/output/x.md" })).toBe(false);
  });

  it("takes a note id, a page and an optional cursor for report", () => {
    const parses = (body: unknown) => ResearchReportRequestSchema.safeParse(body).success;
    expect(parses({ noteId: NOTE_ID, page: "items" })).toBe(true);
    expect(parses({ noteId: NOTE_ID, page: "sources" })).toBe(true);
    expect(parses({ noteId: NOTE_ID, page: "items", cursor: "abc123" })).toBe(true);
    expect(parses({ noteId: NOTE_ID, page: "header" })).toBe(false);
    expect(parses({ noteId: NOTE_ID })).toBe(false);
    expect(parses({ page: "items" })).toBe(false);
  });

  it("rejects a filesystem path in place of a note id and any extra key", () => {
    const parses = (body: unknown) => ResearchReportRequestSchema.safeParse(body).success;
    for (const noteId of [
      "global/output/report.md",
      "../../etc/passwd",
      "/Users/USERNAME/vault/x.md",
      NOTE_ID.toUpperCase(),
      NOTE_ID.slice(1),
      `${NOTE_ID}0`,
    ]) {
      expect(parses({ noteId, page: "items" }), noteId).toBe(false);
    }
    expect(parses({ noteId: NOTE_ID, page: "items", path: "global/output/x.md" })).toBe(false);
    expect(parses({ noteId: NOTE_ID, page: "items", limit: 5 })).toBe(false);
  });
});

describe("Test 3 (responses)", () => {
  it("answers run with the run id, whether it was already running and the state", () => {
    const parses = (body: unknown) => ResearchRunResponseSchema.safeParse(body).success;
    expect(parses({ runId: RUN_ID, alreadyRunning: false, state: "running" })).toBe(true);
    expect(parses({ runId: RUN_ID, alreadyRunning: true, state: "running" })).toBe(true);
    expect(parses({ runId: "not-an-id", alreadyRunning: false, state: "running" })).toBe(false);
    expect(parses({ runId: RUN_ID, alreadyRunning: false, state: "paused" })).toBe(false);
    expect(parses({ runId: RUN_ID, alreadyRunning: false })).toBe(false);
    expect(parses({ runId: RUN_ID, alreadyRunning: false, state: "running", extra: 1 })).toBe(
      false,
    );
  });

  describe("list", () => {
    const readable = {
      readable: true,
      noteId: NOTE_ID,
      title: "Developer tooling digest",
      generatedAt: NOW,
      partial: true,
      sourceCount: 4,
      sourceTotal: 6,
      itemCount: 12,
      unavailableCount: 2,
    };
    const unreadable = {
      readable: false,
      fileName: "2026-10-13-digest.md",
      notePath: "global/output/2026-10-13-digest.md",
    };
    const parses = (body: unknown) => ResearchListResponseSchema.safeParse(body).success;

    it("parses readable and unreadable rows with a next cursor", () => {
      expect(parses({ rows: [readable, unreadable], nextCursor: "abc" })).toBe(true);
      expect(parses({ rows: [], nextCursor: null })).toBe(true);
    });

    it("rejects an extra key anywhere, more than 25 rows and a bad cursor", () => {
      expect(parses({ rows: [], nextCursor: null, total: 1 })).toBe(false);
      expect(parses({ rows: [{ ...readable, body: "x" }], nextCursor: null })).toBe(false);
      expect(parses({ rows: Array.from({ length: 26 }, () => readable), nextCursor: null })).toBe(
        false,
      );
      expect(parses({ rows: [], nextCursor: "../x" })).toBe(false);
    });

    it("keeps a readable row's fields strict and gives an unreadable row only a file name and path", () => {
      expect(parses({ rows: [{ ...readable, fileName: "x.md" }], nextCursor: null })).toBe(false);
      expect(parses({ rows: [{ ...readable, noteId: "../x" }], nextCursor: null })).toBe(false);
      expect(parses({ rows: [{ ...unreadable, title: "x" }], nextCursor: null })).toBe(false);
      expect(parses({ rows: [{ readable: false, fileName: "x.md" }], nextCursor: null })).toBe(
        false,
      );
    });

    it("gives a readable row the vault-relative path of its report (07-FIX4 i)", () => {
      const withPath = { ...readable, notePath: "global/output/research-2026-10-13-digest.md" };
      expect(parses({ rows: [withPath], nextCursor: null })).toBe(true);
      // The path is required, and held to the same shape as an unreadable row's.
      expect(parses({ rows: [readable], nextCursor: null })).toBe(false);
      for (const notePath of [
        "/Users/USERNAME/x.md",
        "global/output/../../x.md",
        "global/wiki/x.md",
      ]) {
        expect(parses({ rows: [{ ...withPath, notePath }], nextCursor: null }), notePath).toBe(
          false,
        );
      }
    });

    it("never carries an absolute or traversing path", () => {
      for (const notePath of [
        "/Users/USERNAME/vault/global/output/x.md",
        "global/output/../../x.md",
        "global/wiki/x.md",
        "global\\output\\x.md",
        "global/output/x.txt",
        "global/output/.hidden.md",
        "global/output/index.md",
        "global/output/sub/x.md",
      ]) {
        const row = { ...unreadable, notePath };
        expect(parses({ rows: [row], nextCursor: null }), notePath).toBe(false);
      }
      expect(isReportNotePath("global/output/ok name.md")).toBe(true);
    });
  });

  describe("status", () => {
    const full = {
      lastSuccess: {
        runId: RUN_ID,
        endedAt: NOW,
        outcome: "partial",
        sourceCount: 4,
        sourceTotal: 6,
        reportNoteId: NOTE_ID,
      },
      lastFailure: { runId: RUN_ID, endedAt: NOW, errorCode: "all-sources-failed" },
      inFlight: { runId: RUN_ID, startedAt: NOW, stage: "raw" },
      latestUnknown: { runId: RUN_ID, startedAt: NOW },
      configuredSources: [{ label: "Example releases", host: "example.org" }],
      topicLabel: "Developer tooling and open-source releases",
    };
    const parses = (body: unknown) => ResearchStatusResponseSchema.safeParse(body).success;

    it("parses a full fixture and a fixture where every member is null", () => {
      expect(parses(full)).toBe(true);
      expect(
        parses({
          lastSuccess: null,
          lastFailure: null,
          inFlight: null,
          latestUnknown: null,
          configuredSources: null,
          topicLabel: null,
        }),
      ).toBe(true);
    });

    it("requires every member to be present, each nullable on its own", () => {
      for (const key of Object.keys(full)) {
        const { [key]: _drop, ...without } = full as Record<string, unknown>;
        expect(parses(without), `missing ${key}`).toBe(false);
        expect(parses({ ...full, [key]: null }), `null ${key}`).toBe(true);
      }
    });

    it("rejects an extra key, an unknown outcome, an unknown error code and an unknown stage", () => {
      expect(parses({ ...full, extra: 1 })).toBe(false);
      expect(parses({ ...full, lastSuccess: { ...full.lastSuccess, outcome: "failure" } })).toBe(
        false,
      );
      expect(parses({ ...full, lastSuccess: { ...full.lastSuccess, extra: 1 } })).toBe(false);
      expect(
        parses({ ...full, lastFailure: { ...full.lastFailure, errorCode: "the server said hi" } }),
      ).toBe(false);
      expect(parses({ ...full, inFlight: { ...full.inFlight, stage: "later" } })).toBe(false);
      expect(parses({ ...full, inFlight: { ...full.inFlight, stage: null } })).toBe(true);
    });

    it("lists configured sources as a label and a host only, never a full address", () => {
      expect(
        parses({
          ...full,
          configuredSources: [{ label: "x", host: "example.org", url: "https://x" }],
        }),
      ).toBe(false);
      expect(parses({ ...full, configuredSources: [{ label: "x", host: "ex ample" }] })).toBe(
        false,
      );
      expect(
        parses({
          ...full,
          configuredSources: Array.from({ length: 13 }, () => ({
            label: "x",
            host: "example.org",
          })),
        }),
      ).toBe(false);
    });
  });

  describe("report", () => {
    const header = {
      title: "Developer tooling digest",
      noteId: NOTE_ID,
      notePath: "global/output/2026-10-13-digest.md",
      generatedAt: NOW,
      partial: true,
      unavailableSources: [{ label: "Example blog", code: "timeout" }],
      sourceCount: 5,
      sourceTotal: 6,
      kindCounts: { "source-fact": 1, "unverified-claim": 1, inference: 1 },
      summariser: "claude-haiku-5-5",
      jobRunId: RUN_ID,
      runStartedAt: NOW,
      runEndedAt: NOW,
      runOutcome: "partial",
      runNotePath: `automation-runs/${RUN_ID}.md`,
    };
    const itemRow = {
      index: 1,
      kind: "source-fact",
      text: "Version 2 ships next week.",
      quote: "ships next week",
      quoteSourceNumber: 1,
      citations: [{ number: 1, title: "Release 2" }],
    };
    const itemsPage = {
      page: "items",
      header,
      items: [
        itemRow,
        {
          ...itemRow,
          index: 2,
          kind: "inference",
          quote: null,
          quoteSourceNumber: null,
          citations: [],
        },
      ],
      nextCursor: null,
      truncated: false,
    };
    const counts = Object.fromEntries(SANITISE_COUNT_KEYS.map((key) => [key, 0]));
    const sourceRow = {
      number: 1,
      sourceType: "feed-entry",
      id: SRC_ID,
      title: "Release 2",
      canonicalUrl: "https://example.org/releases/2",
      author: null,
      publishedAt: NOW,
      retrievedAt: NOW,
      contentHash: HASH,
      snapshotPath: rawSnapshotPathFor(SRC_ID, HASH),
      accessClass: "public",
      counts,
    };
    const sourcesPage = {
      page: "sources",
      sources: [sourceRow],
      nextCursor: null,
      truncated: false,
    };
    const parses = (body: unknown) => ResearchReportResponseSchema.safeParse(body).success;

    it("parses the items page and the sources page", () => {
      expect(parses(itemsPage)).toBe(true);
      expect(parses(sourcesPage)).toBe(true);
    });

    it("carries every header field the UI-SPEC lists, each required", () => {
      for (const key of Object.keys(header)) {
        const { [key]: _drop, ...without } = header as Record<string, unknown>;
        expect(parses({ ...itemsPage, header: without }), `missing ${key}`).toBe(false);
      }
      const nullableRunFields = ["runStartedAt", "runEndedAt", "runOutcome", "runNotePath"];
      for (const key of nullableRunFields) {
        expect(parses({ ...itemsPage, header: { ...header, [key]: null } }), key).toBe(true);
      }
    });

    it("rejects an extra key on the page, the header, an item, a citation and a source", () => {
      expect(parses({ ...itemsPage, extra: 1 })).toBe(false);
      expect(parses({ ...itemsPage, header: { ...header, extra: 1 } })).toBe(false);
      expect(parses({ ...itemsPage, items: [{ ...itemRow, html: "<b>" }] })).toBe(false);
      expect(
        parses({
          ...itemsPage,
          items: [{ ...itemRow, citations: [{ number: 1, title: "x", url: "https://x" }] }],
        }),
      ).toBe(false);
      expect(parses({ ...sourcesPage, sources: [{ ...sourceRow, extra: 1 }] })).toBe(false);
      expect(
        parses({ ...sourcesPage, sources: [{ ...sourceRow, counts: { ...counts, extra: 1 } }] }),
      ).toBe(false);
    });

    it("keeps item text plain: one line, no control character, no recommendation kind", () => {
      expect(parses({ ...itemsPage, items: [{ ...itemRow, text: "a\nb" }] })).toBe(false);
      expect(parses({ ...itemsPage, items: [{ ...itemRow, text: "x".repeat(601) }] })).toBe(false);
      expect(parses({ ...itemsPage, items: [{ ...itemRow, kind: "recommendation" }] })).toBe(false);
      expect(parses({ ...itemsPage, items: [{ ...itemRow, quote: "a\u202Eb" }] })).toBe(false);
    });

    it("requires a quote and its source number together", () => {
      expect(parses({ ...itemsPage, items: [{ ...itemRow, quoteSourceNumber: null }] })).toBe(
        false,
      );
      expect(parses({ ...itemsPage, items: [{ ...itemRow, quote: null }] })).toBe(false);
    });

    it("holds a page to at most 10 findings, 8 citations and 12 sources", () => {
      expect(parses({ ...itemsPage, items: Array.from({ length: 10 }, () => itemRow) })).toBe(true);
      expect(parses({ ...itemsPage, items: Array.from({ length: 11 }, () => itemRow) })).toBe(
        false,
      );
      const nine = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, title: "t" }));
      expect(parses({ ...itemsPage, items: [{ ...itemRow, citations: nine }] })).toBe(false);
      expect(parses({ ...sourcesPage, sources: Array.from({ length: 13 }, () => sourceRow) })).toBe(
        false,
      );
    });

    it("keeps a source row to one address and a null counts value when handling is missing", () => {
      const { canonicalUrl: _drop, ...none } = sourceRow;
      expect(parses({ ...sourcesPage, sources: [none] })).toBe(false);
      expect(
        parses({
          ...sourcesPage,
          sources: [{ ...sourceRow, deepLink: "obsidian://open?vault=x" }],
        }),
      ).toBe(false);
      expect(parses({ ...sourcesPage, sources: [{ ...sourceRow, counts: null }] })).toBe(true);
    });

    it("never accepts an absolute path as the note or run note path", () => {
      for (const field of ["notePath", "runNotePath"]) {
        for (const bad of [
          "/Users/USERNAME/x.md",
          "../x.md",
          "automation-runs/../../x.md",
          "C:\\x.md",
        ]) {
          expect(
            parses({ ...itemsPage, header: { ...header, [field]: bad } }),
            `${field} ${bad}`,
          ).toBe(false);
        }
      }
    });
  });
});

describe("Test 4 (errors)", () => {
  it("is a closed enum of exactly the eight codes", () => {
    expect([...RESEARCH_ERROR_CODES]).toEqual([
      "vault-not-set-up",
      "not-found",
      "unreadable-report",
      "invalid-body",
      "invalid-cursor",
      "service-disconnected",
      "timeout",
      "unrecognised-response",
    ]);
    for (const error of RESEARCH_ERROR_CODES) {
      expect(ResearchErrorBodySchema.safeParse({ error }).success, error).toBe(true);
    }
  });

  it("rejects any other code, a message and an extra key", () => {
    expect(ResearchErrorBodySchema.safeParse({ error: "write-failed" }).success).toBe(false);
    expect(ResearchErrorBodySchema.safeParse({ error: "boom: /Users/USERNAME" }).success).toBe(
      false,
    );
    expect(ResearchErrorBodySchema.safeParse({ error: "timeout", message: "x" }).success).toBe(
      false,
    );
    expect(ResearchErrorBodySchema.safeParse({}).success).toBe(false);
  });
});

describe("Test 5 (event payload)", () => {
  const parses = (body: unknown) => ResearchUpdatedPayloadSchema.safeParse(body).success;

  it("is a run id, a run state and an optional stage and outcome", () => {
    expect(parses({ runId: RUN_ID, state: "running" })).toBe(true);
    expect(parses({ runId: RUN_ID, state: "running", stage: "synthesis" })).toBe(true);
    expect(parses({ runId: RUN_ID, state: "completed", outcome: "partial" })).toBe(true);
    expect(parses({ runId: RUN_ID, state: "failed", stage: "raw", outcome: "failure" })).toBe(true);
  });

  it("rejects an unknown state, stage or outcome and a malformed run id", () => {
    expect(parses({ runId: RUN_ID, state: "paused" })).toBe(false);
    expect(parses({ runId: RUN_ID, state: "running", stage: "later" })).toBe(false);
    expect(parses({ runId: RUN_ID, state: "completed", outcome: "skipped" })).toBe(false);
    expect(parses({ runId: "../x", state: "running" })).toBe(false);
    expect(parses({ state: "running" })).toBe(false);
  });

  it("ignores a key it does not know, so a later field can be added", () => {
    expect(parses({ runId: RUN_ID, state: "running", future: 1 })).toBe(true);
  });
});

describe("Test 6 (exports)", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("exposes the new modules through the browser-safe barrel", () => {
    const names = Object.keys(browser);
    for (const name of [
      "SourceReferenceSchema",
      "REPORT_ITEM_KIND_DISPLAY",
      "RESEARCH_JOB_ID",
      "ReportFrontmatterSchema",
      "REPORT_FRONTMATTER_KEY_ORDER",
      "RESEARCH_STATUS_PATH",
      "ResearchUpdatedPayloadSchema",
    ]) {
      expect(names, name).toContain(name);
    }
    expect(browser.RESEARCH_JOB_ID).toBe(RESEARCH_JOB_ID);
  });

  it("imports no node: module in any of the four new files", () => {
    for (const file of [
      "source-reference.ts",
      "research.ts",
      "research-note-schema.ts",
      "research-routes.ts",
    ]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["']node:/);
      expect(source, file).not.toMatch(/import\(\s*["']node:/);
      expect(source, file).not.toMatch(/require\(/);
    }
  });

  it("imports ids.ts only as a type, if at all", () => {
    for (const file of [
      "source-reference.ts",
      "research.ts",
      "research-note-schema.ts",
      "research-routes.ts",
    ]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']\.\/ids\.js["']/m);
    }
  });
});
