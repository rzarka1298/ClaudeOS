import type {
  ResearchErrorCode,
  ResearchListResponse,
  ResearchListRow,
  ResearchRunResponse,
  ResearchStatusResponse,
  ResearchUpdatedPayload,
} from "@ccc/domain/research-routes.js";
import { type Signal, signal } from "@preact/signals";
import {
  moreLoadedLine,
  REPORT_READY_UNTITLED,
  reportReadyLine,
  reportReadyWithGapsLine,
  runFailedLine,
  STATUS_ALREADY_RUNNING,
  STATUS_STARTED,
  STATUS_STARTING,
  STATUS_TIMEOUT_CHECKING,
  STATUS_TIMEOUT_NOT_STARTED,
  STATUS_TIMEOUT_NOTICE,
  STATUS_TIMEOUT_STARTED,
  STATUS_TIMEOUT_UNKNOWN,
  STATUS_UNKNOWN_END,
  startFailedLine,
} from "../view/research-copy.js";
import { ResearchApiError, researchApi, researchPorts } from "./api.js";

/**
 * The Research destination's in-memory state (plan 07-11; UI-SPEC R1, R2, R3).
 * Signals for the status, the report list, the Run now press and the one polite
 * status line, and the actions that move them. Nothing here is persisted, and
 * nothing here imports `obsidian` or the service client: the API and the host
 * ports are reached only through the holder in `api.ts`.
 *
 * Honesty rules (UI-SPEC Non-Negotiable 5): a run the service cannot account
 * for is `Unknown`, never an invented outcome; a failed refresh keeps the
 * last-good values and records only a closed error code.
 */

/** The transport timeout of the Run now press (UI-SPEC R2). */
export const RUN_START_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Signals

export const researchStatus: Signal<ResearchStatusResponse | null> = signal(null);
/** The closed code of the last failed status fetch, or null after a good one. */
export const statusFailure: Signal<ResearchErrorCode | null> = signal(null);

export const reportRows: Signal<readonly ResearchListRow[]> = signal([]);
export const reportsCursor: Signal<string | null> = signal(null);
/** True once a list fetch has succeeded at least once. */
export const reportsLoaded: Signal<boolean> = signal(false);
export const reportsFailure: Signal<ResearchErrorCode | null> = signal(null);
/** Counts good list loads, so a container can stamp when the rows were last good. */
export const reportsGeneration: Signal<number> = signal(0);

/** True while the next page of the list is loading. */
export const reportsLoadingMore: Signal<boolean> = signal(false);
/**
 * The row to focus: a readable row by note id, an unreadable one by note path. Named rather than
 * counted, so unreadable rows (which have no row button) cannot shift which row is meant.
 */
export type ReportFocusTarget =
  | { readonly kind: "report"; readonly noteId: string }
  | { readonly kind: "unreadable"; readonly notePath: string };

/**
 * The first newly loaded row after "Show 25 more", until the list has handled the request
 * (UI-SPEC R3). A refresh from an event never sets it, so focus stays where it was.
 */
export const focusRequest: Signal<ReportFocusTarget | null> = signal(null);

function focusTargetOf(row: ResearchListRow): ReportFocusTarget {
  return row.readable
    ? { kind: "report", noteId: row.noteId }
    : { kind: "unreadable", notePath: row.notePath };
}

/** The one polite status line of the destination. */
export const statusLine: Signal<string> = signal("");
/** True from the press until the service has answered (or the timeout path has ended). */
export const pressPending: Signal<boolean> = signal(false);
/** The run this plugin session started and is waiting for, or null. */
export const activeRunId: Signal<string | null> = signal(null);
/** The report the owner opened, or null. There is no default selection. */
export const selectedNoteId: Signal<string | null> = signal(null);

/** How many mounted Research destinations there are (two leaves may show Research at once). */
let openMounts = 0;

/**
 * Registers one mounted Research destination and returns the function that unregisters it (safe
 * to call twice). The `research.updated` handler refreshes while any mount is open; only when the
 * last one closes is the shared state put back, so closing one leaf never blanks or deafens
 * another (wave 5 review, Codex 3). The run this session started stays tracked across that reset,
 * so its outcome can still be told to the owner who navigated away.
 */
