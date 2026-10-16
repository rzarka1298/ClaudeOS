import type {
  ResearchReportHeader,
  ResearchReportItem,
  ResearchReportItemsPage,
  ResearchReportSource,
  ResearchReportSourcesPage,
} from "@ccc/domain/research-routes.js";
import { id25, iso, RESEARCH_TOPIC } from "./research-view-fixtures.js";

/**
 * Synthetic report view models for the reader tests (plan 07-13). Every name, host, id, hash and
 * path is made up (PRIV-04): hosts are reserved `.invalid` names, ids are plain hex, and times are
 * offsets from the frozen research "now". Only ASCII appears here, so the file reads the same in
 * every editor.
 */

export const REPORT_NOTE_ID = id25("report1");
export const REPORT_RUN_ID = id25("run1");
export const REPORT_NOTE_PATH = `global/output/research-2026-10-14-${REPORT_RUN_ID}.md`;
export const REPORT_RUN_NOTE_PATH = `automation-runs/research-run-${REPORT_RUN_ID}.md`;

export const SOURCE_TITLES = [
  "Example tools changelog",
  "Sample runtime releases",
  "Demo language blog",
  "Example editor news",
  "Sample package registry",
  "Demo build tool releases",
] as const;

/** A lowercase hex string of exactly `length` characters, built from a small seed. */
export function hex(seed: number, length: number): string {
  let out = "";
  let state = (seed + 1) * 2654435761;
  while (out.length < length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += state.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

export function reportHeader(overrides: Partial<ResearchReportHeader> = {}): ResearchReportHeader {
  return {
    title: `${RESEARCH_TOPIC} - Oct 14, 2026`,
    noteId: REPORT_NOTE_ID,
    notePath: REPORT_NOTE_PATH,
    generatedAt: iso(-60),
    partial: false,
    unavailableSources: [],
    sourceCount: 3,
    sourceTotal: 3,
    kindCounts: { "source-fact": 1, "unverified-claim": 1, inference: 1 },
    summariser: "extractive",
    jobRunId: REPORT_RUN_ID,
    runStartedAt: iso(-62),
    runEndedAt: iso(-61),
    runOutcome: "success",
    runNotePath: REPORT_RUN_NOTE_PATH,
    ...overrides,
  };
}

export function reportItem(
  index: number,
  overrides: Partial<ResearchReportItem> = {},
): ResearchReportItem {
  return {
    index,
    kind: "source-fact",
    text: `Finding text number ${index} about a runtime release.`,
    quote: null,
    quoteSourceNumber: null,
    citations: [{ number: 1, title: SOURCE_TITLES[0] }],
    ...overrides,
  };
}

/** The three-kind tracer set: a fact with a quote, a source claim and an inference. */
export function threeKindItems(): ResearchReportItem[] {
  return [
    reportItem(1, {
      kind: "source-fact",
      text: "The runtime ships with an updated package manager.",
      quote: "fixes a stream reset in http2",
      quoteSourceNumber: 2,
      citations: [{ number: 2, title: SOURCE_TITLES[1] }],
    }),
    reportItem(2, {
      kind: "unverified-claim",
      text: "The editor team says a new extension host is coming.",
      citations: [
        { number: 1, title: SOURCE_TITLES[0] },
        { number: 3, title: SOURCE_TITLES[2] },
      ],
    }),
    reportItem(3, {
      kind: "inference",
      text: "Release cadence appears to be speeding up across the tools.",
      citations: [],
    }),
  ];
}

export function reportSource(
  number: number,
  overrides: Partial<ResearchReportSource> = {},
): ResearchReportSource {
  const id = hex(number, 32);
  const contentHash = hex(number + 100, 64);
  return {
    number,
    sourceType: "feed-entry",
    id,
    title: SOURCE_TITLES[(number - 1) % SOURCE_TITLES.length] ?? "Example source",
    canonicalUrl: `https://changelog.example.invalid/feed/${number}`,
    author: "Example Author",
    publishedAt: iso(-300),
    retrievedAt: iso(-61),
    contentHash,
    snapshotPath: `global/raw/${id}.${contentHash.slice(0, 8)}.md`,
    accessClass: "public",
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
    ...overrides,
  };
}

export function threeSources(): ResearchReportSource[] {
  return [reportSource(1), reportSource(2), reportSource(3)];
}

export function itemsPage(
  items: readonly ResearchReportItem[],
  options: {
    header?: ResearchReportHeader;
    nextCursor?: string | null;
    truncated?: boolean;
  } = {},
): ResearchReportItemsPage {
  return {
    page: "items",
    header: options.header ?? reportHeader(),
    items: [...items],
    nextCursor: options.nextCursor ?? null,
    truncated: options.truncated ?? false,
  };
}

export function sourcesPage(
  sources: readonly ResearchReportSource[],
  options: { nextCursor?: string | null; truncated?: boolean } = {},
): ResearchReportSourcesPage {
  return {
    page: "sources",
    sources: [...sources],
    nextCursor: options.nextCursor ?? null,
    truncated: options.truncated ?? false,
  };
}

/** A private source: a deep link into the owner's own app, and no canonical address. */
export function privateDeepLinkSource(number: number): ResearchReportSource {
  const { canonicalUrl: _address, ...rest } = reportSource(number, {
    sourceType: "note",
    accessClass: "private",
  });
  return { ...rest, deepLink: "obsidian://open?vault=example&file=sample" };
}

/** A report that lost sources: the header of a partial run with two reasons. */
export function partialHeader(): ResearchReportHeader {
  return reportHeader({
    partial: true,
    sourceCount: 4,
    sourceTotal: 6,
    unavailableSources: [
      { label: "Demo build tool releases", code: "timeout" },
      { label: "Sample package registry", code: "http-status" },
    ],
    runOutcome: "partial",
  });
}
