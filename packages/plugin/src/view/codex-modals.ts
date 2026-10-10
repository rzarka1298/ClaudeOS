import type { ModalButtonView, TranscriptWarningViewModel } from "./session-modals.js";

/**
 * The Codex warnings and the fixed outcome copy behind `Open transcript` and
 * `Follow live log` (05.1 UI-SPEC S3, D-29, CODEX-07; plan 05.1-19).
 *
 * Both warnings show on EVERY open. No view model here has a remember,
 * don't-ask-again or persisted field -- there is nothing for a caller to
 * store (the Phase 5 SESS-15 rule, carried over). The modals are Obsidian
 * chrome: native styling, no `--ccc-*` token (UI-SPEC non-negotiable 11).
 */

const TRANSCRIPT_TITLE = "Open this transcript?";
const TRANSCRIPT_BODY_1 =
  "Codex stores this transcript on your Mac as plain text. Anything readable by your user account can read it.";
const TRANSCRIPT_BODY_2 =
  "Codex decides how long it keeps it. This app doesn't manage, copy or protect it.";

/**
 * The Codex transcript warning (S3-a): the same shape the Claude one uses
 * ({@link TranscriptWarningViewModel}), so the existing `TranscriptWarningModal`
 * renders it unchanged. A fresh object on every call.
 */
export function codexTranscriptWarningViewModel(): TranscriptWarningViewModel {
  const buttons: readonly [ModalButtonView, ModalButtonView, ModalButtonView] = [
    { label: "Show in Finder", cta: true, destructive: false },
    { label: "Open with default app", cta: false, destructive: false },
    { label: "Cancel", cta: false, destructive: false },
  ];
  return {
    title: TRANSCRIPT_TITLE,
    bodies: [TRANSCRIPT_BODY_1, TRANSCRIPT_BODY_2],
    buttons,
    initialFocus: "cancel",
  };
}

/**
 * The fixed reason vocabulary (UI-SPEC S3): the ONLY words a Codex action
 * failure ever shows. No path, thread id or process text can appear in one.
 */
export const CODEX_REASONS = [
  "the file wasn't found",
  "it isn't in Codex's sessions folder",
  "the run has ended",
  "the bridge isn't installed",
  "the bridge is out of date",
  "Antigravity is still starting",
  "the service didn't respond",
] as const;
export type CodexReason = (typeof CODEX_REASONS)[number];

const SERVICE_DIDNT_RESPOND: CodexReason = "the service didn't respond";

/**
 * Every Codex action or client error code with its own named reason. Every
 * other code -- `invalid-request`, `unavailable`, `failed`, `timeout`,
 * `service-disconnected`, `unrecognised-response` -- and anything not in the
 * client's vocabulary at all falls to "the service didn't respond".
 */
const REASON_BY_CODE: Readonly<Record<string, CodexReason>> = {
  "not-found": "the file wasn't found",
  "outside-sessions-folder": "it isn't in Codex's sessions folder",
  "run-ended": "the run has ended",
  "bridge-not-installed": "the bridge isn't installed",
  "bridge-outdated": "the bridge is out of date",
  "window-not-ready": "Antigravity is still starting",
};

/** The one mapper from a client error code to a reason; unknown codes never surface raw. */
export function codexReasonFor(code: string): CodexReason {
  return Object.hasOwn(REASON_BY_CODE, code)
    ? (REASON_BY_CODE[code] ?? SERVICE_DIDNT_RESPOND)
    : SERVICE_DIDNT_RESPOND;
}

/** The acknowledgement, success and failure lines of one Codex row action (UI-SPEC S3 "Action feedback"). */
export interface CodexActionCopy {
  readonly pending: string;
  readonly success: string;
  readonly failure: (reason: CodexReason) => string;
}

export const CODEX_TRANSCRIPT_COPY: CodexActionCopy = {
  pending: "Opening transcript…",
  success: "✓ Transcript opened",
  failure: (reason) => `▲ Couldn't open the transcript: ${reason}.`,
};

export const CODEX_FOLLOW_COPY: CodexActionCopy = {
  pending: "Opening live log…",
  success: "✓ Live log opened in Antigravity",
  failure: (reason) => `▲ Couldn't follow the live log: ${reason}.`,
};

export interface CodexFollowWarningViewModel {
  readonly title: string;
}

export type CodexFollowChoice = "follow" | "cancel";
