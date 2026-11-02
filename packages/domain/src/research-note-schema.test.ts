// The report, raw-source and wiki frontmatter contracts (plan 07-03 task 2; D-14,
// D-15, ADR-0020, research Patterns 5 and 6, threats T-06 injection and T-07-06).
// The schemas, the key-order arrays and these tests move together: a key added to
// one and not the others fails here.
import { describe, expect, it } from "vitest";
import { NOTE_FRONTMATTER_KEY_ORDER } from "./note-schema.js";
import { RESEARCH_JOB_ID, SANITISE_COUNT_KEYS, SOURCE_FAILURE_CODES } from "./research.js";
import {
  RAW_SOURCE_FILE_MAX_BYTES,
  RAW_SOURCE_FRONTMATTER_KEY_ORDER,
  RAW_SOURCE_FRONTMATTER_MAX_BYTES,
  RawSourceFrontmatterSchema,
  REPORT_FILE_MAX_BYTES,
  REPORT_FRONTMATTER_KEY_ORDER,
  REPORT_FRONTMATTER_MAX_BYTES,
  REPORT_HANDLING_KEY_ORDER,
  REPORT_ITEM_KEY_ORDER,
  REPORT_ITEMS_MAX,
  REPORT_UNAVAILABLE_SOURCE_KEY_ORDER,
  ReportFrontmatterSchema,
  SOURCE_REFERENCE_KEY_ORDER,
  WIKI_SOURCE_FRONTMATTER_KEY_ORDER,
  WikiSourceFrontmatterSchema,
} from "./research-note-schema.js";
import { rawSnapshotPathFor, SourceReferenceSchema } from "./source-reference.js";

const NOTE_ID = "abcdefghi0123456789abcdef";
const RUN_ID = "zyxwvutsr9876543210fedcba";
const HEX = "0123456789abcdef";

/** Source `n` of the fixture: id and hash derived so every reference is distinct and consistent. */
function sourceId(n: number): string {
  return `${n.toString(16).padStart(2, "0")}${HEX.repeat(2)}`.slice(0, 32).padEnd(32, "0");
}
function hashOf(n: number): string {
  return `${n.toString(16).padStart(2, "0")}${"b".repeat(62)}`;
}

function ref(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = sourceId(n);
  const contentHash = hashOf(n);
  return {
    sourceType: "feed-entry",
    id,
    title: `Release ${n}`,
    canonicalUrl: `https://example.org/releases/${n}`,
    author: null,
    publishedAt: "2026-10-12T08:00:00Z",
    retrievedAt: "2026-10-13T09:00:00Z",
    contentHash,
    snapshotPath: rawSnapshotPathFor(id, contentHash),
    accessClass: "public",
    ...overrides,
  };
}

const COUNTS = Object.fromEntries(SANITISE_COUNT_KEYS.map((key, i) => [key, i]));

function item(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "unverified-claim",
    text: `Finding ${n}`,
    quote: "the quoted words",
    citedSourceIds: [sourceId(1 + (n % 6))],
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const refs = [1, 2, 3, 4, 5, 6].map((n) => ref(n));
  return {
    id: NOTE_ID,
    scope: "global",
    stage: "output",
    created: "2026-10-13T09:05:00Z",
    updated: "2026-10-13T09:06:00Z",
    generatedBy: { model: "claude-haiku-5-5", automation: RESEARCH_JOB_ID, runId: RUN_ID },
    aiGenerated: true,
    claimType: "summary",
    sources: refs.map((r) => r.id),
    confidence: "unverified",
    lastReviewed: null,
    type: "report",
    topicLabel: "Developer tooling and open-source releases",
    generatedAt: "2026-10-13T09:05:00Z",
    jobRunId: RUN_ID,
    summariser: "claude-haiku-5-5",
    partial: true,
    sourceTotal: 8,
    unavailableSources: [
      { label: "Example blog", code: "timeout" },
      { label: "Example news", code: "http-status" },
    ],
    sourceRefs: refs,
    sourceHandling: refs.map((r) => ({ sourceId: r.id, counts: COUNTS })),
    items: Array.from({ length: 25 }, (_, i) =>
      item(i, { kind: (["source-fact", "unverified-claim", "inference"] as const)[i % 3] }),
    ),
    ...overrides,
  };
}

