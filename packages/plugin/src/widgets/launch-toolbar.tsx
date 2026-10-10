import type { GithubTarget, LaunchAction, ProjectId } from "@ccc/domain";
import { LAUNCH_PAIR_ACTION } from "@ccc/domain/launch.js";
import type { VNode } from "preact";
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  LAUNCH_ERROR_ACTION_LABELS,
  LAUNCH_ERROR_COPY,
  type LaunchErrorAction,
  launchAcknowledgement,
  launchAnnouncement,
  launcherDisplayName,
  launchSuccessLine,
  PAIR_CODEX_MISSING_NOTE,
  type PairAgent,
  pairAnnouncement,
  pairLineText,
  renderCopy,
} from "../projects/launch-copy.js";
import {
  isLaunchOpening,
  latestLaunchStatus,
  launchStatus,
  launchStatusKey,
  type PairLaunchStatus,
  type PairLineStatus,
  type ProjectLaunchActionId,
  setLaunchError,
} from "../projects/launch-status.js";
import type { DestinationId } from "../view/destinations.js";
import { requestLaunchersFocus } from "../view/launchers-focus.js";
import { codexInstalled } from "./codex-install-state.js";
import type { QuickActionDescriptor } from "./contract.js";
import { nextToolbarIndex } from "./toolbar-keys.js";

/**
 * The S2 launch toolbar and its status line (UI-SPEC S2, D-24, D-35, D-40).
 *
 * Each button emits a `launch:*` DESCRIPTOR through `onQuickAction` — the
 * one dispatcher — and does nothing else: this module imports nothing from
 * `obsidian` or the service client package, so no widget can launch around
 * the choke point Phase 6's approval check is inserted into. It only READS
 * the shared launch status store, which the requester writes synchronously
 * before any await, so the in-flight state renders in the same pass as the
 * click.
 */

interface LaunchButtonSpec {
  readonly action: Exclude<LaunchAction, "claude-desktop"> | typeof LAUNCH_PAIR_ACTION;
  readonly label: string;
  readonly ariaLabel: (project: string) => string;
}

/**
 * D-35's four labels plus the pair's fifth (UI-SPEC S2: Antigravity, Claude
 * Code, Claude + Codex, Finder, GitHub), in order, and their accessible names
 * (UI-SPEC "Launch button labels"). The pair's visible label is contained in
 * its accessible name (WCAG 2.5.3).
 */
const LAUNCH_BUTTONS: readonly LaunchButtonSpec[] = [
  { action: "antigravity", label: "Antigravity", ariaLabel: (p) => `Open ${p} in Antigravity` },
  { action: "claude-code", label: "Claude Code", ariaLabel: (p) => `Start Claude Code in ${p}` },
  {
    action: LAUNCH_PAIR_ACTION,
    label: "Claude + Codex",
    ariaLabel: (p) => `Open ${p} with Claude + Codex`,
  },
  { action: "finder", label: "Finder", ariaLabel: (p) => `Reveal ${p} in Finder` },
  { action: "github", label: "GitHub", ariaLabel: (p) => `Open ${p} on GitHub` },
];

/**
 * The full-phrase accessible name of one project action — also the S9
 * quick-switcher's item text, so a screen-reader user, a keyboard user and a
 * switcher user all meet one vocabulary (UI-SPEC "Launch button labels",
 * RR-02).
 */
export function launchPhrase(action: ProjectLaunchActionId, projectName: string): string {
  const spec = LAUNCH_BUTTONS.find((candidate) => candidate.action === action);
  // `claude-desktop` has no project: its visible label is the full phrase (S8).
  return spec === undefined ? CLAUDE_DESKTOP_PHRASE : spec.ariaLabel(projectName);
}

/** S8's and S9's text for the one launch with no project. */
export const CLAUDE_DESKTOP_PHRASE = "Open Claude Desktop";

/** The five project actions a row's single status line reports on. */
export const PROJECT_LAUNCH_ACTIONS: readonly ProjectLaunchActionId[] = LAUNCH_BUTTONS.map(
  (spec) => spec.action,
);

/**
 * The descriptor a launch button, the quick switcher and `Try again` all emit
 * for one project action: the one dispatcher's input, never a callback with a
 * side effect (D-24).
 */
