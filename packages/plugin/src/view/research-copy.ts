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
