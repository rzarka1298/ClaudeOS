import type { ResearchStage, SanitiseCountKey, SanitiseCounts } from "@ccc/domain/research.js";
import { SANITISE_COUNT_KEYS } from "@ccc/domain/research.js";
import { countOf } from "./research-format.js";

/**
 * The locked strings and message builders of the Research destination
 * (07-UI-SPEC "Copywriting Contract", R1, R2). One module, so the wording lives
 * in one reviewable place and the source scan has one file to read for it.
 * Sentence case throughout; locations use the arrow; counts and plurals go
 * through `research-format.ts`.
 *
 * Nothing here knows about a path, a payload, a key or a remote error: a string
 * that names report text takes it as an argument and the caller renders it as a
 * text node.
 */

// ---------------------------------------------------------------------------
// R1 labels

export const RESEARCH_HEADING = "Research";
export const RUN_NOW_LABEL = "Run now";
/** The accessible name contains the visible label (WCAG 2.5.3). */
export const RUN_NOW_NAME = "Run now: fetch the sources and write a research report";
export const REPORTS_HEADING = "Reports";
export const REPORT_PLACEHOLDER = "Select a report to read it.";
export const NO_TOPIC_LABEL = "Research sources";
/** The strip's source label (slash-free, PRIV-04). */
export const STRIP_SOURCE_LABEL = "Research reports";

/** The one reason every service-backed control gives while the service is away. */
export const DISCONNECTED_REASON = "The companion service isn't running.";
/** The visible reason beside a Run now that is waiting for the run in flight. */
export const RUN_IN_PROGRESS_REASON = "A run is in progress.";

// ---------------------------------------------------------------------------
// R2 status line sentences

export const STATUS_STARTING = "Starting a research run…";
export const STATUS_STARTED = "Research run started.";
export const STATUS_ALREADY_RUNNING = "A run is already in progress. Showing it here.";
export const STATUS_UNKNOWN_END = "The last run ended without reporting, so its result is unknown.";
export const STATUS_TIMEOUT_NOTICE =
  "Couldn't start the run: the companion service didn't respond within 5 seconds.";
export const STATUS_TIMEOUT_CHECKING = `${STATUS_TIMEOUT_NOTICE} Checking whether it started…`;
export const STATUS_TIMEOUT_STARTED = "It started. Showing it here.";
export const STATUS_TIMEOUT_NOT_STARTED = "It didn't start. You can press Run now again.";
/** The follow-up status could not settle whether the run started, so nothing is claimed either way. */
export const STATUS_TIMEOUT_UNKNOWN =
  "Couldn't confirm whether the run started. The status will update when the service answers.";

/** `Research report ready: {title}.` */
export function reportReadyLine(title: string): string {
  return `Research report ready: ${title}.`;
}

/** The title could not be found in the loaded list (it will be on the next refresh). */
export const REPORT_READY_UNTITLED = "Research report ready.";

/** `Research report ready with gaps: 2 of 6 sources were unavailable.` */
export function reportReadyWithGapsLine(unavailable: number, total: number): string {
  return `Research report ready with gaps: ${unavailable} of ${total} sources were unavailable.`;
}

// ---------------------------------------------------------------------------
// Run stage line (shown only while running)

export const STAGE_TEXT: Readonly<Record<ResearchStage, string>> = {
  capture: "Reading the source list",
  raw: "Fetching sources",
  synthesis: "Summarising",
  wiki: "Updating source notes",
  deliverable: "Writing the report",
  output: "Writing the report",
};

// ---------------------------------------------------------------------------
// R2 run status section

export const RUN_STATUS_HEADING = "Run status";
export const CURRENT_RUN_LABEL = "Current run";
export const LAST_SUCCESS_LABEL = "Last successful run";
export const LAST_FAILURE_LABEL = "Last failed run";
export const UNKNOWN_RUN_LABEL = "Unknown run";
export const NONE_YET = "None yet";
export const NONE = "None";
export const OPEN_REPORT_LABEL = "Open report";
export const UNKNOWN_RUN_SENTENCE = "The app stopped during this run, so its result is unknown.";
/** Follows a value cut to its display cap (UI-SPEC "Untrusted content rules" 4). */
export const TEXT_SHORTENED = "Text shortened for display.";

