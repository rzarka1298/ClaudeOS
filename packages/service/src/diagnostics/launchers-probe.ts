import {
  LAUNCHERS_REASON_STATUS,
  type LauncherPartId,
  type ProbeOutcome,
  parseStoredLauncherConfig,
  type SetupAction,
  type TerminalChoice,
} from "@ccc/domain";
import { bounded, noAnswer, type Part, partOf, rowOfParts } from "./probe-kit.js";

/**
 * The app launchers row (plan 08-08; D-04, D-05, D-49; T-08-19, T-08-20, T-08-21, T-08-22b): one
 * part per launcher (Antigravity, Claude Code, Claude Desktop, Codex) and a terminal part only
 * for a custom terminal choice. It reads the saved launcher rows and nothing else, and it never
 * launches anything: the launcher Test button stays the only path that does.
 *
 * - An app is checked with the bounded `probeBundle` (one `mdfind`, at most two `plutil` reads,
 *   fixed argv, absolute binaries, the probe's own abort signal, no folder scan): found is ready
 *   when the owner has tested it and untested otherwise; not found is `bundle-not-found`; a lookup
 *   that cannot decide is `bundle-check-unavailable`.
 * - An executable (Claude Code, Codex, a custom terminal's `argv[0]`) is checked only when its
 *   stored path is absolute, NUL-free and at most 4,096 characters, and then only with a
 *   regular-file-and-execute check. Nothing is opened, read or run.
 *
 * No part returns a path, a bundle id, an argument or an executable string.
 */

/** One saved launcher row as the probe sees it. */
export interface LauncherRow {
  readonly launcherId: string;
  readonly config: unknown;
  readonly tested: boolean;
}

export type BundleProbeAnswer = "found" | "not-found" | "indeterminate";

/**
 * The only three things the probe may ask of the machine. There is no member that launches, spawns
 * or writes, and the two checks that touch the machine are read-only.
 */
export interface LaunchersProbePorts {
  /** Every readable saved launcher row. */
  readonly listConfigs: () => readonly LauncherRow[];
  /** The bounded bundle lookup. It receives the probe's own signal, unchanged. */
  readonly probeBundle: (
    bundleId: string,
    options: { signal?: AbortSignal },
  ) => Promise<BundleProbeAnswer>;
  /** A regular file with the execute bit (`stat` plus `access`); never opens or runs it. */
  readonly isExecutableFile: (path: string) => Promise<boolean>;
}

const TABLE = LAUNCHERS_REASON_STATUS;
const GO_LAUNCHERS: SetupAction = { kind: "go-to-section", section: "launchers" };
const MAX_PATH_LENGTH = 4096;

/** A stored executable path worth a file-system call: absolute, NUL-free, bounded. */
function isCheckablePath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\u0000") && path.length <= MAX_PATH_LENGTH;
}

function notSetUp(partId: LauncherPartId): Part {
  return partOf(TABLE, partId, "launcher-not-set-up", { setupAction: GO_LAUNCHERS });
}

/** The part for something found: ready once tested, untested before. */
function foundPart(partId: LauncherPartId, tested: boolean): Part {
  return tested
    ? partOf(TABLE, partId, "launcher-ready")
    : partOf(TABLE, partId, "launcher-untested", { setupAction: GO_LAUNCHERS });
}

async function appPart(
  ports: LaunchersProbePorts,
  signal: AbortSignal,
  partId: "antigravity" | "claude-desktop",
  saved: LauncherRow | undefined,
): Promise<Part> {
  const config = saved === undefined ? null : parseStoredLauncherConfig(partId, saved.config);
  if (saved === undefined || config === null) return notSetUp(partId);
  const looked = await bounded(signal, () => ports.probeBundle(config.bundleId, { signal }));
  if (looked.kind === "timeout") return partOf(TABLE, partId, "probe-timeout");
  if (looked.kind === "error") return partOf(TABLE, partId, "probe-error");
  switch (looked.value) {
    case "found":
      return foundPart(partId, saved.tested);
    case "not-found":
      return partOf(TABLE, partId, "bundle-not-found", { setupAction: GO_LAUNCHERS });
    case "indeterminate":
      return partOf(TABLE, partId, "bundle-check-unavailable");
  }
}

