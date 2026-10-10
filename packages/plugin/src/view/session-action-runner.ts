import { type SessionView, sessionDisplayName } from "@ccc/domain/session.js";
import type {
  BranchResponse,
  FocusResponse,
  LaunchChoice,
  ResumeResponse,
  SessionActionErrorCode,
  TerminateRequestResponse,
  WorktreeListResponse,
} from "@ccc/domain/session-actions.js";
import { ClaudeRequestError, CodexRequestError } from "@ccc/service-api-client";
import { windowLaunchTimers } from "../projects/launch-client.js";
import type { LaunchTimerControls } from "../projects/launch-status.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { clearCodexActionStatus, setCodexActionStatus } from "./codex-action-status.js";
import {
  CODEX_FOLLOW_COPY,
  CODEX_TRANSCRIPT_COPY,
  type CodexActionCopy,
  type CodexFollowChoice,
  type CodexFollowWarningViewModel,
  type CodexReason,
  codexFollowWarningViewModel,
  codexReasonFor,
  codexTranscriptWarningViewModel,
} from "./codex-modals.js";
import { clearActionStatus, setActionStatus } from "./session-action-status.js";
import {
  type ConcurrentChoiceResolution,
  type ConcurrentChoiceViewModel,
  concurrentChoiceViewModel,
  type ProjectOption,
  type TerminateChoice,
  type TerminateRequestViewModel,
  type TranscriptChoice,
  type TranscriptWarningViewModel,
  terminateRequestViewModel,
  transcriptWarningViewModel,
  type WorktreeListResult,
} from "./session-modals.js";

/**
 * The single action runner for every `session:*` and `usage:*` quick-action
 * descriptor (D-36, UI-SPEC "Interaction contract — session controls"). One
 * function owns each control's modal flow (Tasks 2-3 extend it), the client
 * call, and the outcome copy: pending status is written synchronously,
 * before the first await, then the outcome or a fixed-vocabulary failure is
 * written and Notice'd (UI-SPEC "Feedback timing and copy", R-23). The
 * runner never throws -- every branch ends in a status write plus a Notice,
 * because it runs from a click handler with nowhere for a rejection to go
 * (the `runVaultSetup` precedent, setup-command.ts).
 */

/** Fallback session name when the Run isn't (yet) loaded into the signal store. */
const UNKNOWN_SESSION_NAME = "this session";

/** Used only when the service hasn't reported `cleanupPeriodDays` yet. */
const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

/**
 * The modal seam, in the {@link VaultSetupUi} shape (setup-command.ts):
 * production code touches Obsidian only through `createObsidianSessionActionUi`
 * (session-modals.ts); this module and its tests never import `obsidian`.
 * Task 3 adds the two remaining openers (transcript warning, terminate
 * request) this plan's other controls need.
 */
export interface SessionActionUi {
  /**
   * Shows a transient message to the user (an Obsidian `Notice` in
   * production). Declared as an arrow-typed property, not a method, so a
   * test's `expect(deps.ui.notify)` never trips
   * `@typescript-eslint/unbound-method` (same reason every opener below is).
   */
  readonly notify: (message: string) => void;
  /**
   * Opens the concurrent-session choice (S4-a), including its worktree step:
   * the ONE modal instance resolves once, whichever step it settles from.
   * `loadWorktrees` is called by the modal itself, lazily, only if the owner
   * picks "Use an isolated worktree" -- the modal never calls the client
   * directly.
   */
  readonly openConcurrentChoice: (
    vm: ConcurrentChoiceViewModel,
    loadWorktrees: () => Promise<WorktreeListResult>,
  ) => Promise<ConcurrentChoiceResolution>;
  /** Opens the associate-with-project picker (S4-e). `null` is a refusal (Escape, closed with no choice). */
  readonly openAssociatePicker: (
    sessionName: string,
    projects: readonly ProjectOption[],
  ) => Promise<ProjectOption | null>;
  /** Opens the transcript plaintext warning (S4-b) -- on EVERY press, never cached (SESS-15, D-34). */
  readonly openTranscriptWarning: (vm: TranscriptWarningViewModel) => Promise<TranscriptChoice>;
  /** Opens the force-terminate request (S4-c). There is no typed-confirmation shortcut (D-01). */
  readonly openTerminateRequest: (vm: TerminateRequestViewModel) => Promise<TerminateChoice>;
  /**
   * Opens the Codex transcript plaintext warning (05.1 UI-SPEC S3-a) -- on EVERY
   * press, never cached (D-29). Optional: a host that predates Codex omits it
   * and the Codex cases fall to the "isn't available yet" branch.
   */
  readonly openCodexTranscriptWarning?:
    | ((vm: TranscriptWarningViewModel) => Promise<TranscriptChoice>)
    | undefined;
  /** Opens the Codex follow-log warning (05.1 UI-SPEC S3-b) -- on EVERY press (D-29, R-16). */
  readonly openCodexFollowWarning?:
    | ((vm: CodexFollowWarningViewModel) => Promise<CodexFollowChoice>)
    | undefined;
}