export function openResearchView(): () => void {
  openMounts += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openMounts = Math.max(0, openMounts - 1);
    if (openMounts === 0) resetResearchState({ keepOwnRun: true });
  };
}

/** True while at least one Research destination is mounted. */
export function researchViewOpen(): boolean {
  return openMounts > 0;
}

let statusSeq = 0;
let listSeq = 0;
let activeMisses = 0;
let activeRunIsOwn = false;

/**
 * Puts every signal back to what a fresh mount sees. With `keepOwnRun`, a run this session started
 * and is still waiting for keeps being tracked (its id, its misses and the fact that it is ours):
 * the owner may have left the destination, and the run's end is still theirs to be told.
 */
export function resetResearchState(options: { readonly keepOwnRun?: boolean } = {}): void {
  const keep = options.keepOwnRun === true && activeRunIsOwn && activeRunId.value !== null;
  researchStatus.value = null;
  statusFailure.value = null;
  reportRows.value = [];
  reportsCursor.value = null;
  reportsLoaded.value = false;
  reportsFailure.value = null;
  reportsGeneration.value = 0;
  reportsLoadingMore.value = false;
  focusRequest.value = null;
  statusLine.value = "";
  pressPending.value = false;
  selectedNoteId.value = null;
  statusSeq += 1;
  listSeq += 1;
  clearClaim();
  if (keep) return;
  activeRunId.value = null;
  activeMisses = 0;
  activeRunIsOwn = false;
}

/** Sets the destination's one polite status line. */
export function setStatusLine(message: string): void {
  statusLine.value = message;
}

/** Called by the list once it has handled the request (focused the row, or found none to focus). */
export function clearFocusRequest(): void {
  focusRequest.value = null;
}

export function selectReport(noteId: string | null): void {
  selectedNoteId.value = noteId;
}

// ---------------------------------------------------------------------------
// Helpers

function codeOf(error: unknown): ResearchErrorCode {
  return error instanceof ResearchApiError ? error.code : "unrecognised-response";
}

class StartTimeout extends Error {
  constructor() {
    super("timeout");
    this.name = "StartTimeout";
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new StartTimeout()), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("research request failed"));
      },
    );
  });
}

/** True while a run is known to be in flight: ours, or one the status reports. */
export function runInProgress(): boolean {
  return activeRunId.value !== null || researchStatus.value?.inFlight != null;
}

// ---------------------------------------------------------------------------
// Loading

/** How a status refresh ended: its answer was applied, it failed, or a newer refresh replaced it. */
type StatusRefresh = "applied" | "failed" | "superseded";

async function reconcileStatus(): Promise<StatusRefresh> {
  const token = ++statusSeq;
  try {
    const status = await researchApi().status();
    if (token !== statusSeq) return "superseded";
    researchStatus.value = status;
    statusFailure.value = null;
    await settleActiveRun(status);
    return "applied";
  } catch (error) {
    if (token !== statusSeq) return "superseded";
    statusFailure.value = codeOf(error);
    return "failed";
  }
}

export async function refreshStatus(): Promise<void> {
  await reconcileStatus();
}

function applyList(response: ResearchListResponse, append: boolean): void {
  reportRows.value = append ? [...reportRows.value, ...response.rows] : response.rows;
  reportsCursor.value = response.nextCursor;
  reportsLoaded.value = true;
  reportsFailure.value = null;
  reportsGeneration.value += 1;
}

/** Reloads the first page; the rows already loaded stay until the answer lands. */
export async function refreshList(): Promise<void> {
  const token = ++listSeq;
  try {
    const response = await researchApi().list(undefined);
    if (token !== listSeq) return;
    applyList(response, false);
  } catch (error) {
    if (token !== listSeq) return;
    reportsFailure.value = codeOf(error);
  }
}

/** Loads the next page and appends it; the rows already loaded and the cursor stay on a failure. */
export async function loadMoreReports(): Promise<void> {
  const cursor = reportsCursor.value;
  if (cursor === null || reportsLoadingMore.value) return;
  reportsLoadingMore.value = true;
  const token = ++listSeq;
  try {
    const response = await researchApi().list(cursor);
    if (token !== listSeq) return;
    applyList(response, true);
    const firstNew = response.rows[0];
    if (firstNew !== undefined) {
      focusRequest.value = focusTargetOf(firstNew);
      statusLine.value = moreLoadedLine(response.rows.length);
    }
  } catch (error) {
    if (token !== listSeq) return;
    reportsFailure.value = codeOf(error);
  } finally {
    reportsLoadingMore.value = false;
  }
}