/** The executable check shared by Claude Code, Codex and a custom terminal. */
async function executableState(
  ports: LaunchersProbePorts,
  signal: AbortSignal,
  path: string,
): Promise<"executable" | "missing" | "timeout" | "error"> {
  if (!isCheckablePath(path)) return "missing";
  const checked = await bounded(signal, () => ports.isExecutableFile(path));
  if (checked.kind === "timeout") return "timeout";
  if (checked.kind === "error") return "error";
  return checked.value ? "executable" : "missing";
}

async function executablePart(
  ports: LaunchersProbePorts,
  signal: AbortSignal,
  partId: "claude-code" | "codex" | "terminal",
  path: string,
  tested: boolean,
): Promise<Part> {
  const state = await executableState(ports, signal, path);
  switch (state) {
    case "timeout":
      return partOf(TABLE, partId, "probe-timeout");
    case "error":
      return partOf(TABLE, partId, "probe-error");
    case "missing":
      return partOf(
        TABLE,
        partId,
        partId === "terminal" ? "terminal-not-found" : "executable-not-found",
        { setupAction: GO_LAUNCHERS },
      );
    case "executable":
      return foundPart(partId, tested);
  }
}

/** Claude Code's part, and the terminal part when the saved terminal choice is a custom one. */
async function claudeParts(
  ports: LaunchersProbePorts,
  signal: AbortSignal,
  saved: LauncherRow | undefined,
): Promise<{ claude: Part; terminal: Part | null }> {
  const config =
    saved === undefined ? null : parseStoredLauncherConfig("claude-code", saved.config);
  if (saved === undefined || config === null)
    return { claude: notSetUp("claude-code"), terminal: null };
  const choice: TerminalChoice = config.terminal;
  const terminalPath = choice.kind === "custom" ? choice.argv[0] : undefined;
  // The terminal rides on the Claude Code row, so it counts as tested when that row is.
  const [claude, terminal] = await Promise.all([
    executablePart(ports, signal, "claude-code", config.executablePath, saved.tested),
    terminalPath === undefined
      ? Promise.resolve(null)
      : executablePart(ports, signal, "terminal", terminalPath, saved.tested),
  ]);
  return { claude, terminal };
}

async function codexPart(
  ports: LaunchersProbePorts,
  signal: AbortSignal,
  saved: LauncherRow | undefined,
): Promise<Part> {
  const config = saved === undefined ? null : parseStoredLauncherConfig("codex", saved.config);
  if (saved === undefined || config === null) return notSetUp("codex");
  return executablePart(ports, signal, "codex", config.executablePath, saved.tested);
}

export async function probeLaunchers(
  ports: LaunchersProbePorts,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  if (signal.aborted) return noAnswer("launchers", "probe-timeout");

  const listed = await bounded(signal, () => ports.listConfigs());
  if (listed.kind === "timeout") return noAnswer("launchers", "probe-timeout");
  if (listed.kind === "error") return noAnswer("launchers", "probe-error");
  const byId = new Map(listed.value.map((saved) => [saved.launcherId, saved]));

  // The checks are independent and each is bounded by the same signal, so they run together: two
  // saved apps must fit in the one 2 s cap, not queue behind each other.
  const [antigravity, claude, desktop, codex] = await Promise.all([
    appPart(ports, signal, "antigravity", byId.get("antigravity")),
    claudeParts(ports, signal, byId.get("claude-code")),
    appPart(ports, signal, "claude-desktop", byId.get("claude-desktop")),
    codexPart(ports, signal, byId.get("codex")),
  ]);
  const parts = [
    antigravity,
    claude.claude,
    desktop,
    codex,
    ...(claude.terminal === null ? [] : [claude.terminal]),
  ];
  return rowOfParts("launchers", parts, []);
}
