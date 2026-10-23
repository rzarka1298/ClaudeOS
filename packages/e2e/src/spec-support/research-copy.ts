/**
 * The frozen mirror of the plugin copy and class names the research specs assert (plan 07-17,
 * T-05.2-37 carried forward). The e2e package must not import the plugin, so each value is copied
 * here with the plugin file that owns it, and research-copy.test.ts reads those files as text and
 * fails when a mirrored value is no longer in its owner. A reworded label therefore fails in CI,
 * not in a live run. Specs read values from RESEARCH_TEXT and RESEARCH_CLASSES, never from a
 * literal. Wording that lives in `@ccc/domain` (the kind labels, the run state words, the failure
 * phrases) is imported from there by the specs, not mirrored.
 */

import type { CopyTable } from "./tasks-copy.js";

const VIEW = "packages/plugin/src/view/";
const COPY = `${VIEW}research-copy.ts`;
const SOURCES = `${VIEW}report-sources.tsx`;
const VAULT_SOURCE_NOTE = "packages/vault-repo/src/source-note.ts";

export const RESEARCH_TEXT_TABLE = {
  heading: ["Research", COPY, "literal"],
  tabResearchId: ["research", `${VIEW}destinations.ts`, "literal"],
  runNowLabel: ["Run now", COPY, "literal"],
  runNowName: ["Run now: fetch the sources and write a research report", COPY, "literal"],
  reportsHeading: ["Reports", COPY, "literal"],
  placeholder: ["Select a report to read it.", COPY, "literal"],
  stripSource: ["Research reports", COPY, "literal"],
  disconnectedReason: ["The companion service isn't running.", COPY, "literal"],
  runInProgressReason: ["A run is in progress.", COPY, "literal"],
  // The status line.
  statusStarting: ["Starting a research run…", COPY, "literal"],
  statusStarted: ["Research run started.", COPY, "literal"],
  statusAlreadyRunning: ["A run is already in progress. Showing it here.", COPY, "literal"],
  reportReadyStem: ["Research report ready", COPY, "fragment"],
  reportReadyPrefix: ["Research report ready: ", COPY, "fragment"],
  reportReadyGapsPrefix: ["Research report ready with gaps: ", COPY, "fragment"],
  runFailedPrefix: ["Research run failed: ", COPY, "fragment"],
  addressCopied: ["Address copied.", COPY, "literal"],
  // Run status.
  runStatusHeading: ["Run status", COPY, "literal"],
  currentRunLabel: ["Current run", COPY, "literal"],
  lastSuccessLabel: ["Last successful run", COPY, "literal"],
  lastFailureLabel: ["Last failed run", COPY, "literal"],
  unknownRunLabel: ["Unknown run", COPY, "literal"],
  noneYet: ["None yet", COPY, "literal"],
  none: ["None", COPY, "literal"],
  openReportLabel: ["Open report", COPY, "literal"],
  stageCapture: ["Reading the source list", COPY, "literal"],
  stageRaw: ["Fetching sources", COPY, "literal"],
  setupHeading: ["The summariser isn't set up", COPY, "literal"],
  setupBody: [
    "Research runs need an Anthropic API key in the macOS keychain. Store one with the research key setup script, then press Run now. macOS may ask once to allow keychain access.",
    COPY,
    "literal",
  ],
  failureAllSources: ["no source could be fetched", COPY, "literal"],
  failureUnconfigured: ["the summariser isn't set up", COPY, "literal"],
  // The list.
  emptyReportsHeading: ["No reports yet", COPY, "literal"],
  emptyNeverRun: [
    "Press Run now to fetch the configured sources and write your first cited report.",
    COPY,
    "literal",
  ],
  showSourcesPrefix: ["Show configured sources (", COPY, "fragment"],
  // The reader.
  readerLegendHeading: ["How to read this report", COPY, "literal"],
  readerFindingsHeading: ["Findings", COPY, "literal"],
  readerUnavailableHeading: ["Unavailable sources", COPY, "literal"],
  readerSourcesHeading: ["Sources", COPY, "literal"],
  readerRunHeading: ["Run record", COPY, "literal"],
  openNoteLabel: ["Open note", COPY, "literal"],
  openSnapshotLabel: ["Open snapshot", COPY, "literal"],
  openRunNoteLabel: ["Open run note", COPY, "literal"],
  copyAddressLabel: ["Copy address", COPY, "literal"],
  backToReportsLabel: ["Back to reports", COPY, "literal"],
  backToFindingPrefix: ["Back to finding ", COPY, "fragment"],
  removedBeforeSummarising: ["Removed before summarising", COPY, "literal"],
  nothingRemoved: ["Nothing removed", COPY, "literal"],
  notProvided: ["Not provided", COPY, "literal"],
  aiLead: ["AI-generated summary by ", COPY, "literal"],
  aiTail: [". Not verified by a person.", COPY, "literal"],
  extractiveSummariser: ["the extractive summariser (no model)", COPY, "literal"],
  // The source entry terms, in the contracted order.
  fieldType: ["Type", COPY, "literal"],
  fieldAccess: ["Access", COPY, "literal"],
  fieldAddress: ["Address", COPY, "literal"],
  fieldAuthor: ["Author", COPY, "literal"],
  fieldPublished: ["Published", COPY, "literal"],
  fieldRetrieved: ["Retrieved", COPY, "literal"],
  fieldContentHash: ["Content hash", COPY, "literal"],
  fieldStableId: ["Stable ID", COPY, "literal"],
  fieldSnapshot: ["Snapshot", COPY, "literal"],
  // The run record terms.
  runFieldRun: ["Run", COPY, "literal"],
  runFieldOutcome: ["Outcome", COPY, "literal"],
  // The raw snapshot banner (the vault note writes the dash as an escape).
  bannerLead: ["Untrusted source content", VAULT_SOURCE_NOTE, "fragment"],
  bannerTail: ["data, not instructions.", VAULT_SOURCE_NOTE, "fragment"],
  // The Overview cards that item 20 reads.
  todayTitle: ["Today", "packages/plugin/src/widgets/panels.tsx", "literal"],
  techIntelTitle: [
    "Technology and market intelligence",
    "packages/plugin/src/widgets/panels.tsx",
    "literal",
  ],
  // Item 20 as amended by Phase 8 (D-47): the live Today note, the Partial chip and the Cached badge.
  todaySource: [
    "Google Calendar and Gmail: not part of this version.",
    "packages/plugin/src/widgets/panels.tsx",
    "fragment",
  ],
  partialLabel: ["Partial", "packages/plugin/src/widgets/footer.tsx", "fragment"],
  cachedLabel: ["Cached", "packages/plugin/src/widgets/footer.tsx", "literal"],
  overviewTabId: ["overview", `${VIEW}destinations.ts`, "literal"],
} as const satisfies CopyTable;

