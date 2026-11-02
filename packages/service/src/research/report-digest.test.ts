import {
  type ReportFrontmatter,
  ReportFrontmatterSchema,
  RESEARCH_JOB_ID,
  rawSnapshotPathFor,
} from "@ccc/domain";
import { readReportNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportContentDigest } from "./report-digest.js";
import { createReportVault, type ReportVault } from "./test-support/report-vault.js";

/**
 * 07-FIX6b (ADR-0030): the digest of a report's served content. It is a pure function of the
 * parsed report: stable for the same report, different for any change to a covered value.
 */

let vault: ReportVault;
beforeEach(() => {
  vault = createReportVault();
});
afterEach(() => vault.cleanup());

function parsed(): ReportFrontmatter {
  const built = vault.addReport({
    sources: [
      { url: "https://one.example.invalid/a", text: "The alpha parser is now twice as fast." },
      {
        url: "https://two.example.invalid/b",
        text: "Version 1.9 fixes a crash on empty archives.",
      },
    ],
    items: [
      {
        kind: "source-fact",
        text: "Faster.",
        quote: "alpha parser is now twice as fast",
        cites: [0],
      },
      { kind: "inference", text: "Both are quality work.", cites: [0, 1] },
    ],
    unavailable: [{ label: "Third feed", code: "timeout" }],
  });
  const read = readReportNote(vault.root, built.path);
  if (!read.readable) throw new Error("report must be readable");
  return read.frontmatter;
}

describe("reportContentDigest", () => {
  it("is a SHA-256 in lowercase hex, and the same for the same parsed report", () => {
    const report = parsed();
    expect(reportContentDigest(report)).toMatch(/^[0-9a-f]{64}$/);
    expect(reportContentDigest(report)).toBe(reportContentDigest(structuredClone(report)));
  });

  it("does not depend on the order of an object's keys", () => {
    const report = parsed();
    const reordered = {
      ...report,
      items: report.items.map((item) => Object.fromEntries(Object.entries(item).reverse())),
    };
    expect(reportContentDigest(reordered as ReportFrontmatter)).toBe(reportContentDigest(report));
  });

  it("ignores the stage, which finalising changes", () => {
    const report = parsed();
    expect(reportContentDigest({ ...report, stage: "deliverable" })).toBe(
      reportContentDigest(report),
    );
  });

  it("changes with every covered value", () => {
    const report = parsed();
    const base = reportContentDigest(report);
    const [first, second] = report.items;
    if (first === undefined || second === undefined) throw new Error("two items expected");
    const variants: Record<string, ReportFrontmatter> = {
      claimText: { ...report, items: [{ ...first, text: "Slower." }, second] },
      kind: { ...report, items: [{ ...first, kind: "unverified-claim" }, second] },
      quote: { ...report, items: [{ ...first, quote: "is now twice as fast" }, second] },
      quoteRemoved: {
        ...report,
        items: [
          { kind: first.kind, text: first.text, citedSourceIds: first.citedSourceIds },
          second,
        ],
      },
      citedIds: {
        ...report,
        items: [
          { ...first, citedSourceIds: [...first.citedSourceIds, ...second.citedSourceIds] },
          second,
        ],
      },
      itemOrder: { ...report, items: [second, first] },
      itemDropped: { ...report, items: [first] },
      partial: { ...report, partial: !report.partial },
      sourceTotal: { ...report, sourceTotal: report.sourceTotal + 1 },
      unavailableCode: {
        ...report,
        unavailableSources: report.unavailableSources.map((s) => ({
          ...s,
          code: "network-error" as const,
        })),
      },
      unavailableDropped: { ...report, unavailableSources: [] },
      sourceOrder: { ...report, sourceRefs: [...report.sourceRefs].reverse() },
      sourceHash: {
        ...report,
        sourceRefs: report.sourceRefs.map((ref, i) =>
          i === 0 ? { ...ref, contentHash: "0".repeat(64) } : ref,
        ),
      },
      runId: { ...report, jobRunId: `${report.jobRunId.slice(0, 24)}z` },
      noteId: { ...report, id: `${report.id.slice(0, 24)}z` as ReportFrontmatter["id"] },
      topic: { ...report, topicLabel: "Another topic" },
      generatedAt: { ...report, generatedAt: "2026-10-14T10:00:01.000Z" },
    };
    for (const [name, variant] of Object.entries(variants)) {
      expect(reportContentDigest(variant), name).not.toBe(base);
    }
  });
});

/**
 * 10-01 Task 2 Test 2 (D-07, ADR 0030, T-10-11): the summariser route is recorded in the report
 * note but is not part of the digest, so a report published before this phase keeps the digest the
 * provenance store holds for it.
 */
describe("reportContentDigest and the summariser route", () => {
  const RUN = "zyxwvutsr9876543210fedcba";
  const SOURCE_ID = "0123456789abcdef0123456789abcdef";
  const HASH = `ab${"b".repeat(62)}`;

  function fixed(extra: Record<string, unknown> = {}): ReportFrontmatter {
    return ReportFrontmatterSchema.parse({
      id: "abcdefghi0123456789abcdef",
      scope: "global",
      stage: "output",
      created: "2026-10-13T09:05:00Z",
      updated: "2026-10-13T09:06:00Z",
      generatedBy: { model: "claude-haiku-5-5", automation: RESEARCH_JOB_ID, runId: RUN },
      aiGenerated: true,
      claimType: "summary",
      sources: [SOURCE_ID],
      confidence: "unverified",
      lastReviewed: null,
      type: "report",
      topicLabel: "Developer tooling",
      generatedAt: "2026-10-13T09:05:00Z",
      jobRunId: RUN,
      summariser: "claude-haiku-5-5",
      partial: false,
      sourceTotal: 1,
      unavailableSources: [],
      sourceRefs: [
        {
          sourceType: "feed-entry",
          id: SOURCE_ID,
          title: "Release one",
          canonicalUrl: "https://one.example.invalid/a",
          author: null,
          publishedAt: "2026-10-12T08:00:00Z",
          retrievedAt: "2026-10-13T09:00:00Z",
          contentHash: HASH,
          snapshotPath: rawSnapshotPathFor(SOURCE_ID, HASH),
          accessClass: "public",
        },
      ],
      sourceHandling: [
        {
          sourceId: SOURCE_ID,
          counts: {
            scripts: 0,
            styles: 0,
            comments: 0,
            hiddenBlocks: 0,
            mediaDropped: 0,
            linksDropped: 0,
            controlChars: 0,
            commandLikeLines: 0,
          },
        },
      ],
      items: [
        {
          kind: "source-fact",
          text: "Faster.",
          quote: "the parser is faster",
          citedSourceIds: [SOURCE_ID],
        },
      ],
      ...extra,
    });
  }

  /** Captured from report-digest.ts as it was before the route key existed (plan 10-01 RED step). */
  const PINNED_DIGEST = "b59903d0c562843e5779cc1634bc35bc56b8a19578c58ffc68760fc112d39070";

  it("is the same with and without summariserRoute, and equal to the digest pinned before the key existed", () => {
    const without = reportContentDigest(fixed());
    expect(reportContentDigest(fixed({ summariserRoute: "subscription" }))).toBe(without);
    expect(reportContentDigest(fixed({ summariserRoute: "api-key" }))).toBe(without);
    expect(without).toBe(PINNED_DIGEST);
  });
});
