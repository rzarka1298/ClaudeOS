import type { CodexTokenCounters } from "@ccc/domain/codex-sessions.js";
import {
  CODEX_RESERVE_PERCENT,
  CODEX_USAGE_STALE_MAX_AGE_MS,
  CODEX_WEEKLY_WINDOW_MINUTES,
  type CodexHeadroomReason,
  type CodexHeadroomVerdict,
  type CodexUsageSnapshot,
  type CodexUsageUnavailableReason,
  type CodexUsageWindow,
} from "@ccc/domain/codex-usage.js";
import {
  formatCompactTokens,
  formatMonthDay,
  formatPercentUsed,
  formatTimeOfDay,
} from "./usage-format.js";

/** UI-SPEC copy, shared by the Codex card and settings. Payloads never supply prose. */
export const CODEX_COPY = Object.freeze({
  cardTitle: "Codex sessions and usage",
  headroomHeading: "Headroom",
  planUsageHeading: "Plan usage",
  currentRunHeading: "Current run",
  recentSessionsHeading: "Recent sessions",
  tokenActivityHeading: "Token activity",
  headroomFooter: "Read-only. This app never starts Codex work on its own.",
  reserveUnder: "Under the 80% reserve line",
  reserveOver: "At or over the 80% reserve line",
  reserveLegend: "80% reserve line",
  fallbackSource: "From Codex session log · {age} old",
  fallbackNote: "Not a live read.",
  setupHeading: "Codex isn't set up",
  setupBody:
    "Install Codex on this Mac and add it in Settings → Launchers. Codex sessions and weekly usage appear here once it has run.",
  setupButton: "Set up Codex",
  analysisHeading: "Transcript analysis is off",
  analysisButton: "Turn on transcript analysis",
  analysisBody:
    "Codex token activity is counted from Codex's local session logs, only after you turn this on. Only counts are kept — never prompts, replies or file contents.",
  tokenExplanation:
    "Tokens Codex reported in its local session logs. This is separate from your plan usage above.",
  tokenSourceNote: "Latest running total per session, never summed twice.",
  usageUnavailable: "Codex usage unavailable",
  usageReadFailed:
    "Codex didn't answer the usage read. It tries again about once a minute while this card is open.",
  usageShapeChanged: "The usage reply from {version} isn't in a format this build recognises.",
  usageNoLimits: "Your Codex sign-in doesn't report plan limits.",
  usageTooOld: "The last usage read is too old to trust.",
  sessionsUnavailable: "Codex sessions unavailable",
  sessionsShapeChanged:
    "The Codex data format changed in {version}, so sessions are hidden rather than shown wrong.",
  tokenUnavailable: "Token activity unavailable",
  tokenShapeChanged: "The session log format changed in {version}.",
  unknownSessionNote:
    "Unknown means no end event arrived and Codex reports no process to check, so it is shown as unknown rather than guessed.",
  hookNotInstalledNote:
    "Live status for interactive sessions needs the optional Codex hook package. Settings → Codex has the install step.",
  analysisOffNote: "Session titles and previews stay hidden until transcript analysis is on.",
  noCurrentRun: "No Codex run in progress.",
  noSessions: "No Codex sessions yet",
  noRecentSessions: "No Codex sessions in the last 7 days.",
  startSession: "Start one with Claude + Codex from a project, or run Codex in a terminal.",
  noTokenCoverage: "No Codex session logs cover this range.",
  headroomUnavailable: "Headroom unavailable",
  usageNotRead:
    "Codex usage hasn't been read yet. It's read about once a minute while this card is open.",
  claudeCapacityUnavailable: "Account capacity unavailable",
  reserveReason: "At or over the 80% reserve line.",
  usageNotAllowedReason: "Codex says ordinary usage isn't allowed right now.",
  pausedRunReason: "A paused run is waiting for its reset.",
  noLiveReadReason: "No live usage read yet.",
  usageUnavailableReason: "Usage is unavailable.",
  allowVerdict: "Has headroom",
  refuseVerdict: "Held back",
  cardDescription: "Codex runs, weekly usage and headroom beside Claude.",
  usageSource: "Codex app-server",
  tokenSource: "Codex session logs",
  sessionsSource: "Codex session records",
  headroomSource: "Claude and Codex usage reads",
  analysisSessionsAriaLabel: "Turn on transcript analysis for Codex session titles",
  analysisTokenAriaLabel: "Turn on transcript analysis for token activity",
  tokenRangeAriaLabel: "Codex token activity range",
  analysisFailure: "Couldn't turn on transcript analysis.",
  analysisRetry: "Check the service in Settings → Diagnostics, then try again.",
  tokenFirstScan: "Counting tokens from Codex session logs…",
  tokenAnalysisPartial: "Transcript analysis was off for part of this range.",
  tokenCoveragePartial: "Codex session logs only go back to {date}.",
  trackingHeading: "Codex tracking paused",
  trackingBody:
    "The Codex data on this Mac is in a format this build doesn't recognise, so it's hidden rather than shown wrong.",
});

const NUMBER = new Intl.NumberFormat("en");
const PLURAL = new Intl.PluralRules("en");
const VERSION_SHAPE = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;

export function formatCodexWindowLabel(minutes: number | null): string {
  if (minutes === null) return "Usage window";
  if (minutes === CODEX_WEEKLY_WINDOW_MINUTES) return "Weekly window · 10,080 min";
  return `${NUMBER.format(minutes)} min window`;
}

export function formatResetAt(iso: string, nowMs: number): string {
  return `${formatMonthDay(iso, nowMs)}, ${formatTimeOfDay(iso)}`;
}

