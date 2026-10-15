import type { ResearchStage } from "@ccc/domain/research.js";

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