function reportParses(overrides: Record<string, unknown> = {}): boolean {
  return ReportFrontmatterSchema.safeParse(report(overrides)).success;
}

/** Item `n` made valid for its kind: a fact needs a citation, an inference may have none. */
function factItem(n: number, overrides: Record<string, unknown> = {}) {
  return item(n, { kind: "source-fact", quote: "the quoted words", ...overrides });
}

describe("Test 1 (report shape)", () => {
  it("parses a report with six references, 25 items of all kinds, two unavailable sources and handling counts", () => {
    const result = ReportFrontmatterSchema.safeParse(report());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items).toHaveLength(REPORT_ITEMS_MAX);
      expect(result.data.sourceRefs).toHaveLength(6);
      expect(new Set(result.data.items.map((i) => i.kind))).toEqual(
        new Set(["source-fact", "unverified-claim", "inference"]),
      );
    }
  });

  it("requires type report, claimType summary and stage deliverable or output", () => {
    expect(reportParses({ type: "task" })).toBe(false);
    expect(reportParses({ type: undefined })).toBe(false);
    expect(reportParses({ claimType: "inference" })).toBe(false);
    expect(reportParses({ claimType: undefined })).toBe(false);
    expect(reportParses({ stage: "deliverable" })).toBe(true);
    expect(reportParses({ stage: "output" })).toBe(true);
    for (const stage of ["capture", "raw", "synthesis", "wiki"]) {
      expect(reportParses({ stage }), stage).toBe(false);
    }
  });

  it("requires generatedBy.automation to equal the job id", () => {
    expect(reportParses({ generatedBy: { model: "claude-haiku-5-5", runId: RUN_ID } })).toBe(false);
    expect(reportParses({ generatedBy: { automation: "something.else" } })).toBe(false);
    expect(reportParses({ generatedBy: { automation: RESEARCH_JOB_ID } })).toBe(true);
  });

  it("holds the run id, summariser, instants and totals to their shapes", () => {
    expect(reportParses({ jobRunId: "../etc" })).toBe(false);
    expect(reportParses({ jobRunId: RUN_ID.toUpperCase() })).toBe(false);
    expect(reportParses({ summariser: "extractive" })).toBe(true);
    expect(reportParses({ summariser: "gpt-9" })).toBe(false);
    expect(reportParses({ generatedAt: "yesterday" })).toBe(false);
    expect(reportParses({ topicLabel: "" })).toBe(false);
    expect(reportParses({ topicLabel: "x".repeat(81) })).toBe(false);
    expect(reportParses({ sourceTotal: -1 })).toBe(false);
    expect(reportParses({ sourceTotal: 13 })).toBe(false);
    expect(reportParses({ sourceTotal: 1.5 })).toBe(false);
    expect(reportParses({ sourceTotal: 1 })).toBe(false); // fewer than the two unavailable ones
  });

  it("rejects an unknown source in the note-level source list and an extra nested key", () => {
    expect(reportParses({ sources: ["../x"] })).toBe(false);
    expect(reportParses({ sourceRefs: [ref(1, { extra: 1 })] })).toBe(false);
  });

  it("rejects two references with one id", () => {
    const isolated = { items: [], sourceHandling: [], sources: [] };
    expect(reportParses({ ...isolated, sourceRefs: [ref(1)] })).toBe(true);
    expect(reportParses({ ...isolated, sourceRefs: [ref(1), ref(1)] })).toBe(false);
  });

  it("allows 12 references and rejects 13", () => {
    const isolated = {
      items: [],
      sourceHandling: [],
      sources: [],
      partial: false,
      unavailableSources: [],
      sourceTotal: 12,
    };
    const refs = (count: number) => Array.from({ length: count }, (_, n) => ref(n + 1));
    expect(reportParses({ ...isolated, sourceRefs: refs(12) })).toBe(true);
    expect(reportParses({ ...isolated, sourceRefs: refs(13) })).toBe(false);
  });
});