export function launchDescriptor(
  action: Exclude<LaunchAction, "claude-desktop"> | typeof LAUNCH_PAIR_ACTION,
  projectId: ProjectId,
  projectName: string,
): QuickActionDescriptor {
  return {
    id: `launch-${action}`,
    label: launchPhrase(action, projectName),
    capability: `launch:${action}`,
    target: { projectId },
  };
}

/** The descriptor `Open Codex settings` emits; the dispatcher resolves it to Settings plus a Notice. */
export const OPEN_CODEX_SETTINGS_DESCRIPTOR: QuickActionDescriptor = {
  id: "connect-codex-settings",
  label: "Open Codex settings",
  capability: "connect:codex-settings",
};

export interface LaunchToolbarProps {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly github: GithubTarget;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

export function LaunchToolbar({
  projectId,
  projectName,
  github,
  onQuickAction,
}: LaunchToolbarProps): VNode {
  const statuses = launchStatus.value;
  const noRemoteNoteId = useId();
  const codexMissingNoteId = useId();
  // Only an explicit `false` shows the note; unknown shows nothing (R-10).
  const codexMissing = codexInstalled.value === false;
  // Enabled when the remote's host is github.com or an override link is set
  // (D-13) — both arrive as `kind: "github"`.
  const hasGithub = github.kind === "github";
  const [focusedIndex, setFocusedIndex] = useState(0);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The index of the button that holds focus, kept while focus is merely
  // LOST (a keyed reorder moves this row's DOM, which drops focus to the
  // body) and cleared when the owner moves focus somewhere real.
  const heldFocusRef = useRef<number | null>(null);

  // UI-SPEC S2 "Focus never moves because of a launch": after any render
  // (a post-launch refresh that reorders rows, or a pin), put focus back on
  // the same button if — and only if — it fell to the body.
  useLayoutEffect(() => {
    const index = heldFocusRef.current;
    if (index === null) return;
    const button = buttonRefs.current[index];
    if (button == null) return;
    const active = button.ownerDocument.activeElement;
    if (active === button) return;
    if (active === null || active === button.ownerDocument.body) button.focus();
  });

  function handleKeyDown(event: KeyboardEvent): void {
    const next = nextToolbarIndex(focusedIndex, event.key, LAUNCH_BUTTONS.length);
    if (next === focusedIndex) return;
    event.preventDefault();
    setFocusedIndex(next);
    buttonRefs.current[next]?.focus();
  }

  function activate(spec: LaunchButtonSpec): void {
    const key = launchStatusKey(projectId, spec.action);
    if (isLaunchOpening(statuses.get(key))) return;
    // GitHub with nowhere to go: say why, inline, and send nothing (UI-SPEC S2).
    if (spec.action === "github" && !hasGithub) {
      setLaunchError(key, "no-github-remote");
      return;
    }
    onQuickAction?.(launchDescriptor(spec.action, projectId, projectName));
  }

  return (
    <div
      role="toolbar"
      aria-label={`${projectName} actions`}
      className="ccc-launch-toolbar"
      onKeyDown={handleKeyDown}
    >
      {LAUNCH_BUTTONS.map((spec, index) => {
        const opening = isLaunchOpening(statuses.get(launchStatusKey(projectId, spec.action)));
        const noRemote = spec.action === "github" && !hasGithub;
        const pairNote = spec.action === LAUNCH_PAIR_ACTION && codexMissing;
        return (
          <button
            key={spec.action}
            type="button"
            className="ccc-quick-action"
            aria-label={spec.ariaLabel(projectName)}
            aria-disabled={opening || noRemote ? "true" : undefined}
            aria-describedby={noRemote ? noRemoteNoteId : pairNote ? codexMissingNoteId : undefined}
            data-launch-state={opening ? "opening" : undefined}
            tabIndex={index === focusedIndex ? 0 : -1}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            onFocus={() => {
              setFocusedIndex(index);
              heldFocusRef.current = index;
            }}
            onBlur={(event) => {
              // Focus that moved to a real element, or left a button still in
              // the document (a click on empty chrome, the window losing
              // focus), was moved by the owner and is never taken back. Only
              // a button pulled out of the document mid-move keeps its claim.
              if (event.relatedTarget !== null || event.currentTarget.isConnected) {
                heldFocusRef.current = null;
              }
            }}
            onClick={() => activate(spec)}
          >
            {spec.label}
          </button>
        );
      })}
      {!hasGithub && (
        <span id={noRemoteNoteId} className="ccc-visually-hidden">
          No GitHub remote
        </span>
      )}
      {codexMissing && (
        <span id={codexMissingNoteId} className="ccc-visually-hidden">
          {PAIR_CODEX_MISSING_NOTE}
        </span>
      )}
    </div>
  );
}

export interface LaunchStatusLineProps {
  /** `null` for the S8 Claude Desktop line. */
  readonly projectId: ProjectId | null;
  /** The project's display name for the hidden announcement; ignored for `claude-desktop`. */
  readonly projectName: string;
  /** The Claude Code terminal's display label (UI-SPEC `{Terminal}`). */
  readonly terminalLabel: string;
  readonly actions: readonly ProjectLaunchActionId[];
  /** `true` on the Projects destination, where `Go to Projects` would go nowhere. */
  readonly inProjects?: boolean | undefined;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
  /** Opens one of the two fixed System Settings panes through the service (RR-16). */
  readonly openSystemSettings?: ((pane: "automation" | "privacy-security") => void) | undefined;
  /** Emits a descriptor for `Try again` and `Open Codex settings`: the one dispatcher, never a side effect. */
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

/** What a pair line's glyph and tone are, per state. Opening carries no glyph. */
const PAIR_LINE_GLYPHS: Readonly<
  Record<PairLineStatus["kind"], { readonly glyph: string | null; readonly className: string }>
> = {
  opening: { glyph: null, className: "" },
  success: { glyph: "✓", className: "ccc-meta-glyph" },
  error: { glyph: "▲", className: "ccc-error-glyph" },
  setup: { glyph: "◌", className: "ccc-meta-glyph" },
};

/** The inline action an error or setup line offers, before availability is applied. */
function lineAction(agent: PairAgent, line: PairLineStatus): LaunchErrorAction | null {
  if (line.kind === "setup") return "set-up-codex";
  if (line.kind !== "error") return null;
  const action = LAUNCH_ERROR_COPY[line.error].action ?? null;
  // A Codex line never offers `Set up launchers`: Codex's missing install is
  // the setup line, never launcher-not-configured (UI-SPEC S2).
  return agent === "codex" && action === "set-up-launchers" ? null : action;
}

/**
 * The persistent `role="status"` line under a toolbar (Accessibility Floor
 * 2: the region exists, empty, before its text ever changes). It shows the
 * most recent status among `actions`; the visible copy never names the
 * project, while a visually hidden announcement does (UI-SPEC S2 table). An
 * error's optional action button follows the region rather than sitting
 * inside it, so the announcement is the two lines and nothing else.
 *
 * When the latest status is the pair's, the SAME region element holds exactly
 * two agent lines, Claude Code first, each with its own tone, glyph and words
 * (UI-SPEC S2, R-11). One agent's line never depends on the other's.
 */
export function LaunchStatusLine({
  projectId,
  projectName,
  terminalLabel,
  actions,
  inProjects = false,
  onNavigate,
  openSystemSettings,
  onQuickAction,
}: LaunchStatusLineProps): VNode {
  const latest = latestLaunchStatus(launchStatus.value, projectId, actions);
  const status = latest?.status;
  const pair: PairLaunchStatus | null = status?.kind === "pair" ? status : null;
  const single = pair === null ? status : undefined;
  const tone =
    single === undefined || single.kind === "opening"
      ? undefined
      : single.kind === "success"
        ? "success"
        : "error";

  let errorLines: { problem: string; nextStep: string } | null = null;
  let errorActions: LaunchErrorAction[] = [];
  if (single?.kind === "error" && latest !== null) {
    const copy = LAUNCH_ERROR_COPY[single.error];
    const values = {
      launcher: launcherDisplayName(latest.action),
      terminal: terminalLabel,
      project: projectId === null ? null : projectName,
    };
    errorLines = {
      problem: renderCopy(copy.problem, values),
      nextStep: renderCopy(copy.nextStep, values),
    };
    errorActions = copy.action === undefined ? [] : [copy.action];
  } else if (pair !== null) {
    // One button per distinct action, in line order (Claude Code first).
    const wanted = [lineAction("claude", pair.claude), lineAction("codex", pair.codex)];
    errorActions = wanted.filter(
      (action, index): action is LaunchErrorAction =>
        action !== null && wanted.indexOf(action) === index,
    );
  }
  // A button renders only when it can act: `Go to Projects` is pointless in
  // Projects, a surface with no System Settings route omits those two
  // buttons (the next-step line already names the path, RR-16), and the two
  // descriptor buttons need the dispatcher.
  const canAct = (action: LaunchErrorAction): boolean => {
    switch (action) {
      case "go-to-projects":
        return !inProjects && onNavigate !== undefined;
      case "set-up-launchers":
      case "set-up-codex":
        return onNavigate !== undefined;
      case "open-automation":
      case "open-privacy-security":
        return openSystemSettings !== undefined;
      case "open-codex-settings":
      case "try-again":
        return onQuickAction !== undefined && projectId !== null && latest !== null;
    }
  };
  errorActions = errorActions.filter(canAct);

  function runErrorAction(action: LaunchErrorAction): void {
    switch (action) {
      case "set-up-launchers":
      case "set-up-codex":
        requestLaunchersFocus();
        onNavigate?.("settings");
        return;
      case "go-to-projects":
        onNavigate?.("projects");
        return;
      case "open-automation":
        openSystemSettings?.("automation");
        return;
      case "open-privacy-security":
        openSystemSettings?.("privacy-security");
        return;
      case "open-codex-settings":
        onQuickAction?.(OPEN_CODEX_SETTINGS_DESCRIPTOR);
        return;
      case "try-again": {
        // Re-emits the same descriptor the failed launch came from. `claude-desktop`
        // has no project, and a retry for it is never offered (window-not-ready
        // cannot occur there).
        if (latest === null || projectId === null || latest.action === "claude-desktop") return;
        onQuickAction?.(launchDescriptor(latest.action, projectId, projectName));
        return;
      }
    }
  }

  return (
    <>
      <p
        role="status"
        className={pair === null ? "ccc-launch-status" : "ccc-launch-status ccc-launch-status-pair"}
        data-tone={tone}
      >
        {single?.kind === "opening" && latest !== null && (
          <>
            <span aria-hidden="true">{launchAcknowledgement(latest.action, terminalLabel)}</span>
            <span className="ccc-visually-hidden">
              {launchAnnouncement(latest.action, terminalLabel, projectName)}
            </span>
          </>
        )}
        {single?.kind === "success" && latest !== null && (
          <>
            <span className="ccc-meta-glyph" aria-hidden="true">
              ✓
            </span>{" "}
            {launchSuccessLine(latest.action, terminalLabel)}
          </>
        )}
        {errorLines !== null && (
          <>
            <span className="ccc-error-glyph" aria-hidden="true">
              ▲
            </span>
            {errorLines.problem}
            <br />
            {errorLines.nextStep}
          </>
        )}
        {pair !== null && (
          <>
            <PairLine agent="claude" line={pair.claude} terminalLabel={terminalLabel} />
            <PairLine agent="codex" line={pair.codex} terminalLabel={terminalLabel} />
            <span className="ccc-visually-hidden">
              {pairAnnouncement(pair.claude, pair.codex, terminalLabel, projectName)}
            </span>
          </>
        )}
      </p>
      {errorActions.map((action) => (
        <button
          key={action}
          type="button"
          className="ccc-list-more"
          onClick={() => runErrorAction(action)}
        >
          {LAUNCH_ERROR_ACTION_LABELS[action]}
        </button>
      ))}
    </>
  );
}

/**
 * One agent's line. It is hidden from assistive technology on purpose: the
 * region's hidden announcement says the two statements once, so a screen
 * reader never hears each line twice. The project name is never rendered here.
 */
function PairLine({
  agent,
  line,
  terminalLabel,
}: {
  readonly agent: PairAgent;
  readonly line: PairLineStatus;
  readonly terminalLabel: string;
}): VNode {
  const { glyph, className } = PAIR_LINE_GLYPHS[line.kind];
  return (
    <span
      className="ccc-launch-agent-line"
      data-agent={agent}
      data-tone={line.kind}
      aria-hidden="true"
    >
      {glyph !== null && (
        <>
          <span className={className} aria-hidden="true">
            {glyph}
          </span>{" "}
        </>
      )}
      {pairLineText(agent, line, terminalLabel, "")}
    </span>
  );
}
