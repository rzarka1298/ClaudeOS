import { type SessionView, sessionDisplayName } from "@ccc/domain/session.js";
import type { FocusResponse, SessionActionErrorCode } from "@ccc/domain/session-actions.js";
import { ClaudeRequestError } from "@ccc/service-api-client";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { setActionStatus } from "./session-action-status.js";

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
 * Tasks 2-3 add the modal openers this plan's other controls need.
 */
export interface SessionActionUi {
  /** Shows a transient message to the user (an Obsidian `Notice` in production). */
  notify(message: string): void;
}

/** The request/response shape for every action name the runner dispatches so far. */
export interface SessionActionRequestMap {
  focus: { request: { runId: string }; response: FocusResponse };
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
  readonly ui: SessionActionUi;
  /** `null` when the Run is not (yet) loaded into the signal store. */
  getSession(runId: string): SessionView | null;
  /** `null` when the service hasn't reported it yet. */
  cleanupPeriodDays(): number | null;
}

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
  "approval-unavailable": "Needs approval — available once the approval inbox is ready",
  "project-not-registered": "that project isn't registered",
  "folder-access-denied": "the folder couldn't be accessed",
  "spawn-failed": "the terminal couldn't be started",
  "project-moved": "the project's folder has moved",
  "app-not-found": "the terminal app isn't installed",
  "unrecognised-response": "the service sent a response this app doesn't recognise",
};

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
    default:
      deps.ui.notify(unavailableMessage(descriptor.label));
  }
}
