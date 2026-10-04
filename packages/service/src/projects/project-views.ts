import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type GithubTarget,
  type LauncherStatus,
  type LaunchersSummary,
  type ProjectGitState,
  type ProjectView,
  parseStoredLauncherConfig,
  type TerminalChoice,
} from "@ccc/domain";
import { normaliseRemote, parseGithubOverride } from "@ccc/launchers";
import type { LauncherConfigRecord, ProjectRecord } from "@ccc/operational-store";

/**
 * Pure builders for what the plugin sees of a project (D-01, D-43).
 *
 * The invariant: a view carries a ProjectId, a display name and a
 * home-abbreviated `displayPath`, never the absolute path the store holds.
 * Abbreviating here, in the service, means there is nothing for the plugin
 * to leak into a Notice, a log line or a screenshot. Rejected alternative:
 * sending the absolute path and letting the plugin abbreviate for display —
 * that puts the path in plugin memory and in every stringified view.
 *
 * The GitHub target is a display label only (`github.com/owner/repo`); the
 * service rebuilds the URL from its own stored data at launch time
 * (PROJ-14), so no URL string crosses the wire.
 */

/**
 * The home directory in the one form every home comparison uses: its native
 * realpath (the lexical form when it does not resolve). Stored project paths
 * are realpaths, so `toDisplayPath` and `detectProtectedLocation` only agree
 * with the store when they are handed this form. Resolved ONCE at
 * composition (`main.ts`) and passed to both, never per call: the protected
 * check must stay free of filesystem reads (PR-04).
 */
export function resolveHomeDir(homeDir: string = homedir()): string {
  try {
    return realpathSync.native(homeDir);
  } catch {
    return path.resolve(homeDir);
  }
}

/**
 * `~` for the home directory itself, `~/rest` for anything strictly inside
 * it, and the path unchanged otherwise. A sibling that merely shares the
 * home's name as a prefix (`code-archive` beside a home of `code`) is
 * outside home.
 */
export function toDisplayPath(absolutePath: string, homeDir: string): string {
  if (homeDir.length === 0 || homeDir === "/") return absolutePath;
  if (absolutePath === homeDir) return "~";
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  return absolutePath.startsWith(prefix) ? `~/${absolutePath.slice(prefix.length)}` : absolutePath;
}

function githubTarget(record: ProjectRecord, git: ProjectGitState): GithubTarget {
  if (record.githubUrlOverride !== null) {
    const override = parseGithubOverride(record.githubUrlOverride);
    if (override !== null) {
      return {
        kind: "github",
        label: `github.com/${override.owner}/${override.repo}`,
        source: "override",
      };
    }
  }
  if (git.kind === "repo" && git.remote !== null) {
    // The remote is already reduced to host + path by the git runner; run it
    // back through the one normaliser so "is this GitHub" has one answer.
    const remote = normaliseRemote(`https://${git.remote.host}/${git.remote.path}`);
    if (remote.kind === "github") {
      return {
        kind: "github",
        label: `github.com/${remote.owner}/${remote.repo}`,
        source: "remote",
      };
    }
  }
  return { kind: "none" };
}

/** The plugin-facing view of one project, from its store record and its latest git state. */
export function buildProjectView(
  record: ProjectRecord,
  git: ProjectGitState,
  observedAt: string | null,
  gitReadFailed: boolean,
  homeDir: string,
): ProjectView {
  return {
    projectId: record.projectId,
    displayName: record.displayName,
    displayPath: toDisplayPath(record.path, homeDir),
    pinned: record.pinned,
    lastOpenedAt: record.lastOpenedAt,
    observedAt,
    gitReadFailed,
    git,
    github: githubTarget(record, git),
  };
}

/** The toolbar's name for where a Claude Code launch lands (UI-SPEC S2). */
const PRESET_LABELS: Readonly<Record<string, string>> = {
  iterm2: "iTerm2",
  ghostty: "Ghostty",
  wezterm: "WezTerm",
  blank: "Your terminal",
};

function terminalLabel(terminal: TerminalChoice): string {
  return terminal.kind === "terminal-app"
    ? "Terminal"
    : (PRESET_LABELS[terminal.preset] ?? "Your terminal");
}

function statusOf(record: LauncherConfigRecord | undefined, parses: boolean): LauncherStatus {
  if (record === undefined || !parses) return "not-set-up";
  return record.tested ? "tested" : "set-up";
}

/**
 * Per-launcher setup state (RR-14). A row that no longer parses against its
 * stored schema reads as not set up — the same rule the launch path applies,
 * so the toolbar never offers a launcher the service would refuse.
 */
export function launchersSummary(configs: readonly LauncherConfigRecord[]): LaunchersSummary {
  const byId = new Map(configs.map((config) => [config.launcherId, config]));
  const antigravity = byId.get("antigravity");
  const desktop = byId.get("claude-desktop");
  const claudeCode = byId.get("claude-code");
  const claudeCodeConfig =
    claudeCode === undefined ? null : parseStoredLauncherConfig("claude-code", claudeCode.config);
  return {
    antigravity: statusOf(
      antigravity,
      antigravity !== undefined &&
        parseStoredLauncherConfig("antigravity", antigravity.config) !== null,
    ),
    "claude-code": {
      status: statusOf(claudeCode, claudeCodeConfig !== null),
      terminalLabel:
        claudeCodeConfig === null ? "Terminal" : terminalLabel(claudeCodeConfig.terminal),
    },
    "claude-desktop": statusOf(
      desktop,
      desktop !== undefined && parseStoredLauncherConfig("claude-desktop", desktop.config) !== null,
    ),
  };
}