describe("Test 2 (items)", () => {
  const withItems = (items: unknown[]) => reportParses({ items });

  it("accepts the three kinds and an optional quote", () => {
    expect(withItems([factItem(0)])).toBe(true);
    expect(withItems([item(0, { kind: "inference", citedSourceIds: [] })])).toBe(true);
    expect(withItems([])).toBe(true);
  });

  it("rejects a recommendation, an unknown kind and a missing kind", () => {
    expect(withItems([item(0, { kind: "recommendation" })])).toBe(false);
    expect(withItems([item(0, { kind: "summary" })])).toBe(false);
    expect(withItems([item(0, { kind: undefined })])).toBe(false);
  });

  it("allows 25 items and rejects 26", () => {
    expect(withItems(Array.from({ length: 25 }, (_, n) => item(n)))).toBe(true);
    expect(withItems(Array.from({ length: 26 }, (_, n) => item(n)))).toBe(false);
  });

  it("holds text to 1 to 600 characters and quote to 1 to 240", () => {
    expect(withItems([item(0, { text: "x".repeat(600) })])).toBe(true);
    expect(withItems([item(0, { text: "x".repeat(601) })])).toBe(false);
    expect(withItems([item(0, { text: "" })])).toBe(false);
    expect(withItems([item(0, { quote: "q".repeat(240) })])).toBe(true);
    expect(withItems([item(0, { quote: "q".repeat(241) })])).toBe(false);
    expect(withItems([item(0, { quote: "" })])).toBe(false);
  });

  it("rejects a newline, a control, a bidi or a zero-width character in text or quote", () => {
    for (const code of [0x0a, 0x0d, 0x00, 0x1b, 0x202e, 0x200b, 0xfeff, 0x2028, 0x2029]) {
      const bad = `a${String.fromCodePoint(code)}b`;
      expect(withItems([item(0, { text: bad })]), `text U+${code.toString(16)}`).toBe(false);
      expect(withItems([item(0, { quote: bad })]), `quote U+${code.toString(16)}`).toBe(false);
    }
  });

  it("allows 8 cited ids and rejects 9 or a malformed id", () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => sourceId(n));
    expect(withItems([item(0, { citedSourceIds: ids.slice(0, 6) })])).toBe(true);
    expect(withItems([item(0, { citedSourceIds: ["../x"] })])).toBe(false);
    expect(withItems([item(0, { citedSourceIds: [sourceId(1).toUpperCase()] })])).toBe(false);
    const nine = Array.from({ length: 9 }, () => sourceId(1));
    expect(withItems([item(0, { citedSourceIds: nine })])).toBe(false);
    const eight = Array.from({ length: 8 }, () => sourceId(1));
    expect(withItems([item(0, { citedSourceIds: eight })])).toBe(true);
  });

  it("rejects an extra key on an item, including anything link-shaped", () => {
    for (const key of ["url", "link", "href", "image", "html"]) {
      expect(withItems([item(0, { [key]: "https://evil.example/" })]), key).toBe(false);
    }
  });

  it("requires a reported fact and a source claim to carry a quote (07-FIX3A F4)", () => {
    const quote = "a quoted passage from the source";
    for (const kind of ["source-fact", "unverified-claim"]) {
      expect(withItems([item(0, { kind, quote: undefined })]), `${kind} without a quote`).toBe(
        false,
      );
      expect(withItems([item(0, { kind, quote })]), `${kind} with a quote`).toBe(true);
    }
    expect(withItems([item(0, { kind: "inference", quote: undefined })])).toBe(true);
    expect(withItems([item(0, { kind: "inference", quote })])).toBe(true);
  });

  it("requires a reported fact and a source claim to cite at least one source", () => {
    expect(withItems([item(0, { kind: "source-fact", citedSourceIds: [] })])).toBe(false);
    expect(withItems([item(0, { kind: "unverified-claim", citedSourceIds: [] })])).toBe(false);
    expect(withItems([item(0, { kind: "inference", citedSourceIds: [] })])).toBe(true);
  });
});

