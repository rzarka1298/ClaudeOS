import type {
  DetectionResponse,
  LaunchAction,
  LaunchErrorKind,
  LauncherConfigView,
  LauncherId,
  RefusedTemplate,
  SystemSettingsPane,
  TemplateRefusalReason,
  TerminalChoice,
  TerminalPresetId,
} from "@ccc/domain";
import { type Signal, signal } from "@preact/signals";
import type { RefObject, VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  LAUNCH_ERROR_ACTION_LABELS,
  LAUNCH_ERROR_COPY,
  type LaunchErrorAction,
  launcherDisplayName,
  renderCopy,
} from "../projects/launch-copy.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { SYSTEM_SETTINGS_OPEN_FAILED_NOTICE } from "../projects/system-settings-opener.js";
import { formatRelativeTime } from "../widgets/relative-time.js";

/**
 * What every S6 launcher panel shares (plan 04-12): the per-view session
 * holding detection, drafts and in-flight results, the status badge and the
 * persistent status line. A module of its own so `launchers-settings.tsx`
 * and `claude-code-panel.tsx` both build on it without importing each
 * other.
 */

/** The two launchers configured by choosing an installed app (D-19). */
export type AppLauncherId = "antigravity" | "claude-desktop";

/** The owner's in-progress choice for an app launcher. */
export type AppDraft =
  | { readonly kind: "detected"; readonly bundleId: string }
  | { readonly kind: "override"; readonly text: string };

/** Which `claude` the owner chose: a detected candidate (by id), a typed path, or nothing yet. */
export type ExecutableDraft =
  | { readonly kind: "candidate"; readonly candidateId: string }
  | { readonly kind: "path"; readonly text: string }
  | null;

export type TerminalDraft =
  | { readonly kind: "terminal-app" }
  | {
      readonly kind: "custom";
      readonly preset: TerminalPresetId;
      readonly argv: readonly string[];
    };

/** The Claude Code panel's in-progress configuration (D-21, D-22, D-23). */
export interface ClaudeCodeDraft {
  readonly executable: ExecutableDraft;
  readonly args: readonly string[];
  readonly terminal: TerminalDraft;
}

/** What a panel's persistent status line says (UI-SPEC S6). */
export type PanelStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "save-failed" }
  /** A Test is in flight (written in the same render as the click, D-40). */
  | { readonly kind: "testing" }
  /** The Test launch exited 0; the owner is asked whether the app opened (D-28). */
  | { readonly kind: "test-sent" }
  /** The owner answered It opened; mark-tested is in flight. */
  | { readonly kind: "confirming" }
  /** Only the owner's It opened gets here (RR-14). */
  | { readonly kind: "tested"; readonly at: string }
  | { readonly kind: "not-opened" }
  | { readonly kind: "test-error"; readonly error: LaunchErrorKind }
  /** The service was already testing a newer saved configuration (409). */
  | { readonly kind: "test-conflict" }
  /** mark-tested answered 409: the saved row has no passing Test in this service run. */
  | { readonly kind: "needs-test" }
  | { readonly kind: "confirm-failed" };

/** One row problem: the template index it names and its copy. */
export type RowError = readonly [index: number, copy: string];

/** A save problem shown under the field it is about, not in the status line. */
export type SaveError =
  | { readonly kind: "invalid-bundle" }
  | {
      readonly kind: "refused";
      readonly reason: TemplateRefusalReason;
      readonly index: number | null;
      readonly template?: RefusedTemplate | undefined;
    }
  | {
      /** The plugin's own trivial checks failed on save (PR-13). */
      readonly kind: "client";
      readonly executable: string | null;
      readonly claude: readonly RowError[];
      readonly terminal: readonly RowError[];
    };

/**
 * Everything the Launchers section knows, held by the view (the Shell
 * creates one per command-center view): leaving Settings and coming back
 * keeps the detection, the drafts and any in-flight result. Memory only —
 * never plugin settings, `data.json` or the vault (D-43, RR-25).
 */