/**
 * The Codex client calls the runner needs (plan 05.1-19). Loosely typed on
 * purpose, like {@link SessionActionRequestMap}: the real validation happens in
 * `@ccc/service-api-client`, where `command-center-view.ts` binds these. The
 * runner never imports the client's request functions.
 */
export interface CodexActionDeps {
  readonly openTranscript: (request: {
    threadId: string;
    via: "reveal" | "open";
  }) => Promise<unknown>;
  readonly followLog: (request: { runId: string }) => Promise<unknown>;
  /** The success auto-clear timers; production defaults to the window timers. */
  readonly timers?: LaunchTimerControls | undefined;
}

/**
 * The request/response shape for every action name the runner dispatches.
 * Requests are LOCAL, loosely-typed shapes (`runId: string`, not the
 * domain's branded `RunId`): this module never mints a `RunId`, only passes
 * through the plain string a descriptor's `target` already carries, and the
 * real validation happens where 05-17 wires this deps object to the actual
 * `requestSessionAction(client, action, body)` (service-api-client), which
 * parses every body against its own strict schema before it reaches the
 * wire. Responses keep the domain's own (read-only) shapes.
 */
export interface SessionActionRequestMap {
  focus: { request: { runId: string }; response: FocusResponse };
  resume: { request: { runId: string; choice?: LaunchChoice }; response: ResumeResponse };
  branch: { request: { runId: string; choice?: LaunchChoice }; response: BranchResponse };
  worktrees: { request: { runId: string }; response: WorktreeListResponse };
  associate: { request: { runId: string; projectId: string }; response: unknown };
  "open-transcript": { request: { runId: string; mode: "reveal" | "open" }; response: unknown };
  "terminate-request": { request: { runId: string }; response: TerminateRequestResponse };
}

/**
 * Everything the runner needs from outside its own module, injected so it is
 * testable without a real client, a real Obsidian modal, or a real signal
 * store. 05-17 wires the production values; this plan only builds the shape.
 */
export interface SessionActionDeps {
  requestSessionAction<K extends keyof SessionActionRequestMap>(
    action: K,
    body: SessionActionRequestMap[K]["request"],
  ): Promise<SessionActionRequestMap[K]["response"]>;
  /** Turns transcript analysis on or off (D-03). Task 3's only caller passes `true` -- a direct gesture, no confirmation. */
  setTranscriptAnalysis(enabled: boolean): Promise<unknown>;
  readonly ui: SessionActionUi;
  /** `null` when the Run is not (yet) loaded into the signal store. */
  getSession(runId: string): SessionView | null;
  /** `null` means "unknown" (before Phase 4's project registry is wired, PR-17) -- never treated as "zero projects". */
  listProjects(): readonly ProjectOption[] | null;
  /** `null` when the service hasn't reported it yet. */
  cleanupPeriodDays(): number | null;
  /** The Codex flows' client calls (plan 05.1-19). Absent means the Codex cases are unavailable. */
  readonly codex?: CodexActionDeps | undefined;
}

/**
 * The host-supplied half of {@link SessionActionDeps}: the client-bound
 * calls and the Obsidian modal seam. The shell adds the signal-derived
 * members (`getSession`, `listProjects`, `cleanupPeriodDays`) itself, so no
 * view code builds a client (05-17).
 */
export type SessionActionHost = Pick<
  SessionActionDeps,
  "requestSessionAction" | "setTranscriptAnalysis" | "ui" | "codex"
>;

/**
 * The UI-SPEC "Reason vocabulary (fixed)" plus every {@link SessionActionErrorCode}
 * this plan's routes can answer with, so a failure Notice never shows a raw
 * code. `transcript-missing` is interpolated with the actual retention
 * period by {@link reasonFor}.
 */
