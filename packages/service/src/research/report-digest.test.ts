import type { ReportFrontmatter } from "@ccc/domain";
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