export interface LaunchersSession {
  readonly detection: Signal<DetectionResponse | null>;
  readonly detectPhase: Signal<"idle" | "detecting" | "failed">;
  readonly configs: Signal<LauncherConfigView | null>;
  readonly appDrafts: Signal<Partial<Record<AppLauncherId, AppDraft>>>;
  readonly claudeDraft: Signal<ClaudeCodeDraft | null>;
  readonly status: Signal<Partial<Record<LaunchAction, PanelStatus>>>;
  readonly saveErrors: Signal<Partial<Record<LaunchAction, SaveError>>>;
  /** Set once detection has been started automatically, so a failure is not retried on every open. */
  autoDetected: boolean;
  /** How many `getConfigs` requests this session has issued (see {@link loadConfigs}). */
  configsIssued: number;
  /** The newest issued request whose answer was applied; older answers are dropped. */
  configsApplied: number;
}

export function createLaunchersSession(): LaunchersSession {
  return {
    detection: signal(null),
    detectPhase: signal("idle"),
    configs: signal(null),
    appDrafts: signal({}),
    claudeDraft: signal(null),
    status: signal({}),
    saveErrors: signal({}),
    autoDetected: false,
    configsIssued: 0,
    configsApplied: 0,
  };
}

/**
 * Re-reads the saved configuration into the session. Several reads can be
 * in flight at once (an open, a save, a confirmed Test); an answer to a read
 * issued before one already applied is dropped, so a slow old answer never
 * overwrites a newer one (wave-6 review). Resolves `true` when this answer
 * was applied.
 */
export function loadConfigs(
  session: LaunchersSession,
  actions: LaunchersActions,
): Promise<boolean> {
  session.configsIssued += 1;
  const ticket = session.configsIssued;
  return actions.getConfigs().then((outcome) => {
    if (outcome.kind !== "loaded" || ticket <= session.configsApplied) return false;
    session.configsApplied = ticket;
    session.configs.value = outcome.configs;
    return true;
  });
}

export function setPanelStatus(
  session: LaunchersSession,
  id: LaunchAction,
  status: PanelStatus,
): void {
  session.status.value = { ...session.status.value, [id]: status };
}

export function setSaveError(
  session: LaunchersSession,
  id: LaunchAction,
  error: SaveError | null,
): void {
  const next = { ...session.saveErrors.value };
  if (error === null) delete next[id];
  else next[id] = error;
  session.saveErrors.value = next;
}

/** The fixed panel names (UI-SPEC S6 h4 copy). */
export const LAUNCHER_PANEL_NAMES: Readonly<Record<LaunchAction, string>> = {
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  finder: "Finder",
  github: "GitHub",
};

export const PANEL_DESCRIPTIONS: Readonly<Record<LaunchAction, string>> = {
  antigravity: "Opens a project folder in Antigravity.",
  "claude-code": "Starts a new Claude Code session in a terminal window at the project folder.",
  "claude-desktop": "Brings Claude Desktop to the front.",
  finder: "Reveals a project folder in Finder. Nothing to set up.",
  github: "Opens a project's GitHub page in your default browser. Nothing to set up.",
};

/** A launcher's S6 status badge. */
export type LauncherBadge = "not-set-up" | "set-up" | "tested" | "app-not-found";

const BADGE_GLYPH: Readonly<Record<LauncherBadge, string>> = {
  "not-set-up": "◌",
  "set-up": "◆",
  tested: "✓",
  "app-not-found": "▲",
};

const BADGE_TEXT: Readonly<Record<LauncherBadge, string>> = {
  "not-set-up": "Not set up",
  "set-up": "Set up",
  tested: "Tested",
  "app-not-found": "App not found",
};

/** The S6 status badge: the existing `.ccc-badge` chip, glyph plus text (A11Y-04). */
export function LauncherStatusBadge({ badge }: { readonly badge: LauncherBadge }): VNode {
  return (
    <span className="ccc-badge" data-launcher-badge={badge}>
      <span
        className={badge === "app-not-found" ? "ccc-error-glyph" : "ccc-meta-glyph"}
        aria-hidden="true"
      >
        {BADGE_GLYPH[badge]}
      </span>{" "}
      {BADGE_TEXT[badge]}
    </span>
  );
}

