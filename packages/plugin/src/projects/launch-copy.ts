import type { LaunchAction, LaunchErrorKind } from "@ccc/domain";

/**
 * The fixed S2 acknowledgement/success copy per launcher (UI-SPEC "Launch
 * acknowledgement and success copy"). Only `claude-code` substitutes
 * `{Terminal}` — every other launcher's visible text is a constant, so a
 * project name never needs to reach this module (the accessible name already
 * carries it, via each button's own `aria-label`).
 *
 * Task 2 adds `LAUNCH_ERROR_COPY` and `renderCopy` for the ten D-26 kinds.
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

const NOTICE_TEMPLATES: Readonly<Record<LaunchErrorKind, string>> = {
  "service-disconnected":
    "Couldn't reach the command center service. Check it in Settings → Diagnostics, then try again.",
  "launcher-not-configured": "{Launcher} isn't set up yet. Set it up in Settings → Launchers.",
  "app-not-found":
    "{Launcher} couldn't be found on this Mac. Choose a different app in Settings → Launchers.",
  "project-missing":
    "{project}: the folder no longer exists. Restore it, or remove the project in Projects.",
  "project-moved": "{project}: the folder moved or was replaced. Register it again in Projects.",
  "no-github-remote": "{project} has no GitHub remote. Set a GitHub link in Projects.",
  "automation-denied":
    "macOS blocked control of {Terminal}. Allow it in System Settings › Privacy & Security › Automation.",
  "folder-access-denied":
    "{project}: macOS blocked access to the folder. Move the project, or allow access in System Settings › Privacy & Security.",
  timeout: "{Launcher} didn't respond within 5 seconds. Check whether it opened.",
  "spawn-failed": "{Launcher} couldn't be started. Check it in Settings → Launchers.",
};

/** The D-26 Notice for a failed launch (UI-SPEC "Launch error copy", PR-11 for `folder-access-denied`). */
export function launchErrorNotice(kind: LaunchErrorKind, values: LaunchCopyValues): string {
  return renderCopy(NOTICE_TEMPLATES[kind], values);
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