describe("Test 3 (cross-field rules)", () => {
  it("rejects a cited id that is not a source reference of the report", () => {
    expect(reportParses({ items: [item(0, { citedSourceIds: [sourceId(9)] })] })).toBe(false);
  });

  it("rejects handling for a source that is not a reference, and a duplicate handling entry", () => {
    expect(reportParses({ sourceHandling: [{ sourceId: sourceId(9), counts: COUNTS }] })).toBe(
      false,
    );
    const one = { sourceId: sourceId(1), counts: COUNTS };
    expect(reportParses({ sourceHandling: [one, one] })).toBe(false);
    expect(reportParses({ sourceHandling: [one] })).toBe(true);
  });

  it("rejects handling counts with a missing key, a negative count or an extra key", () => {
    const { scripts: _s, ...missing } = COUNTS;
    const bad = [
      { sourceId: sourceId(1), counts: missing },
      { sourceId: sourceId(1), counts: { ...COUNTS, scripts: -1 } },
      { sourceId: sourceId(1), counts: { ...COUNTS, extra: 1 } },
    ];
    for (const entry of bad) expect(reportParses({ sourceHandling: [entry] })).toBe(false);
  });

  it("carries an unavailable source as a label of 1 to 80 characters and a closed code", () => {
    const one = (entry: unknown) => reportParses({ unavailableSources: [entry], sourceTotal: 7 });
    expect(one({ label: "Blog", code: "timeout" })).toBe(true);
    for (const code of SOURCE_FAILURE_CODES) expect(one({ label: "Blog", code }), code).toBe(true);
    expect(one({ label: "Blog", code: "The server said: <script>" })).toBe(false);
    expect(one({ label: "Blog", code: "timeout", detail: "x" })).toBe(false);
    expect(one({ label: "Blog" })).toBe(false);
    expect(one({ label: "", code: "timeout" })).toBe(false);
    expect(one({ label: "x".repeat(81), code: "timeout" })).toBe(false);
    expect(one({ label: "x".repeat(80), code: "timeout" })).toBe(true);
    expect(one({ label: "a‮b", code: "timeout" })).toBe(false);
  });

  it("makes partial true exactly when there are unavailable sources", () => {
    expect(reportParses({ partial: false })).toBe(false); // two unavailable
    expect(reportParses({ partial: false, unavailableSources: [], sourceTotal: 6 })).toBe(true);
    expect(reportParses({ partial: true, unavailableSources: [], sourceTotal: 6 })).toBe(false);
  });
});

describe("Test 4 (raw source note)", () => {
  const id = sourceId(1);
  const contentHash = hashOf(1);
  function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: NOTE_ID,
      scope: "global",
      stage: "raw",
      created: "2026-10-13T09:00:00Z",
      updated: "2026-10-13T09:00:00Z",
      generatedBy: { automation: RESEARCH_JOB_ID, runId: RUN_ID },
      aiGenerated: false,
      sources: [id],
      confidence: "unverified",
      lastReviewed: null,
      type: "research-source",
      sourceRef: ref(1),
      sanitise: COUNTS,
      ...overrides,
    };
  }
  const rawParses = (overrides: Record<string, unknown> = {}) =>
    RawSourceFrontmatterSchema.safeParse(raw(overrides)).success;

  it("parses a raw source note, with and without the truncated flag", () => {
    expect(rawParses()).toBe(true);
    expect(rawParses({ truncated: true })).toBe(true);
    expect(rawParses({ truncated: "yes" })).toBe(false);
  });

  it("requires type research-source and stage raw", () => {
    expect(rawParses({ type: "report" })).toBe(false);
    expect(rawParses({ stage: "wiki" })).toBe(false);
    expect(rawParses({ stage: "output" })).toBe(false);
  });

  it("requires a full valid sourceRef and the sanitise counts", () => {
    expect(rawParses({ sourceRef: undefined })).toBe(false);
    expect(rawParses({ sourceRef: ref(1, { id: "../x" }) })).toBe(false);
    expect(rawParses({ sanitise: undefined })).toBe(false);
    expect(rawParses({ sanitise: { ...COUNTS, scripts: -1 } })).toBe(false);
  });

  it("requires the snapshot path to equal global/raw/<id>.<first 8 hash characters>.md", () => {
    expect(rawSnapshotPathFor(id, contentHash)).toBe(
      (raw().sourceRef as { snapshotPath: string }).snapshotPath,
    );
    const otherName = `global/raw/${id}.${"c".repeat(8)}.md`;
    expect(SourceReferenceSchema.safeParse(ref(1, { snapshotPath: otherName })).success).toBe(true);
    expect(rawParses({ sourceRef: ref(1, { snapshotPath: otherName }) })).toBe(false);
    const otherId = `global/raw/${sourceId(2)}.${contentHash.slice(0, 8)}.md`;
    expect(rawParses({ sourceRef: ref(1, { snapshotPath: otherId }) })).toBe(false);
  });
});