/** One `▲` field error line (UI-SPEC: danger text is always paired with the glyph). */
export function FieldError({ id, text }: { readonly id?: string; readonly text: string }): VNode {
  return (
    <p id={id} className="ccc-field-error">
      <span className="ccc-error-glyph" aria-hidden="true">
        ▲
      </span>
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The Test step (D-28, PR-02, RR-14, RR-15)

/** Why a panel's Test launcher is `aria-disabled`, if it is. */
export type TestBlock = "disconnected" | "save-first" | "busy" | null;

/** `{Terminal}` inside a sentence: the blank preset's "Your terminal" reads lower-case there. */
export function terminalInSentence(label: string): string {
  return label === "Your terminal" ? "your terminal" : label;
}

/** The wording a panel's Test lines need (UI-SPEC S6 Test rows). */
export interface TestCopy {
  /** The panel's app name, as in `Did {app} open?`. */
  readonly appName: string;
  /** `Test sent. Did {app} open?`, or Claude Code's terminal question. */
  readonly question: string;
  /** `{Terminal}` for the D-26 lines (Claude Code only; `Terminal` elsewhere). */
  readonly terminal: string;
  /** A Test that may meet macOS's Automation prompt waits up to a minute (wave 5). */
  readonly mayPrompt: boolean;
}

/** Fires one Test of the saved configuration. Never rejects; the status line carries every outcome. */
export function runLauncherTest(
  session: LaunchersSession,
  actions: LaunchersActions,
  id: LaunchAction,
  terminal: TerminalChoice | null,
): void {
  setPanelStatus(session, id, { kind: "testing" });
  void actions.test(id, terminal).then((outcome) => {
    switch (outcome.kind) {
      case "sent":
        setPanelStatus(session, id, { kind: "test-sent" });
        return;
      case "conflict":
        setPanelStatus(session, id, { kind: "test-conflict" });
        return;
      default:
        setPanelStatus(session, id, { kind: "test-error", error: outcome.error });
    }
  });
}

function isLauncherId(id: LaunchAction): id is LauncherId {
  return id === "antigravity" || id === "claude-code" || id === "claude-desktop";
}

/**
 * The owner's answer to `Did {app} open?` (RR-14). Only It opened can mark
 * a launcher Tested, and for the three configurable launchers only the
 * service's mark-tested decides; Finder and GitHub have no saved row, so
 * their confirmation is recorded for this view only.
 */
export function answerLauncherTest(
  session: LaunchersSession,
  actions: LaunchersActions,
  id: LaunchAction,
  opened: boolean,
): void {
  if (!opened) {
    setPanelStatus(session, id, { kind: "not-opened" });
    return;
  }
  if (!isLauncherId(id)) {
    setPanelStatus(session, id, { kind: "tested", at: new Date().toISOString() });
    return;
  }
  setPanelStatus(session, id, { kind: "confirming" });
  void actions.markTested(id).then((outcome) => {
    switch (outcome.kind) {
      case "marked": {
        setPanelStatus(session, id, { kind: "tested", at: new Date().toISOString() });
        const configs = session.configs.value;
        const saved = configs?.[id];
        if (configs !== null && saved !== null && saved !== undefined) {
          session.configs.value = { ...configs, [id]: { ...saved, tested: true } };
        }
        void loadConfigs(session, actions);
        return;
      }
      case "needs-test":
        setPanelStatus(session, id, { kind: "needs-test" });
        return;
      case "service-disconnected":
        setPanelStatus(session, id, { kind: "test-error", error: "service-disconnected" });
        return;
      default:
        setPanelStatus(session, id, { kind: "confirm-failed" });
    }
  });
}

/** The permission line and the Test explanation (D-28, PR-02, RR-15). */
export function TestLines({
  automation,
  explanation,
}: {
  readonly automation: boolean;
  readonly explanation: string;
}): VNode {
  return (
    <>
      <p className="ccc-list-meta">
        {automation
          ? "macOS may ask for Automation permission during this test. Choose OK so launches can work."
          : "No permission needed"}
      </p>
      <p className="ccc-list-meta">{explanation}</p>
    </>
  );
}

/** `Test launcher`: `aria-disabled` (still focusable) while blocked, with the PR-13 hidden note. */
export function TestLauncherButton({
  appName,
  block,
  onTest,
  buttonRef,
}: {
  readonly appName: string;
  readonly block: TestBlock;
  readonly onTest: () => void;
  readonly buttonRef: RefObject<HTMLButtonElement>;
}): VNode {
  const noteId = useId();
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ccc-connect-button"
        aria-label={`Test the ${appName} launcher`}
        aria-disabled={block === null ? undefined : "true"}
        aria-describedby={block === "save-first" ? noteId : undefined}
        onClick={() => {
          if (block === null) onTest();
        }}
      >
        Test launcher
      </button>
      {block === "save-first" && (
        <span id={noteId} className="ccc-visually-hidden">
          Save launcher first
        </span>
      )}
    </>
  );
}

/** A Test outcome's two lines (problem, next step) plus any extra explanation. */
function testErrorLines(error: LaunchErrorKind, id: LaunchAction, copy: TestCopy): string[] {
  const values = {
    launcher: launcherDisplayName(id),
    terminal: terminalInSentence(copy.terminal),
    project: null,
  };
  if (error === "timeout") {
    // The D-26 timeout line names the 5 s launch deadline; a Test waits longer.
    return [
      `${values.launcher} didn't respond in time.`,
      "Check whether it opened. If it didn't, check the settings above, then test again.",
    ];
  }
  const lines = [
    renderCopy(LAUNCH_ERROR_COPY[error].problem, values),
    renderCopy(LAUNCH_ERROR_COPY[error].nextStep, values),
  ];
  if (error === "automation-denied") {
    // The service reports an unanswered first prompt (killed at its 60 s
    // cap) as automation-denied, so say that case out loud (wave 5).
    lines.push("If macOS asked and nobody answered within a minute, test again and choose OK.");
  }
  return lines;
}

function problemLines(status: PanelStatus, id: LaunchAction, copy: TestCopy): string[] | null {
  switch (status.kind) {
    case "save-failed":
      return [
        "Couldn't save launcher settings.",
        "Check the service in Settings → Diagnostics, then try again.",
      ];
    case "not-opened":
      return [`${copy.appName} didn't open.`, "Check the settings above, then test again."];
    case "test-error":
      return testErrorLines(status.error, id, copy);
    case "test-conflict":
      return [
        "The launcher settings changed during this test.",
        "Test again to check the saved settings.",
      ];
    case "needs-test":
      return [
        "This test no longer matches the saved settings.",
        "Test again, then choose It opened.",
      ];
    case "confirm-failed":
      return [
        "Couldn't record the test.",
        "Check the service in Settings → Diagnostics, then try again.",
      ];
    default:
      return null;
  }
}

/** The panel's persistent `role="status"` line (Accessibility Floor 2): save and Test, one region. */
export function PanelStatusLine({
  id,
  status,
  now,
  copy,
}: {
  readonly id: LaunchAction;
  readonly status: PanelStatus;
  readonly now: number;
  readonly copy: TestCopy;
}): VNode {
  const problem = problemLines(status, id, copy);
  const tone =
    problem !== null
      ? "error"
      : status.kind === "saved" || status.kind === "tested"
        ? "success"
        : undefined;
  return (
    <p role="status" className="ccc-launch-status" data-tone={tone}>
      {(status.kind === "saving" || status.kind === "confirming") && "Saving…"}
      {status.kind === "saved" && (
        <>
          <span className="ccc-meta-glyph" aria-hidden="true">
            ✓
          </span>{" "}
          Saved
        </>
      )}
      {status.kind === "testing" && (
        <>
          <span>Testing…</span>
          {copy.mayPrompt && (
            <>
              <br />
              <span>This can take up to a minute if macOS asks for permission.</span>
            </>
          )}
        </>
      )}
      {status.kind === "test-sent" && copy.question}
      {status.kind === "tested" && (
        <>
          <span className="ccc-meta-glyph" aria-hidden="true">
            ✓
          </span>{" "}
          {`Tested ${formatRelativeTime(status.at, now)}`}
        </>
      )}
      {problem !== null && (
        <>
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          {problem.map((line, index) => (
            <span key={line}>
              {index > 0 && <br />}
              {line}
            </span>
          ))}
        </>
      )}
    </p>
  );
}

const PANE_FOR_ACTION: Partial<Record<LaunchErrorAction, SystemSettingsPane>> = {
  "open-automation": "automation",
  "open-privacy-security": "privacy-security",
};

/**
 * What follows the status line, outside the live region: It opened / It
 * didn't open after a sent Test (focus moves to It opened), or a Test
 * error's System Settings button (RR-16). Navigation actions are omitted —
 * the owner is already in Settings › Launchers.
 */
export function PanelFollowUps({
  id,
  status,
  session,
  actions,
  disabled,
  testButtonRef,
}: {
  readonly id: LaunchAction;
  readonly status: PanelStatus;
  readonly session: LaunchersSession;
  readonly actions: LaunchersActions;
  readonly disabled: boolean;
  readonly testButtonRef: RefObject<HTMLButtonElement>;
}): VNode | null {
  const openedRef = useRef<HTMLButtonElement | null>(null);
  const [openFailed, setOpenFailed] = useState<SystemSettingsPane | null>(null);
  const asking = status.kind === "test-sent";

  useEffect(() => {
    if (!asking) return;
    // Move focus only from where the owner pressed Test (or from nowhere),
    // never out of a field they have since moved to. The panel's own
    // document, not the global one: in a popout window they differ.
    const opened = openedRef.current;
    if (opened === null) return;
    const doc = opened.ownerDocument;
    const active = doc.activeElement;
    if (active === null || active === doc.body || active === testButtonRef.current) {
      opened.focus();
    }
  }, [asking, testButtonRef]);

  if (asking) {
    return (
      <div className="ccc-manage-toolbar">
        <button
          ref={openedRef}
          type="button"
          className="ccc-connect-button"
          aria-disabled={disabled ? "true" : undefined}
          onClick={() => {
            if (disabled) return;
            answerLauncherTest(session, actions, id, true);
            // The answer buttons leave with the question: focus goes back to
            // where the owner started the Test (wave-6 review).
            testButtonRef.current?.focus();
          }}
        >
          It opened
        </button>
        <button
          type="button"
          className="ccc-list-more"
          aria-disabled={disabled ? "true" : undefined}
          onClick={() => {
            if (disabled) return;
            answerLauncherTest(session, actions, id, false);
            testButtonRef.current?.focus();
          }}
        >
          It didn't open
        </button>
      </div>
    );
  }

  const action = status.kind === "test-error" ? LAUNCH_ERROR_COPY[status.error].action : undefined;
  const pane = action === undefined ? undefined : PANE_FOR_ACTION[action];
  if (action === undefined || pane === undefined) return null;
  return (
    <>
      <button
        type="button"
        className="ccc-list-more"
        aria-disabled={disabled ? "true" : undefined}
        onClick={() => {
          if (disabled) return;
          setOpenFailed(null);
          void actions.openSystemSettings(pane).then((outcome) => {
            if (outcome.kind !== "opened") setOpenFailed(pane);
          });
        }}
      >
        {LAUNCH_ERROR_ACTION_LABELS[action]}
      </button>
      {openFailed !== null && (
        <p className="ccc-field-help">{SYSTEM_SETTINGS_OPEN_FAILED_NOTICE[openFailed]}</p>
      )}
    </>
  );
}