export const REASON_COPY: Record<SessionActionErrorCode | "unrecognised-response", string> = {
  "service-disconnected": "the service isn't running",
  timeout: "the companion service didn't respond within 5 seconds",
  "process-ended": "the session's process has ended",
  "terminal-unsupported": "this terminal app isn't supported for focusing",
  "background-session": "Claude Code isn't running in a terminal for this session",
  "automation-denied":
    "macOS blocked automation — allow it in System Settings → Privacy & Security → Automation",
  "transcript-missing":
    "the transcript is no longer on this Mac — Claude Code deletes transcripts after {n} days",
  "transcript-outside-root": "the transcript is outside Claude Code's projects folder",
  "project-missing": "the project's folder is missing",
  "launcher-not-configured": "no launcher is set up yet",
  "run-not-found": "this session is no longer tracked",
  "invalid-state": "this session's state changed before the request finished",
  "approval-unavailable": "needs approval — available once the approval inbox is ready",
  "project-not-registered": "that project isn't registered",
  "folder-access-denied": "the folder couldn't be accessed",
  "spawn-failed": "the terminal couldn't be started",
  "project-moved": "the project's folder has moved",
  "app-not-found": "the terminal app isn't installed",
  "action-failed": "the action failed unexpectedly — try again",
  "guard-unavailable":
    "couldn't check for other Claude sessions in this folder, so nothing was launched",
  "unrecognised-response": "the service sent a response this app doesn't recognise",
};

/**
 * The reason a failure Notice gives when a modal opener itself throws or
 * rejects (wave 5 review): the runner runs from a click handler with nowhere
 * for a rejection to go, so an opener failure is caught and reported like any
 * other failure -- never as a service reason, since no request was made.
 */
const MODAL_FAILED_REASON = "the dialog couldn't be opened";

/** Distinguishes an opener that failed from every value an opener can resolve to. */
const MODAL_FAILED: unique symbol = Symbol("modal-failed");

/** Awaits a modal opener inside `try`, so a sync throw or a rejection becomes {@link MODAL_FAILED}. */
async function openSafely<T>(open: () => Promise<T>): Promise<T | typeof MODAL_FAILED> {
  try {
    return await open();
  } catch {
    return MODAL_FAILED;
  }
}

/** Writes a failure status and its Notice -- the one ending every failure branch shares. */
function reportFailure(deps: SessionActionDeps, runId: string, text: string): void {
  setActionStatus(runId, { kind: "failure", text });
  deps.ui.notify(text);
}

function unavailableMessage(label: string): string {
  return `${label} isn't available yet.`;
}

/** `descriptor.target`, narrowed to the `{ runId }` shape session controls use. */
function getRunId(descriptor: QuickActionDescriptor): string | null {
  const target = descriptor.target;
  return target !== undefined && "runId" in target ? target.runId : null;
}

function sessionNameFor(deps: SessionActionDeps, runId: string): string {
  const view = deps.getSession(runId);
  return view === null ? UNKNOWN_SESSION_NAME : sessionDisplayName(view);
}

/**
 * `error.code` when it is a {@link ClaudeRequestError}, else the generic
 * fallback -- a transport failure this module doesn't otherwise recognise
 * must still resolve to a fixed reason, never propagate as a raw throw.
 */
function errorCodeOf(error: unknown): SessionActionErrorCode | "unrecognised-response" {
  return error instanceof ClaudeRequestError ? error.code : "unrecognised-response";
}

/**
 * The fixed-vocabulary reason for a failure Notice. `??` is the defensive
 * fallback Test 3 asks for: `error.code` is typed as a closed union, but a
 * future service build could still answer a code this table doesn't have a
 * row for, and that must fall back to the generic reason, never the raw
 * code, exactly like an actually-unrecognised code does.
 */
function reasonFor(
  code: SessionActionErrorCode | "unrecognised-response",
  cleanupPeriodDays: number | null,
): string {
  const template = REASON_COPY[code] ?? REASON_COPY["unrecognised-response"];
  if (code !== "transcript-missing") return template;
  return template.replace("{n}", String(cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS));
}

interface FocusCopy {
  readonly pending: string;
  readonly success: (response: FocusResponse, name: string) => string;
  readonly failure: (reason: string) => string;
}