/** `Each run fetches the 6 configured sources and makes one summariser call.` */
export function eachRunLine(count: number): string {
  const noun = count === 1 ? "source" : "sources";
  return `Each run fetches the ${count} configured ${noun} and makes one summariser call.`;
}

/** `Show configured sources (6)` while closed. */
export function showSourcesLabel(count: number): string {
  return `Show configured sources (${count})`;
}
export const HIDE_SOURCES_LABEL = "Hide configured sources";
export const SOURCES_FOOTNOTE =
  "The source list is edited in the companion service's research settings. A settings screen comes in a later phase.";

// ---------------------------------------------------------------------------
// The summariser setup callout (decided from the run record only, R-12)

export const SETUP_HEADING = "The summariser isn't set up";
export const SETUP_BODY =
  "Research runs need an Anthropic API key in the macOS keychain. Store one with the research key setup script, then press Run now. macOS may ask once to allow keychain access.";

// ---------------------------------------------------------------------------
// Run failure reasons (closed error code to fixed copy; never a remote string)

interface FailureCopy {
  /** Mid-sentence reason, or null for a code that is not a failure. */
  readonly reason: string | null;
  readonly nextStep: string;
}

const UNKNOWN_FAILURE: FailureCopy = {
  reason: "something went wrong",
  nextStep: "Check the service in Settings → Diagnostics.",
};

const FAILURE_COPY: Readonly<Record<string, FailureCopy>> = {
  "summariser-unconfigured": {
    reason: "the summariser isn't set up",
    nextStep:
      "Store an Anthropic API key in the macOS keychain with the research key setup script, then press Run now.",
  },
  "summariser-failed": {
    reason: "the summariser didn't return a complete answer",
    nextStep: "Press Run now to try again. Nothing was added to the report list.",
  },
  "summariser-refused": {
    reason: "the summariser declined to summarise these sources",
    nextStep: "Press Run now to try again later. If it keeps happening, check the source list.",
  },
  "summariser-invalid-output": {
    reason: "the summariser's answer wasn't in the expected form",
    nextStep: "Press Run now to try again. Nothing was added to the report list.",
  },
  "all-sources-failed": {
    reason: "no source could be fetched",
    nextStep: "Check your network connection, then press Run now.",
  },
  "vault-write-failed": {
    reason: "the report couldn't be written to the vault",
    nextStep: "Check the vault in Settings → Diagnostics, then press Run now.",
  },
  interrupted: {
    reason: null,
    nextStep:
      "The app stopped during this run, so its result is unknown. Press Run now for a new run.",
  },
};

/** The reason and next step of a run error code; an unknown code gets the forward-compatible default. */
export function failureCopy(code: string): FailureCopy {
  return Object.hasOwn(FAILURE_COPY, code) ? (FAILURE_COPY[code] as FailureCopy) : UNKNOWN_FAILURE;
}

/** False for `interrupted`, which is an Unknown run and never a failure. */
export function isFailureCode(code: string): boolean {
  return failureCopy(code).reason !== null;
}

/** `Research run failed: the summariser isn't set up.` */
export function runFailedLine(code: string): string {
  return `Research run failed: ${failureCopy(code).reason ?? UNKNOWN_FAILURE.reason}.`;
}

/** Why a press the service refused did not start a run: fixed sentences by closed client code. */
export function startFailedLine(code: string): string {
  switch (code) {
    case "service-disconnected":
      return "Couldn't start the run: the companion service isn't running.";
    case "vault-not-set-up":
      return "Couldn't start the run: the vault isn't set up yet. Set it up in Settings, then press Run now.";
    default:
      return "Couldn't start the run. Check the service in Settings → Diagnostics, then press Run now.";
  }
}

// ---------------------------------------------------------------------------
// R3 report list

export const EMPTY_REPORTS_HEADING = "No reports yet";
export const EMPTY_NEVER_RUN =
  "Press Run now to fetch the configured sources and write your first cited report.";
export const EMPTY_ALL_FAILED = "No run has produced a report yet. The last failed run says why.";
export const LOADING_REPORTS = "Loading research reports";
export const LOAD_ERROR_HEADING = "Couldn't load research reports.";
export const LOAD_ERROR_HELP = "Check the service in Settings → Diagnostics, then refresh.";
export const REFRESH_REPORTS_LABEL = "Refresh reports";
export const SHOW_MORE_LABEL = "Show 25 more";
export const UNREADABLE_TITLE = "Unreadable report";
export const UNREADABLE_META = "Its metadata couldn't be read.";
export const OPEN_NOTE_LABEL = "Open note";
export const OPEN_NOTE_FAILED = "Couldn't open the note.";