/** At the reset boundary the caller drops the meter, tick and reserve state. */
export function codexWindowLine(
  window: CodexUsageWindow,
  nowMs: number,
): { readonly text: string; readonly outdated: boolean } {
  const percent = formatPercentUsed(window.usedPercent);
  if (window.resetsAt === null) return { text: percent, outdated: false };
  const when = formatResetAt(window.resetsAt, nowMs);
  const outdated = Date.parse(window.resetsAt) <= nowMs;
  return {
    text: outdated
      ? `${percent} before the ${when} reset · outdated`
      : `${percent} · resets ${when}`,
    outdated,
  };
}

const MS_PER_MINUTE = 60_000;

/**
 * How old an observation is, for the rollout fallback label: `under 1 min`,
 * `N min`, `N hr` or `N d`. A future stamp (a clock a little ahead) reads as
 * the youngest age rather than a negative one.
 */
export function formatCodexAge(iso: string, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(elapsed / MS_PER_MINUTE);
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${NUMBER.format(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${NUMBER.format(hours)} hr`;
  return `${NUMBER.format(Math.floor(hours / 24))} d`;
}

/** The source-and-age label of a rollout figure, e.g. `From Codex session log · 12 min old`. */
export function fallbackSourceLine(iso: string, nowMs: number): string {
  return CODEX_COPY.fallbackSource.replace("{age}", formatCodexAge(iso, nowMs));
}

/**
 * True for a rollout figure older than the stale max age. The service already
 * turns such a figure into an unavailable snapshot; the card re-checks against
 * its own clock so a pushed figure that ages on screen never stays a number.
 */
export function isFallbackTooOld(usage: CodexUsageSnapshot, nowMs: number): boolean {
  return (
    usage.kind === "available" &&
    usage.source === "rollout-fallback" &&
    nowMs - Date.parse(usage.observedAt) > CODEX_USAGE_STALE_MAX_AGE_MS
  );
}

export function reserveState(usedPercent: number): "under" | "over" {
  return usedPercent < CODEX_RESERVE_PERCENT ? "under" : "over";
}

const HEADROOM_REASON: Readonly<Record<CodexHeadroomReason, string>> = {
  "reserve-line": CODEX_COPY.reserveReason,
  "usage-not-allowed": CODEX_COPY.usageNotAllowedReason,
  "paused-run": CODEX_COPY.pausedRunReason,
  "no-live-read": CODEX_COPY.noLiveReadReason,
  "usage-unavailable": CODEX_COPY.usageUnavailableReason,
};

export function headroomReasonLine(reason: CodexHeadroomReason): string {
  return HEADROOM_REASON[reason];
}

export function verdictLabel(verdict: CodexHeadroomVerdict): string {
  return verdict === "allow" ? CODEX_COPY.allowVerdict : CODEX_COPY.refuseVerdict;
}

export function pausedRunsLine(
  count: number,
  resetAt: string | null,
  nowMs: number,
): string | null {
  if (count === 0) return null;
  const noun = PLURAL.select(count) === "one" ? "run" : "runs";
  const resume =
    resetAt === null
      ? "Reset time not reported."
      : `Earliest resume: ${formatResetAt(resetAt, nowMs)}.`;
  return `${NUMBER.format(count)} ${noun} paused by the usage limit. ${resume}`;
}

function codexVersion(version: string | null): string {
  return version !== null && VERSION_SHAPE.test(version)
    ? `Codex ${version}`
    : "Your Codex version";
}

export function unavailableUsageBody(
  reason: CodexUsageUnavailableReason,
  version: string | null = null,
): string {
  switch (reason) {
    case "read-failed":
      return CODEX_COPY.usageReadFailed;
    case "shape-changed":
      return CODEX_COPY.usageShapeChanged.replace("{version}", codexVersion(version));
    case "no-limits":
      return CODEX_COPY.usageNoLimits;
    case "too-old":
      return CODEX_COPY.usageTooOld;
  }
}

export function moreSessionsLine(count: number): string {
  const one = PLURAL.select(count) === "one";
  return `${NUMBER.format(count)} more ${one ? "session isn't" : "sessions aren't"} shown.`;
}

export function formatTokenBreakdown(counters: CodexTokenCounters): string {
  return `Input ${formatCompactTokens(counters.input)} · cached input ${formatCompactTokens(counters.cachedInput)} · cache write ${formatCompactTokens(counters.cacheWrite)} · output ${formatCompactTokens(counters.output)} · reasoning output ${formatCompactTokens(counters.reasoningOutput)}`;
}

/** Additive row vocabulary; the plan 12 table remains unchanged. */
export const CODEX_ROW_COPY = Object.freeze({
  openTranscript: "Open transcript",
  followLog: "Follow live log",
  transcriptMissing: "Transcript not found",
  unclassified: "Unclassified",
  sessionFallback: "Session {id}",
  openTranscriptName: "Open transcript for {name}",
  followLogName: "Follow live log for {name}",
  effort: "{effort} effort",
  started: "started {relative}",
  active: "active {relative}",
  elapsed: "elapsed {duration}",
  staleElapsed: "At least {duration}",
  resumesAfter: "resumes after {time}",
  resetUnreported: "reset time not reported",
  sessionsSourceSuffix: "for recent sessions",
  tokenSourceSuffix: "for token activity",
  sessionsCount: "{count} sessions",
  sessionsRange: "Last seven days",
  partial: "Partial",
});
export const CODEX_COUNTER_LABELS = Object.freeze({
  input: "Input",
  cachedInput: "Cached input",
  cacheWrite: "Cache write",
  output: "Output",
  reasoningOutput: "Reasoning output",
  total: "Total",
});
export function codexChangedBody(template: string, version: string | null): string {
  return template.replace("{version}", codexVersion(version));
}
