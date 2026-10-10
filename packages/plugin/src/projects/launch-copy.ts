import type { LaunchErrorKind } from "@ccc/domain";
import type { PairLineStatus, ProjectLaunchActionId } from "./launch-status.js";

/**
 * The fixed S2 acknowledgement/success copy per launcher (UI-SPEC "Launch
 * acknowledgement and success copy"). Only `claude-code` substitutes
 * `{Terminal}` — every other launcher's visible text is a constant, so a
 * project name never needs to reach this module (the accessible name already
 * carries it, via each button's own `aria-label`).
 *
 * `LAUNCH_ERROR_COPY` below holds the ten D-26 kinds; `renderCopy` is the
 * only substitution path.
 */

const LAUNCHER_DISPLAY_NAMES: Readonly<Record<ProjectLaunchActionId, string>> = {
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  finder: "Finder",
  github: "Your browser",
  "claude-desktop": "Claude Desktop",
  // A single-line error under the pair's key (no per-agent result exists).
  "claude-codex-pair": "Claude + Codex",
};

/** The `{Launcher}` substitution for a D-26 line (UI-SPEC "Launch error copy"). */
export function launcherDisplayName(action: ProjectLaunchActionId): string {
  return LAUNCHER_DISPLAY_NAMES[action];
}

/**
 * The Antigravity terminal opens a TAB, not a window, so its sentences differ
 * (UI-SPEC "Single-launch copy under the Antigravity terminal launcher");
 * without this `Opening a Antigravity window…` would ship. Every other label
 * keeps its Phase 4 wording.
 */
function isAntigravity(terminalLabel: string): boolean {
  return terminalLabel === "Antigravity";
}

const ACKNOWLEDGEMENTS: Readonly<Record<ProjectLaunchActionId, (terminalLabel: string) => string>> =
  {
    antigravity: () => "Opening in Antigravity…",
    "claude-code": (terminalLabel) =>
      isAntigravity(terminalLabel)
        ? "Opening a tab in Antigravity…"
        : `Opening a ${terminalLabel} window…`,
    finder: () => "Revealing in Finder…",
    github: () => "Opening GitHub…",
    "claude-desktop": () => "Opening Claude Desktop…",
    "claude-codex-pair": () => "Opening Claude Code and Codex…",
  };

/** The while-in-flight status line, written into `launchStatus` in the same render as the click (D-40). */
export function launchAcknowledgement(
  action: ProjectLaunchActionId,
  terminalLabel: string,
): string {
  return ACKNOWLEDGEMENTS[action](terminalLabel);
}

const SUCCESS_LINES: Readonly<Record<ProjectLaunchActionId, (terminalLabel: string) => string>> = {
  antigravity: () => "Opened in Antigravity",
  "claude-code": (terminalLabel) =>
    isAntigravity(terminalLabel)
      ? "Opened a tab in Antigravity for Claude Code"
      : `Opened a ${terminalLabel} window for Claude Code`,
  finder: () => "Revealed in Finder",
  github: () => "Opened GitHub in your browser",
  "claude-desktop": () => "Brought Claude Desktop to the front",
  "claude-codex-pair": () => "Opened Claude Code and Codex",
};

/** The `✓` success line, auto-cleared six seconds after it is written (RR-04). */
export function launchSuccessLine(action: ProjectLaunchActionId, terminalLabel: string): string {
  return SUCCESS_LINES[action](terminalLabel);
}

/** The three — and only three — values a launch message may interpolate (UI-SPEC "Launch error copy"). */
export interface LaunchCopyValues {
  readonly launcher: string;
  readonly terminal: string;
  /** `null` for `claude-desktop`, which has no project: a `{project}: ` prefix is dropped. */
  readonly project: string | null;
}

/**
 * Substitutes `{Launcher}`, `{Terminal}` and `{project}` and nothing else.
 * With no project, a leading `{project}: ` is dropped (UI-SPEC "Notices for
 * `claude-desktop` launches").
 */
export function renderCopy(template: string, values: LaunchCopyValues): string {
  let text = template.split("{Launcher}").join(values.launcher);
  text = text.split("{Terminal}").join(values.terminal);
  if (values.project === null) {
    text = text.startsWith("{project}: ") ? text.slice("{project}: ".length) : text;
    return text.split("{project}").join("This project");
  }
  return text.split("{project}").join(values.project);
}

/** The inline action button a D-26 error offers (UI-SPEC "Launch error copy"; RR-16 panes). */
export type LaunchErrorAction =
  | "set-up-launchers"
  | "go-to-projects"
  | "open-automation"
  | "open-privacy-security"
  | "open-codex-settings"
  | "try-again"
  | "set-up-codex";

