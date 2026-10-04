import type { LaunchAction, LaunchErrorKind } from "@ccc/domain";

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

const LAUNCHER_DISPLAY_NAMES: Readonly<Record<LaunchAction, string>> = {
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  finder: "Finder",
  github: "Your browser",
  "claude-desktop": "Claude Desktop",
};

/** The `{Launcher}` substitution for a D-26 line (UI-SPEC "Launch error copy"). */
export function launcherDisplayName(action: LaunchAction): string {
  return LAUNCHER_DISPLAY_NAMES[action];
}

const ACKNOWLEDGEMENTS: Readonly<Record<LaunchAction, (terminalLabel: string) => string>> = {
  antigravity: () => "Opening in Antigravity…",
  "claude-code": (terminalLabel) => `Opening a ${terminalLabel} window…`,
  finder: () => "Revealing in Finder…",
  github: () => "Opening GitHub…",
  "claude-desktop": () => "Opening Claude Desktop…",
};

/** The while-in-flight status line, written into `launchStatus` in the same render as the click (D-40). */
export function launchAcknowledgement(action: LaunchAction, terminalLabel: string): string {
  return ACKNOWLEDGEMENTS[action](terminalLabel);
}

const SUCCESS_LINES: Readonly<Record<LaunchAction, (terminalLabel: string) => string>> = {
  antigravity: () => "Opened in Antigravity",
  "claude-code": (terminalLabel) => `Opened a ${terminalLabel} window for Claude Code`,
  finder: () => "Revealed in Finder",
  github: () => "Opened GitHub in your browser",
  "claude-desktop": () => "Brought Claude Desktop to the front",
};

/** The `✓` success line, auto-cleared six seconds after it is written (RR-04). */
export function launchSuccessLine(action: LaunchAction, terminalLabel: string): string {
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
  | "open-privacy-security";

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
};

/** The visible label of each inline action button (UI-SPEC table; PR-11 for Privacy & Security). */
export const LAUNCH_ERROR_ACTION_LABELS: Readonly<Record<LaunchErrorAction, string>> = {
  "set-up-launchers": "Set up launchers",
  "go-to-projects": "Go to Projects",
  "open-automation": "Open Automation settings",
  "open-privacy-security": "Open Privacy & Security settings",
};

/** The D-26 Notice for a failed launch (UI-SPEC "Launch error copy", PR-11 for `folder-access-denied`). */
export function launchErrorNotice(kind: LaunchErrorKind, values: LaunchCopyValues): string {
  return renderCopy(LAUNCH_ERROR_COPY[kind].notice, values);
}

const ANNOUNCEMENTS: Readonly<Record<LaunchAction, (terminal: string, project: string) => string>> =
  {
    antigravity: (_terminal, project) => `Opening ${project} in Antigravity…`,
    "claude-code": (terminal, project) =>
      `Opening a ${terminal} window for Claude Code in ${project}…`,
    finder: (_terminal, project) => `Revealing ${project} in Finder…`,
    github: (_terminal, project) => `Opening ${project} on GitHub…`,
    "claude-desktop": () => "Opening Claude Desktop…",
  };

/**
 * The live-region announcement while a launch is in flight (UI-SPEC S2
 * table). It names the project, which the visible line never does; the S9
 * quick-switcher posts the same text as its acknowledgement Notice.
 */
export function launchAnnouncement(
  action: LaunchAction,
  terminalLabel: string,
  projectName: string,
): string {
  return ANNOUNCEMENTS[action](terminalLabel, projectName);
}