export async function loadResearch(): Promise<void> {
  await Promise.all([refreshStatus(), refreshList()]);
}

// ---------------------------------------------------------------------------
// The run this session started

type EndedRun =
  | { readonly kind: "success"; readonly status: ResearchStatusResponse }
  | { readonly kind: "unknown" }
  | { readonly kind: "failure" };

function endedRun(status: ResearchStatusResponse, runId: string): EndedRun | undefined {
  if (status.lastSuccess?.runId === runId) return { kind: "success", status };
  if (status.lastFailure?.runId === runId) return { kind: "failure" };
  if (status.latestUnknown?.runId === runId) return { kind: "unknown" };
  return undefined;
}

/**
 * Tells the owner how their run ended: the status line and a Notice. With the destination closed
 * the settle is status-only: the Notice is posted and nothing else is touched or fetched (no list,
 * no status line, no focus), because nobody is looking at them and the next mount fetches afresh.
 */
async function conclude(ended: EndedRun, status: ResearchStatusResponse): Promise<void> {
  const ports = researchPorts();
  const open = researchViewOpen();
  const say = (line: string, notice: boolean): void => {
    if (open) statusLine.value = line;
    if (notice) ports.notify(line);
  };
  if (ended.kind === "unknown") {
    say(STATUS_UNKNOWN_END, false);
    return;
  }
  if (ended.kind === "failure") {
    const failed = status.lastFailure;
    if (failed === null) return;
    say(runFailedLine(failed.errorCode), true);
    return;
  }
  const success = status.lastSuccess;
  if (success === null) return;
  if (open) await refreshList();
  let line: string;
  if (success.outcome === "partial") {
    line = reportReadyWithGapsLine(success.sourceTotal - success.sourceCount, success.sourceTotal);
  } else {
    const row = open
      ? reportRows.value.find(
          (candidate) => candidate.readable && candidate.noteId === success.reportNoteId,
        )
      : undefined;
    line = row?.readable === true ? reportReadyLine(row.title) : REPORT_READY_UNTITLED;
  }
  say(line, true);
}

async function settleActiveRun(status: ResearchStatusResponse): Promise<void> {
  const runId = activeRunId.value;
  if (runId === null) return;
  if (status.inFlight?.runId === runId) {
    activeMisses = 0;
    return;
  }
  const ended = endedRun(status, runId);
  if (ended === undefined) {
    // The service has not accounted for the run yet. Wait one more refresh, then stop
    // waiting so a lost run can never lock the button for good.
    activeMisses += 1;
    if (activeMisses >= 2) {
      activeRunId.value = null;
      activeMisses = 0;
    }
    return;
  }
  const own = activeRunIsOwn;
  activeRunId.value = null;
  activeMisses = 0;
  activeRunIsOwn = false;
  if (own) await conclude(ended, status);
}

// ---------------------------------------------------------------------------
// Run now

function startedRun(runId: string): void {
  activeRunId.value = runId;
  activeRunIsOwn = true;
  activeMisses = 0;
}

/** The run ids of the terminal records a status holds, in a fixed order. */
function recordIds(status: ResearchStatusResponse): readonly string[] {
  return [status.lastSuccess?.runId, status.lastFailure?.runId, status.latestUnknown?.runId].filter(
    (id): id is string => id !== undefined,
  );
}

/**
 * True when the status holds a terminal record the status known at the press did not: a run began
 * and ended meanwhile, so "it didn't start" cannot be said. With no status known at the press
 * (never loaded) every record counts as new. No clock is read: the comparison is by run id.
 */
function newRecordSince(
  status: ResearchStatusResponse,
  known: ResearchStatusResponse | null,
): boolean {
  const before = new Set(known === null ? [] : recordIds(known));
  return recordIds(status).some((id) => !before.has(id));
}

/**
 * The start request timed out: ask the service what happened. "It didn't start" is said only when
 * the status was fetched, shows nothing in flight and holds no terminal record the status known at the
 * press lacked. When the status cannot be reconciled, the outcome stays unknown and nothing is claimed.
 */