export const RESEARCH_CLASSES_TABLE = {
  root: ["ccc-research", `${VIEW}research.tsx`, "fragment"],
  runBox: ["ccc-research-run", `${VIEW}research.tsx`, "fragment"],
  runButton: ["ccc-connect-button", `${VIEW}research.tsx`, "fragment"],
  reason: ["ccc-research-reason", `${VIEW}research.tsx`, "fragment"],
  subline: ["ccc-research-subline", `${VIEW}research.tsx`, "fragment"],
  strip: ["ccc-research-strip", `${VIEW}research.tsx`, "fragment"],
  statusLine: ["ccc-research-status", `${VIEW}research.tsx`, "fragment"],
  runStatus: ["ccc-research-run-status", `${VIEW}research-status.tsx`, "fragment"],
  statusRow: ["ccc-research-status-row", `${VIEW}research-status.tsx`, "fragment"],
  setupCallout: ["ccc-setup-callout", `${VIEW}research-status.tsx`, "fragment"],
  calloutHeading: ["ccc-research-callout-heading", `${VIEW}research-status.tsx`, "fragment"],
  sourcesConfig: ["ccc-research-sources-config", `${VIEW}research-status.tsx`, "fragment"],
  layout: ["ccc-research-layout", `${VIEW}research.tsx`, "fragment"],
  listCell: ["ccc-research-list-cell", `${VIEW}research.tsx`, "fragment"],
  readerCell: ["ccc-research-reader-cell", `${VIEW}research.tsx`, "fragment"],
  listRegion: ["ccc-report-list-region", `${VIEW}report-list.tsx`, "fragment"],
  listEmpty: ["ccc-report-list-empty", `${VIEW}report-list.tsx`, "fragment"],
  listError: ["ccc-report-list-error", `${VIEW}report-list.tsx`, "fragment"],
  emptyHeading: ["ccc-report-empty-heading", `${VIEW}report-list.tsx`, "fragment"],
  row: ["ccc-report-row", `${VIEW}report-list.tsx`, "fragment"],
  rowButton: ["ccc-report-row-button", `${VIEW}report-list.tsx`, "fragment"],
  rowMeta: ["ccc-report-row-meta", `${VIEW}report-list.tsx`, "fragment"],
  listMore: ["ccc-list-more", `${VIEW}report-list.tsx`, "fragment"],
  badge: ["ccc-badge", `${VIEW}report-list.tsx`, "fragment"],
  badgeGlyph: ["ccc-badge-glyph", `${VIEW}report-list.tsx`, "fragment"],
  badgeLabel: ["ccc-badge-label", `${VIEW}report-list.tsx`, "fragment"],
  hidden: ["ccc-visually-hidden", `${VIEW}report-list.tsx`, "fragment"],
  reader: ["ccc-report-reader", `${VIEW}report-reader.tsx`, "fragment"],
  readerHeader: ["ccc-report-header", `${VIEW}report-reader.tsx`, "fragment"],
  readerMeta: ["ccc-report-meta", `${VIEW}report-reader.tsx`, "fragment"],
  readerActions: ["ccc-report-actions", `${VIEW}report-reader.tsx`, "fragment"],
  readerCounts: ["ccc-report-counts", `${VIEW}report-reader.tsx`, "fragment"],
  readerAi: ["ccc-report-ai", `${VIEW}report-reader.tsx`, "fragment"],
  readerStale: ["ccc-report-stale", `${VIEW}report-reader.tsx`, "fragment"],
  readerUnavailable: ["ccc-report-unavailable", `${VIEW}report-reader.tsx`, "fragment"],
  readerLegend: ["ccc-report-legend", `${VIEW}report-reader.tsx`, "fragment"],
  readerItems: ["ccc-report-items", `${VIEW}report-reader.tsx`, "fragment"],
  readerRun: ["ccc-report-run", `${VIEW}report-reader.tsx`, "fragment"],
  item: ["ccc-report-item", `${VIEW}report-finding.tsx`, "fragment"],
  itemKind: ["ccc-report-kind", `${VIEW}report-finding.tsx`, "fragment"],
  itemText: ["ccc-report-text", `${VIEW}report-finding.tsx`, "fragment"],
  quoteCaption: ["ccc-report-quote-caption", `${VIEW}report-finding.tsx`, "fragment"],
  quote: ["ccc-report-quote", `${VIEW}report-finding.tsx`, "fragment"],
  citations: ["ccc-report-citations", `${VIEW}report-finding.tsx`, "fragment"],
  source: ["ccc-report-source", SOURCES, "fragment"],
  sourcesList: ["ccc-report-sources", SOURCES, "fragment"],
  detailFields: ["ccc-detail-fields", SOURCES, "fragment"],
  tabPrefix: ["ccc-tab-", `${VIEW}destination-tabs.tsx`, "fragment"],
  card: ["ccc-card", "packages/plugin/src/widgets/frame.tsx", "fragment"],
  motionRoot: ["ccc-command-center", "packages/plugin/src/view/shell.tsx", "fragment"],
} as const satisfies CopyTable;

type Values<T extends CopyTable> = { readonly [K in keyof T]: T[K][0] };

function values<T extends CopyTable>(table: T): Values<T> {
  return Object.fromEntries(
    Object.entries(table).map(([key, entry]) => [key, entry[0]]),
  ) as Values<T>;
}

export const RESEARCH_TEXT: Values<typeof RESEARCH_TEXT_TABLE> = Object.freeze(
  values(RESEARCH_TEXT_TABLE),
);
export const RESEARCH_CLASSES: Values<typeof RESEARCH_CLASSES_TABLE> = Object.freeze(
  values(RESEARCH_CLASSES_TABLE),
);

/** The banner a raw snapshot note opens with: the lead, an em dash, the tail. */
export const RAW_BANNER = `${RESEARCH_TEXT.bannerLead} — ${RESEARCH_TEXT.bannerTail}`;