export interface LaunchErrorCopy {
  /** The inline `▲` line. */
  readonly problem: string;
  /** The inline line under it. */
  readonly nextStep: string;
  readonly action?: LaunchErrorAction;
  /** The Obsidian Notice beside the inline lines. */
  readonly notice: string;
}

/**
 * D-26, fixed and exhaustive: the UI-SPEC table verbatim, except
 * `folder-access-denied`, which follows PR-11. That row stays true whether
 * macOS refused silently or after a prompt the owner declined (spike A3/A6
 * prompted, then allowed): it names what happened — access was blocked —
 * and both remedies, without claiming macOS did or did not ask.
 */
export const LAUNCH_ERROR_COPY: Readonly<Record<LaunchErrorKind, LaunchErrorCopy>> = {
  "service-disconnected": {
    problem: "Couldn't reach the command center service.",
    nextStep: "Check the service in Settings → Diagnostics, then try again.",
    notice:
      "Couldn't reach the command center service. Check it in Settings → Diagnostics, then try again.",
  },
  "launcher-not-configured": {
    problem: "{Launcher} isn't set up yet.",
    nextStep: "Set it up in Settings → Launchers, then try again.",
    action: "set-up-launchers",
    notice: "{Launcher} isn't set up yet. Set it up in Settings → Launchers.",
  },
  "app-not-found": {
    problem: "{Launcher} couldn't be found on this Mac.",
    nextStep: "Reinstall it, or choose a different app in Settings → Launchers.",
    action: "set-up-launchers",
    notice:
      "{Launcher} couldn't be found on this Mac. Choose a different app in Settings → Launchers.",
  },
  "project-missing": {
    problem: "This project's folder no longer exists.",
    nextStep: "Restore the folder, or remove the project in Projects.",
    action: "go-to-projects",
    notice:
      "{project}: the folder no longer exists. Restore it, or remove the project in Projects.",
  },
  "project-moved": {
    problem: "This project's folder moved or was replaced after you registered it.",
    nextStep: "Remove the project in Projects and register the folder again.",
    action: "go-to-projects",
    notice: "{project}: the folder moved or was replaced. Register it again in Projects.",
  },
  "no-github-remote": {
    problem: "This project has no GitHub remote.",
    nextStep: "Add a GitHub remote to the repository, or set a GitHub link in Projects.",
    action: "go-to-projects",
    notice: "{project} has no GitHub remote. Set a GitHub link in Projects.",
  },
  "automation-denied": {
    problem: "macOS blocked the command center from controlling {Terminal}.",
    nextStep: "Allow it in System Settings › Privacy & Security › Automation, then try again.",
    action: "open-automation",
    notice:
      "macOS blocked control of {Terminal}. Allow it in System Settings › Privacy & Security › Automation.",
  },
  "folder-access-denied": {
    problem: "macOS blocked access to this project's folder.",
    nextStep:
      "Move the project out of Documents, Desktop, Downloads or iCloud Drive, or allow access in System Settings › Privacy & Security, then try again. Updating Node.js can make macOS block it again.",
    action: "open-privacy-security",
    notice:
      "{project}: macOS blocked access to the folder. Move the project, or allow access in System Settings › Privacy & Security.",
  },
  timeout: {
    problem: "{Launcher} didn't respond within 5 seconds.",
    nextStep:
      "Check whether it opened. If it didn't, try again or choose Test launcher in Settings → Launchers.",
    notice: "{Launcher} didn't respond within 5 seconds. Check whether it opened.",
  },
  "spawn-failed": {
    problem: "{Launcher} couldn't be started.",
    nextStep: "Check its settings in Settings → Launchers, then choose Test launcher.",
    action: "set-up-launchers",
    notice: "{Launcher} couldn't be started. Check it in Settings → Launchers.",
  },
  // Phase 05.1 (UI-SPEC "Typed errors").
  "bridge-not-installed": {
    action: "open-codex-settings",
    problem: "The Antigravity terminal bridge isn't installed.",
    nextStep:
      "Install it from Settings → Codex, or switch to Terminal in Settings → Launchers, then try again.",
    notice:
      "The Antigravity terminal bridge isn't installed. Install it from Settings → Codex, or switch to Terminal in Settings → Launchers.",
  },
  "bridge-outdated": {
    action: "open-codex-settings",
    problem: "The Antigravity terminal bridge is out of date.",
    nextStep: "Run its install step again from Settings → Codex, then try again.",
    notice:
      "The Antigravity terminal bridge is out of date. Run its install step again from Settings → Codex.",
  },
  "window-not-ready": {
    action: "try-again",
    problem: "Antigravity is still starting.",
    nextStep: "Its window is opening now. Try again in a few seconds.",
    notice: "Antigravity is still starting. Try again in a few seconds.",
  },
};