async function afterStartUncertain(knownAtPress: ResearchStatusResponse | null): Promise<void> {
  statusLine.value = STATUS_TIMEOUT_CHECKING;
  const refresh = await reconcileStatus();
  const status = researchStatus.value;
  const inFlight = status?.inFlight ?? null;
  if (inFlight !== null) {
    startedRun(inFlight.runId);
    statusLine.value = STATUS_TIMEOUT_STARTED;
  } else if (refresh === "applied" && status !== null && !newRecordSince(status, knownAtPress)) {
    statusLine.value = STATUS_TIMEOUT_NOT_STARTED;
  } else {
    statusLine.value = STATUS_TIMEOUT_UNKNOWN;
  }
  pressPending.value = false;
}

/** The timer that releases a view-side claim the host never turned into a press. */
let claimWatchdog: number | undefined;

function clearClaim(): boolean {
  if (claimWatchdog === undefined) return false;
  window.clearTimeout(claimWatchdog);
  claimWatchdog = undefined;
  return true;
}

/**
 * Claims the Run now press synchronously, in the click itself, before the host port is asked: the
 * button is busy and a second activation is refused even when the port answers later (D-19, G5).
 * Returns false when a press or a run is already under way. `pressRunNow` consumes the claim; a
 * claim the host never consumes is released when the port settles badly or after the start timeout.
 */
export function claimRunNowPress(): boolean {
  if (pressPending.value || runInProgress()) return false;
  pressPending.value = true;
  statusLine.value = STATUS_STARTING;
  claimWatchdog = window.setTimeout(releaseRunNowClaim, RUN_START_TIMEOUT_MS);
  return true;
}

/** Gives back a claim that no press consumed; a claim already consumed is left alone. */
export function releaseRunNowClaim(): void {
  if (!clearClaim()) return;
  pressPending.value = false;
  if (statusLine.value === STATUS_STARTING) statusLine.value = "";
}

/**
 * Presses Run now. Busy state is set before any await (here, or earlier by `claimRunNowPress`); a
 * second activation while pending or running is ignored (D-19); the 5-second transport timeout
 * reports, refetches the status and ends in an honest sentence (UI-SPEC E1).
 */
export async function pressRunNow(): Promise<void> {
  if (!clearClaim()) {
    if (pressPending.value || runInProgress()) return;
    pressPending.value = true;
    statusLine.value = STATUS_STARTING;
  }
  const knownAtPress = researchStatus.value;
  let response: ResearchRunResponse;
  try {
    response = await raceTimeout(researchApi().run(), RUN_START_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof StartTimeout || codeOf(error) === "timeout") {
      researchPorts().notify(STATUS_TIMEOUT_NOTICE);
      await afterStartUncertain(knownAtPress);
      return;
    }
    const code = codeOf(error);
    const line = startFailedLine(code);
    statusLine.value = line;
    pressPending.value = false;
    researchPorts().notify(line);
    return;
  }
  if (response.alreadyRunning) {
    statusLine.value = STATUS_ALREADY_RUNNING;
  } else {
    startedRun(response.runId);
    statusLine.value = STATUS_STARTED;
  }
  pressPending.value = false;
  await refreshStatus();
}

/**
 * A run ended while no Research destination is open: if this session started it, find out how it
 * ended and tell the owner (a Notice), touching nothing else. Anything that is not a tracked own
 * run fetches nothing. A mount that opens while the status is in flight supersedes this settle and
 * does the telling itself, so the Notice is posted once either way.
 */
export async function settleOwnRunWhileClosed(): Promise<void> {
  if (!activeRunIsOwn || activeRunId.value === null) return;
  const token = ++statusSeq;
  try {
    const status = await researchApi().status();
    if (token !== statusSeq) return;
    await settleActiveRun(status);
  } catch {
    // The next event, or the next mount, asks again.
  }
}

/**
 * The `research.updated` handler (D-25), called by the wiring plan. The signal
 * is "ask again": the status is refetched on every event and the list too once
 * a run has ended.
 */
export async function onResearchUpdated(payload: ResearchUpdatedPayload): Promise<void> {
  await refreshStatus();
  const ended =
    payload.state === "completed" ||
    payload.state === "failed" ||
    payload.state === "cancelled" ||
    payload.state === "stale";
  if (ended) await refreshList();
}