const FOCUS_COPY: FocusCopy = {
  pending: "Focusing the terminal…",
  success: (response, name) =>
    response.outcome === "focused"
      ? `Focused the terminal for ${name}.`
      : `Brought ${response.terminalApp} forward. Find the tab for ${name} there.`,
  failure: (reason) => `Couldn't focus the terminal: ${reason}.`,
};

/**
 * "Focus to interrupt" (PR-01/PR-27): `SIGINT` ends an interactive session
 * instead of interrupting the turn, so `session:interrupt` dispatches the
 * SAME `focus` request as `session:focus` -- never an interrupt signal (a
 * source scan in this plan's test proves it) -- and only the SUCCESS text
 * differs, guiding the owner to press Esc themselves. Pending and failure
 * copy match Focus terminal's exactly, since the underlying request is
 * identical; only the outcome-facing instruction changes.
 */
const INTERRUPT_COPY: FocusCopy = {
  pending: FOCUS_COPY.pending,
  success: () => "Press Esc in the terminal to interrupt the current turn.",
  failure: FOCUS_COPY.failure,
};

async function runFocus(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
  copy: FocusCopy,
): Promise<void> {
  const runId = getRunId(descriptor);
  if (runId === null) {
    deps.ui.notify(unavailableMessage(descriptor.label));
    return;
  }
  const name = sessionNameFor(deps, runId);
  setActionStatus(runId, { kind: "pending", text: copy.pending });
  try {
    const response = await deps.requestSessionAction("focus", { runId });
    const text = copy.success(response, name);
    setActionStatus(runId, { kind: "success", text });
    deps.ui.notify(text);
  } catch (error) {
    const reason = reasonFor(errorCodeOf(error), deps.cleanupPeriodDays());
    const text = copy.failure(reason);
    setActionStatus(runId, { kind: "failure", text });
    deps.ui.notify(text);
  }
}

/** Fetches the existing-worktree list for the guard's worktree step, resolving to `"failed"` rather than throwing (UI-SPEC "Couldn't list existing worktrees. You can still name a new one."). */
async function loadWorktrees(deps: SessionActionDeps, runId: string): Promise<WorktreeListResult> {
  try {
    const response = await deps.requestSessionAction("worktrees", { runId });
    return response.worktrees;
  } catch {
    return "failed";
  }
}

interface LaunchCopy {
  readonly pending: string;
  readonly success: (name: string) => string;
  readonly failure: (name: string, reason: string) => string;
}

const RESUME_COPY: LaunchCopy = {
  pending: "Opening a terminal…",
  success: (name) => `Resuming ${name} in a new terminal.`,
  failure: (name, reason) => `Couldn't resume ${name}: ${reason}.`,
};

const BRANCH_COPY: LaunchCopy = {
  pending: "Opening a terminal…",
  success: (name) => `Branching ${name} into a new session.`,
  failure: (name, reason) => `Couldn't branch ${name}: ${reason}.`,
};

/**
 * Resume and branch (SESS-13, SESS-14, PR-25's two-step protocol): the first
 * `requestSessionAction` call either launches directly or answers a
 * `conflict`, which opens the guard (S4-a) through `ui.openConcurrentChoice`.
 * A `cancel` clears the pending status and makes no second call. Every other
 * resolution becomes the second call's `choice` (D-27, D-28) -- the runner
 * never inspects or validates the choice beyond passing it through, since
 * the service re-validates the guard on every launch.
 */
