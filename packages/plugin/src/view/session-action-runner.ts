import type { FocusResponse, SessionActionErrorCode } from "@ccc/domain/session-actions.js";
import type { SessionView } from "@ccc/domain/session.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";

/**
 * RED scaffold (Task 1). `runSessionAction` always answers "not available
 * yet" so `session-action-runner.test.ts` fails on its real assertions
 * (pending status, success/failure text, the requested action name) rather
 * than on a missing export -- the module resolves and every type here is
 * final; only the dispatch logic below is a placeholder for GREEN.
 */

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

/** RED: switches on nothing yet -- every descriptor is "not available". */
export async function runSessionAction(
  descriptor: QuickActionDescriptor,
  deps: SessionActionDeps,
): Promise<void> {
  await Promise.resolve();
  deps.ui.notify(unavailableMessage(descriptor.label));
}
