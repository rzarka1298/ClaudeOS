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
  REPORT_READY_UNTITLED,
  reportReadyLine,
  reportReadyWithGapsLine,
  STATUS_ALREADY_RUNNING,
  STATUS_STARTED,
  STATUS_STARTING,
  STATUS_TIMEOUT_CHECKING,
  STATUS_TIMEOUT_NOT_STARTED,
  STATUS_TIMEOUT_NOTICE,
  STATUS_TIMEOUT_STARTED,
  STATUS_UNKNOWN_END,
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

/** The one polite status line of the destination. */
export const statusLine: Signal<string> = signal("");
/** True from the press until the service has answered (or the timeout path has ended). */
export const pressPending: Signal<boolean> = signal(false);
/** The run this plugin session started and is waiting for, or null. */
export const activeRunId: Signal<string | null> = signal(null);
/** The report the owner opened, or null. There is no default selection. */
export const selectedNoteId: Signal<string | null> = signal(null);

let statusSeq = 0;
let listSeq = 0;
let activeMisses = 0;
let activeRunIsOwn = false;

/** Puts every signal back to what a fresh mount sees. */
export function resetResearchState(): void {
  researchStatus.value = null;
  statusFailure.value = null;
  reportRows.value = [];
  reportsCursor.value = null;
  reportsLoaded.value = false;
  reportsFailure.value = null;
  reportsGeneration.value = 0;
  statusLine.value = "";
  pressPending.value = false;
  activeRunId.value = null;
  selectedNoteId.value = null;
  statusSeq += 1;
  listSeq += 1;
  activeMisses = 0;
  activeRunIsOwn = false;
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

export async function refreshStatus(): Promise<void> {
  const token = ++statusSeq;
  try {
    const status = await researchApi().status();
    if (token !== statusSeq) return;
    researchStatus.value = status;
    statusFailure.value = null;
    await settleActiveRun(status);
  } catch (error) {
    if (token !== statusSeq) return;
    statusFailure.value = codeOf(error);
  }
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

async function conclude(ended: EndedRun, status: ResearchStatusResponse): Promise<void> {
  const ports = researchPorts();
  if (ended.kind === "unknown") {
    statusLine.value = STATUS_UNKNOWN_END;
    return;
  }
  if (ended.kind === "failure") return;
  const success = status.lastSuccess;
  if (success === null) return;
  await refreshList();
  let line: string;
  if (success.outcome === "partial") {
    line = reportReadyWithGapsLine(success.sourceTotal - success.sourceCount, success.sourceTotal);
  } else {
    const row = reportRows.value.find(
      (candidate) => candidate.readable && candidate.noteId === success.reportNoteId,
    );
    line = row?.readable === true ? reportReadyLine(row.title) : REPORT_READY_UNTITLED;
  }
  statusLine.value = line;
  ports.notify(line);
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

async function afterStartUncertain(): Promise<void> {
  statusLine.value = STATUS_TIMEOUT_CHECKING;
  await refreshStatus();
  const inFlight = researchStatus.value?.inFlight ?? null;
  if (inFlight !== null) {
    startedRun(inFlight.runId);
    statusLine.value = STATUS_TIMEOUT_STARTED;
  } else {
    statusLine.value = STATUS_TIMEOUT_NOT_STARTED;
  }
  pressPending.value = false;
}

/**
 * Presses Run now. Busy state is set before any await; a second activation
 * while pending or running is ignored (D-19); the 5-second transport timeout
 * reports, refetches the status and ends in an honest sentence (UI-SPEC E1).
 */
export async function pressRunNow(): Promise<void> {
  if (pressPending.value || runInProgress()) return;
  pressPending.value = true;
  statusLine.value = STATUS_STARTING;
  let response: ResearchRunResponse;
  try {
    response = await raceTimeout(researchApi().run(), RUN_START_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof StartTimeout || codeOf(error) === "timeout") {
      researchPorts().notify(STATUS_TIMEOUT_NOTICE);
      await afterStartUncertain();
      return;
    }
    statusLine.value = "";
    pressPending.value = false;
    statusFailure.value = codeOf(error);
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