async function runLaunch(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
  action: "resume" | "branch",
  copy: LaunchCopy,
): Promise<void> {
  const runId = getRunId(descriptor);
  if (runId === null) {
    deps.ui.notify(unavailableMessage(descriptor.label));
    return;
  }
  const name = sessionNameFor(deps, runId);
  setActionStatus(runId, { kind: "pending", text: copy.pending });
  try {
    const first = await deps.requestSessionAction(action, { runId });
    if (first.outcome === "launched") {
      const text = copy.success(name);
      setActionStatus(runId, { kind: "success", text });
      deps.ui.notify(text);
      return;
    }
    const resolution = await openSafely(() =>
      deps.ui.openConcurrentChoice(
        concurrentChoiceViewModel(first.conflicts, first.projectName, Date.now()),
        () => loadWorktrees(deps, runId),
      ),
    );
    if (resolution === MODAL_FAILED) {
      reportFailure(deps, runId, copy.failure(name, MODAL_FAILED_REASON));
      return;
    }
    if (resolution.kind === "cancel") {
      clearActionStatus(runId);
      return;
    }
    const second = await deps.requestSessionAction(action, { runId, choice: resolution });
    if (second.outcome === "launched") {
      const text = copy.success(name);
      setActionStatus(runId, { kind: "success", text });
      deps.ui.notify(text);
      return;
    }
    // A second conflict (a race with another launch) is reported through the
    // same fixed reason vocabulary as any other failure, never a silent no-op.
    const text = copy.failure(name, reasonFor("invalid-state", deps.cleanupPeriodDays()));
    setActionStatus(runId, { kind: "failure", text });
    deps.ui.notify(text);
  } catch (error) {
    const reason = reasonFor(errorCodeOf(error), deps.cleanupPeriodDays());
    const text = copy.failure(name, reason);
    setActionStatus(runId, { kind: "failure", text });
    deps.ui.notify(text);
  }
}

/**
 * Associate an unclassified Run with a registered project (SESS-17, D-24).
 * `listProjects() === null` means "unknown" (before Phase 4's registry is
 * wired, PR-17) -- distinct from an empty, but real, project list, which
 * still opens the picker so its own fixed empty-list copy can show (UI-SPEC
 * S4-e). Choosing an item is the whole gesture: there is no confirmation
 * step.
 */
async function runAssociate(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
): Promise<void> {
  const runId = getRunId(descriptor);
  if (runId === null) {
    deps.ui.notify(unavailableMessage(descriptor.label));
    return;
  }
  const name = sessionNameFor(deps, runId);
  const projects = deps.listProjects();
  if (projects === null) {
    deps.ui.notify("Register a project first");
    return;
  }
  const chosen = await openSafely(() => deps.ui.openAssociatePicker(name, projects));
  if (chosen === MODAL_FAILED) {
    reportFailure(deps, runId, `Couldn't associate ${name}: ${MODAL_FAILED_REASON}.`);
    return;
  }
  if (chosen === null) return;
  setActionStatus(runId, { kind: "pending", text: "Associating…" });
  try {
    await deps.requestSessionAction("associate", { runId, projectId: chosen.id });
    const text = `Associated ${name} with ${chosen.name}. Later resumes of this session go there too.`;
    setActionStatus(runId, { kind: "success", text });
    deps.ui.notify(text);
  } catch (error) {
    const reason = reasonFor(errorCodeOf(error), deps.cleanupPeriodDays());
    const text = `Couldn't associate ${name}: ${reason}.`;
    setActionStatus(runId, { kind: "failure", text });
    deps.ui.notify(text);
  }
}

/**
 * The transcript plaintext warning opens on EVERY press (SESS-15, D-34) --
 * there is no cache and no "seen it already" branch anywhere in this
 * function, by requirement. Only after the owner picks reveal/open does this
 * write a pending status and call the service; cancel calls nothing.
 */
async function runOpenTranscript(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
): Promise<void> {
  const runId = getRunId(descriptor);
  if (runId === null) {
    deps.ui.notify(unavailableMessage(descriptor.label));
    return;
  }
  const days = deps.cleanupPeriodDays() ?? DEFAULT_CLEANUP_PERIOD_DAYS;
  const choice = await openSafely(() =>
    deps.ui.openTranscriptWarning(transcriptWarningViewModel(days)),
  );
  if (choice === MODAL_FAILED) {
    reportFailure(deps, runId, `Couldn't open the transcript: ${MODAL_FAILED_REASON}.`);
    return;
  }
  if (choice === "cancel") return;
  setActionStatus(runId, { kind: "pending", text: "Opening the transcript…" });
  try {
    await deps.requestSessionAction("open-transcript", { runId, mode: choice });
    const text =
      choice === "reveal" ? "Showed the transcript in Finder." : "Opened the transcript.";
    setActionStatus(runId, { kind: "success", text });
    deps.ui.notify(text);
  } catch (error) {
    const reason = reasonFor(errorCodeOf(error), deps.cleanupPeriodDays());
    const text = `Couldn't open the transcript: ${reason}.`;
    setActionStatus(runId, { kind: "failure", text });
    deps.ui.notify(text);
  }
}

