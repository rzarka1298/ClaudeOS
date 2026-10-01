import type {
  DetectionResponse,
  LaunchAction,
  LauncherConfigView,
  RefusedTemplate,
  TemplateRefusalReason,
  TerminalPresetId,
} from "@ccc/domain";
import { type Signal, signal } from "@preact/signals";
import type { VNode } from "preact";

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
  | { readonly kind: "save-failed" };

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
  };
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

/** The panel's persistent `role="status"` line (Accessibility Floor 2). */
export function PanelStatusLine({ status }: { readonly status: PanelStatus }): VNode {
  const tone =
    status.kind === "save-failed" ? "error" : status.kind === "saved" ? "success" : undefined;
  return (
    <p role="status" className="ccc-launch-status" data-tone={tone}>
      {status.kind === "saving" && "Saving…"}
      {status.kind === "saved" && (
        <>
          <span className="ccc-meta-glyph" aria-hidden="true">
            ✓
          </span>{" "}
          Saved
        </>
      )}
      {status.kind === "save-failed" && (
        <>
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          <span>Couldn't save launcher settings.</span>
          <br />
          <span>Check the service in Settings → Diagnostics, then try again.</span>
        </>
      )}
    </p>
  );
}