/** `Couldn't refresh the report list. Showing what was loaded 5 minutes ago.` */
export function refreshFailedLine(relative: string): string {
  return `Couldn't refresh the report list. Showing what was loaded ${relative}.`;
}

/** `25 more reports loaded.` (announced once, after the owner asked for them). */
export function moreLoadedLine(count: number): string {
  return count === 1 ? "1 more report loaded." : `${count} more reports loaded.`;
}

/** The tail of the Partial badge's accessible name: `2 sources didn't respond`. */
export function partialRowTail(unavailable: number): string {
  const noun = unavailable === 1 ? "source" : "sources";
  return `${unavailable} ${noun} didn't respond`;
}

// ---------------------------------------------------------------------------
// R4 report reader: display caps (UI-SPEC "Untrusted content rules" 4) and the finding strings

/** A finding's text is capped at the schema cap. */
export const FINDING_TEXT_MAX = 600;
/** A quote is capped at the schema cap. */
export const QUOTE_TEXT_MAX = 240;
/** A citation button shows at most this much of the source title (the full title is in `title`). */
export const CITATION_TITLE_MAX = 60;

/** An author is capped at the schema cap. */
export const AUTHOR_MAX = 120;
/** An unavailable-source label is capped at the allowlist label cap. */
export const UNAVAILABLE_LABEL_MAX = 80;

/** The most characters of a report's title the reader shows (the schema's own cap). */
export const REPORT_TITLE_MAX = 200;

export const CITATIONS_LABEL = "Sources:";
export const NO_SOURCE_CITED = "No source cited";

/**
 * The downgrade marker (plan 07-15): the report note stored a quote for this finding, but the
 * service's check against the saved source did not confirm it, so the quote is withheld and the
 * finding reads as the summariser's own inference. Fixed copy, never built from the finding.
 */
export const QUOTE_UNVERIFIED_NOTE =
  "The saved quote couldn't be checked against its source, so it isn't shown.";

/** The hidden prefix that names a finding's kind first: `Finding 2, Source claim:`. */
export function findingPrefix(index: number, kindLabel: string): string {
  return `Finding ${index}, ${kindLabel}:`;
}

/** The caption above a quote: `Quoted from source 2`. */
export function quoteCaption(sourceNumber: number): string {
  return `Quoted from source ${sourceNumber}`;
}

/** The accessible name of a citation button: `Source 2: Sample runtime releases`. */
export function citationName(sourceNumber: number, title: string): string {
  return `Source ${sourceNumber}: ${title}`;
}

/** The tertiary button on a cited source: `Back to finding 3`. */
export function backToFindingLabel(index: number): string {
  return `Back to finding ${index}`;
}

/** A source title is capped at the schema cap. */
export const SOURCE_TITLE_MAX = 200;

// ---------------------------------------------------------------------------
// R4 report reader: section headings, header lines, source fields, states

export const READER_LEGEND_HEADING = "How to read this report";
export const READER_FINDINGS_HEADING = "Findings";
export const READER_UNAVAILABLE_HEADING = "Unavailable sources";
export const READER_SOURCES_HEADING = "Sources";
export const READER_RUN_HEADING = "Run record";

export const BACK_TO_REPORTS_LABEL = "Back to reports";
export const OPEN_RUN_NOTE_LABEL = "Open run note";
export const OPEN_RUN_NOTE_FAILED = "Couldn't open the run note.";
export const TRY_AGAIN_LABEL = "Try again";
export const LOAD_REST_LABEL = "Load the rest of the report";
export const LOAD_REST_ERROR = "Couldn't load the rest of this report.";

export const READER_LOADING = "Loading report";
export const READER_ERROR = "Couldn't load this report.";
export const NOT_FOUND_HEADING = "That report isn't in the vault any more.";
export const NOT_FOUND_BODY = "It may have been moved or deleted. The list has been refreshed.";
export const UNREADABLE_HEADING = "This report's metadata couldn't be read.";
export const UNREADABLE_BODY = "It may have been edited by hand. Open the note to check it.";
export const NO_FINDINGS =
  "This report has no findings. Nothing in the summariser's answer could be kept.";