/**
 * Matches the service's tuned `DEFAULT_TERMINATE_GRACE_MS` (10s,
 * `terminate-executor.ts`, 05-14) -- shown only as fixed UI copy naming the
 * grace period before escalation, never read from the service at request
 * time.
 */
const DEFAULT_TERMINATE_GRACE_SECONDS = 10;

/**
 * The force-terminate request (SESS-16, D-01, PR-26): the modal is the whole
 * confirmation -- there is no typed-confirmation shortcut -- and
 * `requestSessionAction("terminate-request")` is called only after "send".
 * Before Phase 6, every request answers `approval-unavailable`; the fixed
 * reason vocabulary already carries that exact copy.
 */
async function runTerminateRequest(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
): Promise<void> {
  const runId = getRunId(descriptor);
  if (runId === null) {
    deps.ui.notify(unavailableMessage(descriptor.label));
    return;
  }
  const name = sessionNameFor(deps, runId);
  const view = deps.getSession(runId);
  const projectName = view?.projectName ?? "Unclassified";
  const choice = await openSafely(() =>
    deps.ui.openTerminateRequest(
      terminateRequestViewModel(name, projectName, DEFAULT_TERMINATE_GRACE_SECONDS),
    ),
  );
  if (choice === MODAL_FAILED) {
    reportFailure(deps, runId, `Couldn't send the request: ${MODAL_FAILED_REASON}.`);
    return;
  }
  if (choice === "cancel") return;
  setActionStatus(runId, { kind: "pending", text: "Sending the request…" });
  try {
    await deps.requestSessionAction("terminate-request", { runId });
    const text = `Force-terminate request for ${name} is waiting in the approval inbox.`;
    setActionStatus(runId, { kind: "success", text });
    deps.ui.notify(text);
  } catch (error) {
    const reason = reasonFor(errorCodeOf(error), deps.cleanupPeriodDays());
    const text = `Couldn't send the request: ${reason}.`;
    setActionStatus(runId, { kind: "failure", text });
    deps.ui.notify(text);
  }
}

/** `descriptor.target`, narrowed to the `{ threadId }` shape the Codex transcript action uses. */
function getThreadId(descriptor: QuickActionDescriptor): string | null {
  const target = descriptor.target;
  return target !== undefined && "threadId" in target ? target.threadId : null;
}

/**
 * The reason for a failed Codex action: the client's fixed code, or the
 * service-didn't-respond fallback for anything else. Never the error's own
 * message, which can carry a path or process text (T-05.1-23).
 */
function codexReasonOf(error: unknown): CodexReason {
  return codexReasonFor(error instanceof CodexRequestError ? error.code : "unrecognised-response");
}

/** Writes a Codex failure line and its Notice, both the same text (UI-SPEC S3 "Action feedback"). */
function reportCodexFailure(deps: SessionActionDeps, copy: CodexActionCopy, reason: CodexReason) {
  const text = copy.failure(reason);
  setCodexActionStatus({ kind: "failure", text });
  deps.ui.notify(text);
}

/**
 * Codex `Open transcript` (D-29, CODEX-07): the acknowledgement is written in
 * the click's own tick, BEFORE the warning, then the warning shows on EVERY
 * press -- there is no cache and no "seen it already" branch here. Cancel
 * (Escape, a click outside, the button) clears the line and calls nothing.
 * Never throws: every branch ends in a status write plus, for a failure, a
 * Notice.
 */
async function runCodexOpenTranscript(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
): Promise<void> {
  const threadId = getThreadId(descriptor);
  const codex = deps.codex;
  const openWarning = deps.ui.openCodexTranscriptWarning;
  if (threadId === null || codex === undefined || openWarning === undefined) {
    deps.ui.notify(unavailableMessage(descriptor.label));
    return;
  }
  const copy = CODEX_TRANSCRIPT_COPY;
  setCodexActionStatus({ kind: "pending", text: copy.pending });
  const choice = await openSafely(() => openWarning(codexTranscriptWarningViewModel()));
  if (choice === MODAL_FAILED) {
    reportCodexFailure(deps, copy, codexReasonFor("unrecognised-response"));
    return;
  }
  if (choice === "cancel") {
    clearCodexActionStatus();
    return;
  }
  try {
    await codex.openTranscript({ threadId, via: choice });
    setCodexActionStatus(
      { kind: "success", text: copy.success },
      codex.timers ?? windowLaunchTimers(),
    );
  } catch (error) {
    reportCodexFailure(deps, copy, codexReasonOf(error));
  }
}