describe("Test 5 (wiki note)", () => {
  const id = sourceId(1);
  function wiki(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: NOTE_ID,
      scope: "global",
      stage: "wiki",
      created: "2026-10-13T09:00:00Z",
      updated: "2026-10-13T09:00:00Z",
      generatedBy: { automation: RESEARCH_JOB_ID, runId: RUN_ID },
      aiGenerated: false,
      sources: [id],
      confidence: "unverified",
      lastReviewed: null,
      type: "research-wiki",
      sourceId: id,
      latestSnapshotPath: rawSnapshotPathFor(id, hashOf(1)),
      lastRetrievedAt: "2026-10-13T09:00:00Z",
      ...overrides,
    };
  }
  const wikiParses = (overrides: Record<string, unknown> = {}) =>
    WikiSourceFrontmatterSchema.safeParse(wiki(overrides)).success;

  it("parses a wiki note", () => {
    expect(wikiParses()).toBe(true);
  });

  it("requires type research-wiki and stage wiki", () => {
    expect(wikiParses({ type: "research-source" })).toBe(false);
    expect(wikiParses({ stage: "raw" })).toBe(false);
  });

  it("holds the source id, snapshot path and retrieval instant to their shapes", () => {
    expect(wikiParses({ sourceId: "../x" })).toBe(false);
    expect(wikiParses({ latestSnapshotPath: "global/wiki/x.md" })).toBe(false);
    expect(wikiParses({ latestSnapshotPath: "../global/raw/x.md" })).toBe(false);
    expect(wikiParses({ lastRetrievedAt: "recently" })).toBe(false);
    expect(wikiParses({ lastRetrievedAt: undefined })).toBe(false);
  });

  it("requires the latest snapshot to belong to the same source", () => {
    const other = rawSnapshotPathFor(sourceId(2), hashOf(2));
    expect(wikiParses({ latestSnapshotPath: other })).toBe(false);
  });
});