export const SECTION_NOT_LOADED_OFFLINE =
  "This section couldn't be loaded while the companion service isn't running.";
/** A citation was activated before its source's page landed. */
export const SOURCE_NOT_LOADED = "That source isn't loaded yet.";
/** The service trimmed a page to stay under the socket cap. */
export const TRUNCATED_ITEMS =
  "Some items were too long to show here. Open the note to read them in full.";

export const NOT_PROVIDED = "Not provided";
/** The run store no longer holds a value (a missing value is said, never invented). */
export const NOT_RECORDED = "Not recorded";

// The AI line (ADR-0020 `aiGenerated`, `confidence: unverified`).
export const AI_LINE_LEAD = "AI-generated summary by ";
export const AI_LINE_TAIL = ". Not verified by a person.";
export const EXTRACTIVE_SUMMARISER_TEXT = "the extractive summariser (no model)";

/** The stale line; the hours come from the shared stale-threshold constant. */
export function staleLine(hours: number): string {
  return `This report is more than ${hours} hours old. Press Run now for a fresh one.`;
}

/** `Partial — 2 of 6 sources were unavailable, so this report covers only the rest.` */
export function partialIntro(unavailable: number, total: number): string {
  const verb = unavailable === 1 ? "was" : "were";
  return `Partial \u2014 ${unavailable} of ${total} sources ${verb} unavailable, so this report covers only the rest.`;
}

/** `1 reported fact · 2 source claims · 0 model inferences`: zero segments are kept. */
export function kindCountsText(counts: {
  readonly "source-fact": number;
  readonly "unverified-claim": number;
  readonly inference: number;
}): string {
  return [
    countOf(counts["source-fact"], "reported fact", "reported facts"),
    countOf(counts["unverified-claim"], "source claim", "source claims"),
    countOf(counts.inference, "model inference", "model inferences"),
  ].join(" \u00b7 ");
}

// Source entries (RSRCH-03, R-10, R-11).
export const COPY_ADDRESS_LABEL = "Copy address";
export const OPEN_SNAPSHOT_LABEL = "Open snapshot";
export const ADDRESS_COPIED = "Address copied.";
export const ADDRESS_COPY_FAILED = "Couldn't copy the address.";
export const REMOVED_BEFORE_SUMMARISING = "Removed before summarising";
export const NOTHING_REMOVED = "Nothing removed";

/** The `dt` terms of a source entry, in the contracted order. */
export const SOURCE_FIELD_LABELS = {
  type: "Type",
  access: "Access",
  address: "Address",
  author: "Author",
  published: "Published",
  retrieved: "Retrieved",
  contentHash: "Content hash",
  stableId: "Stable ID",
  snapshot: "Snapshot",
  removed: REMOVED_BEFORE_SUMMARISING,
} as const;

/** The `dt` terms of the run record. */
export const RUN_FIELD_LABELS = {
  run: "Run",
  started: "Started",
  finished: "Finished",
  outcome: "Outcome",
  summariser: "Summariser",
} as const;

const REMOVED_NOUNS: Readonly<Record<SanitiseCountKey, readonly [string, string]>> = {
  scripts: ["script", "scripts"],
  styles: ["style block", "style blocks"],
  comments: ["comment", "comments"],
  hiddenBlocks: ["hidden block", "hidden blocks"],
  mediaDropped: ["media item", "media items"],
  linksDropped: ["link", "links"],
  controlChars: ["control character", "control characters"],
  commandLikeLines: ["command-like line", "command-like lines"],
};

/**
 * What the sanitiser removed from a source, as one sentence in a fixed order with zero counts
 * left out: `2 scripts, 1 hidden block, 3 links, 1 command-like line`; `Nothing removed` when
 * every count is zero (SC4 "described").
 */
export function removedSentence(counts: SanitiseCounts): string {
  const parts: string[] = [];
  for (const key of SANITISE_COUNT_KEYS) {
    const count = counts[key];
    if (count > 0) parts.push(countOf(count, REMOVED_NOUNS[key][0], REMOVED_NOUNS[key][1]));
  }
  return parts.length === 0 ? NOTHING_REMOVED : parts.join(", ");
}