/** `descriptor.target`, narrowed to the `{ wrapperRunId }` shape the Codex follow-log action uses. */
function getWrapperRunId(descriptor: QuickActionDescriptor): string | null {
  const target = descriptor.target;
  return target !== undefined && "wrapperRunId" in target ? target.wrapperRunId : null;
}

/**
 * Codex `Follow live log` (D-29, R-16): the same structure as
 * {@link runCodexOpenTranscript} with its own, shorter warning. The target is
 * a wrapper run id, never a thread id -- an interactive session has no live
 * log to follow.
 */
async function runCodexFollowLog(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
): Promise<void> {
  const wrapperRunId = getWrapperRunId(descriptor);
  const codex = deps.codex;
  const openWarning = deps.ui.openCodexFollowWarning;
  if (wrapperRunId === null || codex === undefined || openWarning === undefined) {
    deps.ui.notify(unavailableMessage(descriptor.label));
    return;
  }
  const copy = CODEX_FOLLOW_COPY;
  setCodexActionStatus({ kind: "pending", text: copy.pending });
  const choice = await openSafely(() => openWarning(codexFollowWarningViewModel()));
  if (choice === MODAL_FAILED) {
    reportCodexFailure(deps, copy, codexReasonFor("unrecognised-response"));
    return;
  }
  if (choice === "cancel") {
    clearCodexActionStatus();
    return;
  }
  try {
    await codex.followLog({ runId: wrapperRunId });
    setCodexActionStatus(
      { kind: "success", text: copy.success },
      codex.timers ?? windowLaunchTimers(),
    );
  } catch (error) {
    reportCodexFailure(deps, copy, codexReasonOf(error));
  }
}

const ENABLE_ANALYSIS_PENDING_TEXT = "Turning on transcript analysis…";
const ENABLE_ANALYSIS_FAILURE_MESSAGE =
  "Couldn't turn on transcript analysis. Check the service in Settings → Diagnostics, then try again.";

/**
 * One-click transcript analysis (D-03): a direct gesture with no
 * confirmation, and no per-Run status line (there is no Run to attach one
 * to -- this is a card-level control). On success the card's own SSE-driven
 * state shows the first-scan copy; this function only reports failure.
 */
async function runEnableTranscriptAnalysis(deps: SessionActionDeps): Promise<void> {
  deps.ui.notify(ENABLE_ANALYSIS_PENDING_TEXT);
  try {
    await deps.setTranscriptAnalysis(true);
  } catch {
    deps.ui.notify(ENABLE_ANALYSIS_FAILURE_MESSAGE);
  }
}

/**
 * Dispatches one {@link QuickActionDescriptor} to its control's full flow:
 * modal (Tasks 2-3), client call, status write, Notice. Unhandled capabilities
 * and descriptors this runner cannot resolve (no `target.runId` where one is
 * required) fall through to the generic "isn't available yet" notice and
 * call nothing (Test 4) -- this is the ONLY branch that does not touch
 * `sessionActionStatus`, since there is no Run to attach a status line to.
 */
export async function runSessionAction(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
): Promise<void> {
  switch (descriptor.capability) {
    case "session:focus":
      await runFocus(descriptor, deps, FOCUS_COPY);
      return;
    case "session:interrupt":
      await runFocus(descriptor, deps, INTERRUPT_COPY);
      return;
    case "session:resume":
      await runLaunch(descriptor, deps, "resume", RESUME_COPY);
      return;
    case "session:branch":
      await runLaunch(descriptor, deps, "branch", BRANCH_COPY);
      return;
    case "session:associate":
      await runAssociate(descriptor, deps);
      return;
    case "session:open-transcript":
      await runOpenTranscript(descriptor, deps);
      return;
    case "session:terminate":
      await runTerminateRequest(descriptor, deps);
      return;
    case "usage:enable-transcript-analysis":
      await runEnableTranscriptAnalysis(deps);
      return;
    case "codex:open-transcript":
      await runCodexOpenTranscript(descriptor, deps);
      return;
    case "codex:follow-log":
      await runCodexFollowLog(descriptor, deps);
      return;
    default:
      deps.ui.notify(unavailableMessage(descriptor.label));
  }
}