describe("Test 6 (key order)", () => {
  const schemas = [
    ["report", REPORT_FRONTMATTER_KEY_ORDER, ReportFrontmatterSchema],
    ["raw source", RAW_SOURCE_FRONTMATTER_KEY_ORDER, RawSourceFrontmatterSchema],
    ["wiki", WIKI_SOURCE_FRONTMATTER_KEY_ORDER, WikiSourceFrontmatterSchema],
  ] as const;

  for (const [name, order, schema] of schemas) {
    it(`starts the ${name} order with the twelve provenance keys as a literal prefix`, () => {
      expect(NOTE_FRONTMATTER_KEY_ORDER).toHaveLength(12);
      expect(order.slice(0, 12)).toEqual([...NOTE_FRONTMATTER_KEY_ORDER]);
    });

    it(`lists every ${name} schema key exactly once and no other`, () => {
      expect(new Set(order).size).toBe(order.length);
      expect([...order].sort()).toEqual(Object.keys(schema.shape).sort());
    });
  }

  it("exports the nested orders, each equal to its schema's keys", () => {
    const first = ReportFrontmatterSchema.shape.items.element.shape;
    expect([...REPORT_ITEM_KEY_ORDER].sort()).toEqual(Object.keys(first).sort());
    expect([...REPORT_ITEM_KEY_ORDER]).toEqual(["kind", "text", "quote", "citedSourceIds"]);

    const handling = ReportFrontmatterSchema.shape.sourceHandling.element.shape;
    expect([...REPORT_HANDLING_KEY_ORDER].sort()).toEqual(Object.keys(handling).sort());
    expect([...REPORT_HANDLING_KEY_ORDER]).toEqual(["sourceId", "counts"]);

    const unavailable = ReportFrontmatterSchema.shape.unavailableSources.element.shape;
    expect([...REPORT_UNAVAILABLE_SOURCE_KEY_ORDER].sort()).toEqual(
      Object.keys(unavailable).sort(),
    );
    expect([...REPORT_UNAVAILABLE_SOURCE_KEY_ORDER]).toEqual(["label", "code"]);

    expect([...SOURCE_REFERENCE_KEY_ORDER].sort()).toEqual(
      Object.keys(SourceReferenceSchema.shape).sort(),
    );
  });

  it("orders the report keys exactly", () => {
    expect([...REPORT_FRONTMATTER_KEY_ORDER].slice(12)).toEqual([
      "type",
      "topicLabel",
      "generatedAt",
      "jobRunId",
      "summariser",
      "partial",
      "sourceTotal",
      "unavailableSources",
      "sourceRefs",
      "sourceHandling",
      "items",
      "summariserRoute",
    ]);
    expect([...RAW_SOURCE_FRONTMATTER_KEY_ORDER].slice(12)).toEqual([
      "type",
      "sourceRef",
      "sanitise",
      "truncated",
    ]);
    expect([...WIKI_SOURCE_FRONTMATTER_KEY_ORDER].slice(12)).toEqual([
      "type",
      "sourceId",
      "latestSnapshotPath",
      "lastRetrievedAt",
    ]);
  });
});

describe("hostile input (hand-edited or synced-in notes)", () => {
  const rawBase = {
    id: NOTE_ID,
    scope: "global",
    stage: "raw",
    created: "2026-10-13T09:00:00Z",
    updated: "2026-10-13T09:00:00Z",
    generatedBy: {},
    aiGenerated: false,
    sources: [],
    confidence: "unverified",
    lastReviewed: null,
    type: "research-source",
    sanitise: COUNTS,
  };
  const wikiBase = {
    ...rawBase,
    stage: "wiki",
    type: "research-wiki",
    sourceId: sourceId(1),
    lastRetrievedAt: "2026-10-13T09:00:00Z",
  };

  it("fails closed and never throws, whatever shape a field has", () => {
    const hostile: unknown[] = [null, undefined, 5, "x", [], {}, [null], { id: 5 }, { id: {} }];
    for (const value of hostile) {
      expect(() => ReportFrontmatterSchema.safeParse(value)).not.toThrow();
      expect(() => RawSourceFrontmatterSchema.safeParse(value)).not.toThrow();
      expect(() => WikiSourceFrontmatterSchema.safeParse(value)).not.toThrow();
      for (const key of ["items", "sourceRefs", "sourceHandling", "unavailableSources"]) {
        expect(
          () => ReportFrontmatterSchema.safeParse(report({ [key]: value })),
          key,
        ).not.toThrow();
        if (!Array.isArray(value)) {
          expect(ReportFrontmatterSchema.safeParse(report({ [key]: value })).success, key).toBe(
            false,
          );
        }
      }
      expect(() =>
        RawSourceFrontmatterSchema.safeParse({ ...rawBase, sourceRef: value }),
      ).not.toThrow();
      expect(() =>
        WikiSourceFrontmatterSchema.safeParse({ ...wikiBase, latestSnapshotPath: value }),
      ).not.toThrow();
    }
    const badRef = { id: 5, contentHash: 7, snapshotPath: {} };
    expect(RawSourceFrontmatterSchema.safeParse({ ...rawBase, sourceRef: badRef }).success).toBe(
      false,
    );
    const badIds = report({
      sourceRefs: [{ id: 5 }],
      sourceHandling: [{ sourceId: {} }],
      items: [{ citedSourceIds: [1] }],
    });
    expect(() => ReportFrontmatterSchema.safeParse(badIds)).not.toThrow();
    expect(ReportFrontmatterSchema.safeParse(badIds).success).toBe(false);
  });
});