/** The visible label of each inline action button (UI-SPEC table; PR-11 for Privacy & Security). */
export const LAUNCH_ERROR_ACTION_LABELS: Readonly<Record<LaunchErrorAction, string>> = {
  "set-up-launchers": "Set up launchers",
  "go-to-projects": "Go to Projects",
  "open-automation": "Open Automation settings",
  "open-privacy-security": "Open Privacy & Security settings",
  "open-codex-settings": "Open Codex settings",
  "try-again": "Try again",
  "set-up-codex": "Set up Codex",
};

/** The D-26 Notice for a failed launch (UI-SPEC "Launch error copy", PR-11 for `folder-access-denied`). */
export function launchErrorNotice(kind: LaunchErrorKind, values: LaunchCopyValues): string {
  return renderCopy(LAUNCH_ERROR_COPY[kind].notice, values);
}

const ANNOUNCEMENTS: Readonly<
  Record<ProjectLaunchActionId, (terminal: string, project: string) => string>
> = {
  antigravity: (_terminal, project) => `Opening ${project} in Antigravity…`,
  "claude-code": (terminal, project) =>
    isAntigravity(terminal)
      ? `Opening a tab in Antigravity for Claude Code in ${project}…`
      : `Opening a ${terminal} window for Claude Code in ${project}…`,
  finder: (_terminal, project) => `Revealing ${project} in Finder…`,
  github: (_terminal, project) => `Opening ${project} on GitHub…`,
  "claude-desktop": () => "Opening Claude Desktop…",
  "claude-codex-pair": (_terminal, project) => `Opening Claude Code and Codex in ${project}…`,
};

/**
 * The live-region announcement while a launch is in flight (UI-SPEC S2
 * table). It names the project, which the visible line never does; the S9
 * quick-switcher posts the same text as its acknowledgement Notice.
 */
export function launchAnnouncement(
  action: ProjectLaunchActionId,
  terminalLabel: string,
  projectName: string,
): string {
  return ANNOUNCEMENTS[action](terminalLabel, projectName);
}

// ---------------------------------------------------------------------------
// Pair launch (Phase 05.1, UI-SPEC S2 "Per-agent two-line status")

/** The two agents of a pair, Claude Code first (D-10). */
export type PairAgent = "claude" | "codex";

/** The `{Launcher}` for a pair line: the agent's name. */
export const PAIR_AGENT_NAMES: Readonly<Record<PairAgent, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** The Codex setup line body (C-09): a setup state, never an error. */
export const PAIR_CODEX_SETUP_TEXT =
  "Codex isn't set up yet. Install it, then add it in Settings → Launchers.";

/** The hidden description of the pair button when Codex is known to be missing (D-10). */
export const PAIR_CODEX_MISSING_NOTE = "Codex isn't set up, so only Claude Code will open.";

function pairOpeningText(terminalLabel: string): string {
  return isAntigravity(terminalLabel)
    ? "Opening a tab in Antigravity…"
    : `Opening a ${terminalLabel} window…`;
}

function pairOpenedText(terminalLabel: string): string {
  return isAntigravity(terminalLabel)
    ? "Opened in an Antigravity tab"
    : `Opened a ${terminalLabel} window`;
}

/**
 * The text of one agent's pair line, without its glyph. Every state has its
 * own words, so colour is never the only cue. `{Launcher}` in an error row is
 * the agent's name; the project name is substituted only where a Notice row
 * needs it, and the visible lines never carry it.
 */
export function pairLineText(
  agent: PairAgent,
  line: PairLineStatus,
  terminalLabel: string,
  projectName: string,
): string {
  const name = PAIR_AGENT_NAMES[agent];
  switch (line.kind) {
    case "opening":
      return `${name}: ${pairOpeningText(terminalLabel)}`;
    case "success":
      return `${name}: ${pairOpenedText(terminalLabel)}`;
    case "setup":
      return `${name}: ${PAIR_CODEX_SETUP_TEXT}`;
    case "error": {
      const copy = LAUNCH_ERROR_COPY[line.error];
      const values = { launcher: name, terminal: terminalLabel, project: projectName };
      return `${name}: ${renderCopy(copy.problem, values)} ${renderCopy(copy.nextStep, values)}`;
    }
  }
}

/**
 * What the pair region's hidden live announcement reads: the opening sentence
 * naming the project while either line is opening, otherwise the two line
 * statements and nothing else (UI-SPEC S2).
 */
export function pairAnnouncement(
  claude: PairLineStatus,
  codex: PairLineStatus,
  terminalLabel: string,
  projectName: string,
): string {
  if (claude.kind === "opening" || codex.kind === "opening") {
    return launchAnnouncement("claude-codex-pair", terminalLabel, projectName);
  }
  const statement = (agent: PairAgent, line: PairLineStatus): string =>
    pairLineText(agent, line, terminalLabel, projectName).replace(/\.$/, "");
  return `${statement("claude", claude)}. ${statement("codex", codex)}.`;
}