describe("Test 7 (limits)", () => {
  /** A three-byte script character, written as a code point so no raw character is in this file. */
  const CJK = String.fromCodePoint(0x6f22);
  const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 4)).length;

  function worstCase(): Record<string, unknown> {
    const refs = [1, 2, 3, 4, 5, 6].map((n) =>
      ref(n, {
        title: CJK.repeat(200),
        author: CJK.repeat(200),
        canonicalUrl: `https://example.org/${"a".repeat(2000)}`,
      }),
    );
    const ids = refs.map((r) => r.id as string);
    return report({
      sourceRefs: refs,
      sources: ids,
      sourceHandling: ids.map((sourceId) => ({ sourceId, counts: COUNTS })),
      unavailableSources: Array.from({ length: 6 }, () => ({
        label: CJK.repeat(80),
        code: "timeout",
      })),
      sourceTotal: 12,
      items: Array.from({ length: 25 }, (_, n) => ({
        kind: n % 2 === 0 ? "source-fact" : "unverified-claim",
        text: CJK.repeat(600),
        quote: CJK.repeat(240),
        citedSourceIds: [...ids, ids[0], ids[1]],
      })),
    });
  }

  it("parses the worst-case report, with real three-byte text in every text field", () => {
    expect(ReportFrontmatterSchema.safeParse(worstCase()).success).toBe(true);
  });

  it("keeps the worst-case report under the 128 KiB frontmatter cap, with room to spare", () => {
    const bytes = utf8(worstCase());
    expect(REPORT_FRONTMATTER_MAX_BYTES).toBe(128 * 1024);
    expect(bytes).toBeLessThan(REPORT_FRONTMATTER_MAX_BYTES * 0.85);
  });

  it("needs more than the 64 KiB a task is allowed, which is why the report cap is 128 KiB", () => {
    expect(utf8(worstCase())).toBeGreaterThan(64 * 1024);
  });

  it("fixes the whole-file and raw-source caps", () => {
    expect(REPORT_FILE_MAX_BYTES).toBe(256 * 1024);
    expect(RAW_SOURCE_FRONTMATTER_MAX_BYTES).toBe(64 * 1024);
    expect(RAW_SOURCE_FILE_MAX_BYTES).toBe(1024 * 1024);
    expect(REPORT_FRONTMATTER_MAX_BYTES).toBeLessThan(REPORT_FILE_MAX_BYTES);
    expect(RAW_SOURCE_FRONTMATTER_MAX_BYTES).toBeLessThan(RAW_SOURCE_FILE_MAX_BYTES);
  });

  it("caps the item list at 25", () => {
    expect(REPORT_ITEMS_MAX).toBe(25);
  });
});

describe("10-01 Task 2 Test 1 (summariserRoute on the report, D-07)", () => {
  it("parses without the key (every report written before Phase 10) and with either route", () => {
    expect(reportParses()).toBe(true);
    expect(reportParses({ summariserRoute: "subscription" })).toBe(true);
    expect(reportParses({ summariserRoute: "api-key" })).toBe(true);
  });

  it("refuses any other value", () => {
    for (const bad of ["cli", "Subscription", "", 1, null, "extractive"]) {
      expect(reportParses({ summariserRoute: bad }), String(bad)).toBe(false);
    }
  });

  it("puts the key last in the on-disk key order", () => {
    expect(REPORT_FRONTMATTER_KEY_ORDER.at(-1)).toBe("summariserRoute");
    expect(REPORT_FRONTMATTER_KEY_ORDER.at(-2)).toBe("items");
  });
});
