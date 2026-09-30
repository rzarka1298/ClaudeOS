import { execFile as nodeExecFileCallback } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseClaudeVersionOutput, supportStatus } from "@ccc/collectors";
import type {
  ClaudeIntegrationStatus,
  IntegrationInstallState,
  TelemetryStatus,
} from "@ccc/domain";
import type { PipelineHealth } from "./pipeline.js";

/**
 * The Claude integration status (PR-24, D-12, D-15, SESS-18). Everything
 * here READS: Claude Code's `settings.json` through `readFileSync` and
 * `JSON.parse`, the installer's `<runtime>/hooks/install.json`, and the
 * installed binary's `--version`. No fs write API is imported (a source
 * scan in the test enforces it): the service never edits the owner's
 * Claude settings (D-13, T-05-51). Only booleans, integers, a timestamp and
 * a version leave this module on the wire; the settings path and the node
 * path stay private.
 *
 * Our entries are matched exactly as the installer matches them
 * (`scripts/claude-hooks/lib.mjs`, 05-09): a hook handler is ours when its
 * first argument lies under `<runtime>/hooks/`, and the status line is ours
 * when its command runs `<runtime>/hooks/statusline/wrapper.js` (quoted).
 */

/** Claude Code's transcript retention when its settings name none (D-44). */
const DEFAULT_CLEANUP_PERIOD_DAYS = 30;
/** Claude's settings are small; a larger file is not read (T-05-51). */
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_INSTALL_RECORD_BYTES = 64 * 1024;
/** The version probe's own deadline (PR-09, T-05-54). */
export const VERSION_PROBE_TIMEOUT_MS = 3000;

export interface ClaudeSettingsFacts {
  readonly hooks: IntegrationInstallState;
  readonly statusLine: IntegrationInstallState;
  /** Null when the settings could not be read. */
  readonly disableAllHooks: boolean | null;
  /** Default 30, minimum 1. */
  readonly cleanupPeriodDays: number;
  /** The node our hook handlers run (private; the runtime-missing check reads it). */
  readonly hookNodePath: string | null;
}

const UNKNOWN_SETTINGS: ClaudeSettingsFacts = Object.freeze({
  hooks: "unknown",
  statusLine: "unknown",
  disableAllHooks: null,
  cleanupPeriodDays: DEFAULT_CLEANUP_PERIOD_DAYS,
  hookNodePath: null,
});

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POSIX single-quoting, as the installer quotes the wrapper path (lib.mjs `shellQuote`). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Our handler: its first argument lies under `<runtime>/hooks/` (lib.mjs `isOurHandler`). */
function isOurHandler(handler: unknown, runtimeDir: string): handler is Json {
  if (!isObject(handler)) return false;
  const args = handler.args;
  return (
    Array.isArray(args) &&
    typeof args[0] === "string" &&
    args[0].startsWith(`${join(runtimeDir, "hooks")}/`)
  );
}

/** The first of our handlers across every event, or undefined (lib.mjs `findOurHandler`). */
function findOurHandler(hooks: unknown, runtimeDir: string): Json | undefined {
  if (!isObject(hooks)) return undefined;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      const ours = group.hooks.find((handler: unknown) => isOurHandler(handler, runtimeDir));
      if (ours !== undefined) return ours as Json;
    }
  }
  return undefined;
}

/** The status line runs this runtime's wrapper (lib.mjs `isOurWrapperCommand`). */
function runsOurWrapper(statusLine: unknown, runtimeDir: string): boolean {
  if (!isObject(statusLine) || typeof statusLine.command !== "string") return false;
  const wrapper = join(runtimeDir, "hooks", "statusline", "wrapper.js");
  return statusLine.command.includes(shellQuote(wrapper));
}

function cleanupDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CLEANUP_PERIOD_DAYS;
  return Math.max(1, Math.floor(value));
}

/**
 * Read-only facts from `<claude-config>/settings.json`. A missing,
 * oversized or invalid file reports `unknown` (never throws, never writes).
 */
export function readClaudeSettingsFacts(
  settingsPath: string,
  runtimeDir: string,
): ClaudeSettingsFacts {
  let settings: unknown;
  try {
    if (statSync(settingsPath).size > MAX_SETTINGS_BYTES) return UNKNOWN_SETTINGS;
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return UNKNOWN_SETTINGS;
  }
  if (!isObject(settings)) return UNKNOWN_SETTINGS;
  const handler = findOurHandler(settings.hooks, runtimeDir);
  const command = handler?.command;
  return {
    hooks: handler === undefined ? "not-installed" : "installed",
    statusLine: runsOurWrapper(settings.statusLine, runtimeDir) ? "installed" : "not-installed",
    disableAllHooks: settings.disableAllHooks === true,
    cleanupPeriodDays: cleanupDays(settings.cleanupPeriodDays),
    hookNodePath: typeof command === "string" && isAbsolute(command) ? command : null,
  };
}

/** What the installer recorded in `<runtime>/hooks/install.json` (05-09); absolute paths only. */
export interface InstallRecord {
  readonly nodePath: string | null;
  readonly claudeBin: string | null;
}

function absoluteOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length <= 4096 && isAbsolute(value) ? value : null;
}

/** The install record, or null when absent or unreadable. */
export function readInstallRecord(runtimeDir: string): InstallRecord | null {
  const path = join(runtimeDir, "hooks", "install.json");
  let parsed: unknown;
  try {
    if (statSync(path).size > MAX_INSTALL_RECORD_BYTES) return null;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  return { nodePath: absoluteOrNull(parsed.nodePath), claudeBin: absoluteOrNull(parsed.claudeBin) };
}

export interface VersionProbeDeps {
  execFile(
    file: string,
    args: readonly string[],
    options: { timeout: number },
  ): Promise<{ stdout: string }>;
  realpath(path: string): string;
  mtimeMs(path: string): number;
  /** Keyed by realpath and mtime, so an upgraded binary is probed again (PR-09). */
  readonly cache: Map<string, string | null>;
}

/** The real probe deps: `execFile` with fixed argv, a timeout and a small output cap. */
export function nodeVersionProbeDeps(): VersionProbeDeps {
  return {
    execFile: (file, args, options) =>
      new Promise((resolve, reject) => {
        nodeExecFileCallback(
          file,
          [...args],
          { timeout: options.timeout, maxBuffer: 64 * 1024, encoding: "utf8" },
          (err, stdout) => {
            if (err) reject(err);
            else resolve({ stdout });
          },
        );
      }),
    realpath: (path) => realpathSync(path),
    mtimeMs: (path) => statSync(path).mtimeMs,
    cache: new Map(),
  };
}

/**
 * The installed Claude Code version (PR-09): `<bin> --version` on the
 * installer-recorded absolute binary, cached per (realpath, mtime) once it
 * parses (a failed probe is retried on the next refresh). It
 * decides the install minimum and the health display only, never a live
 * session. Null when there is no absolute binary or the probe fails.
 */
export async function probeClaudeVersion(
  bin: string | null,
  deps: VersionProbeDeps,
): Promise<string | null> {
  if (bin === null || !isAbsolute(bin)) return null;
  let key: string;
  try {
    const real = deps.realpath(bin);
    key = `${real}\u0000${deps.mtimeMs(real)}`;
  } catch {
    return null;
  }
  const cached = deps.cache.get(key);
  if (cached !== undefined && cached !== null) return cached;
  let version: string | null = null;
  try {
    const { stdout } = await deps.execFile(bin, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    version = parseClaudeVersionOutput(stdout);
  } catch {
    version = null;
  }
  // Only a parsed version is cached (wave 4 review): a timeout or an
  // unparsable answer is retried on the next refresh instead of reading as
  // "unknown" (and telemetry "ok") until the binary changes.
  if (version !== null) deps.cache.set(key, version);
  return version;
}

export interface IntegrationInputs {
  readonly settings: ClaudeSettingsFacts;
  readonly install: InstallRecord | null;
  readonly pathExists: (path: string) => boolean;
  readonly health: PipelineHealth;
  readonly dropCount: number;
  readonly analysisEnabled: boolean;
  readonly statusLineReported: boolean;
  readonly detectedClaudeVersion: string | null;
}

export const nodePathExists = (path: string): boolean => existsSync(path);

/**
 * The status Settings shows. Telemetry reads `shape-changed` while a known
 * hook event's latest record failed its schema (D-12), else
 * `unsupported-version` when the installed Claude Code is below the
 * minimum, else `ok` (an unknown version is not a failure).
 */
export function buildIntegrationStatus(inputs: IntegrationInputs): ClaudeIntegrationStatus {
  const { settings, health, detectedClaudeVersion } = inputs;
  const nodePath = inputs.install?.nodePath ?? settings.hookNodePath;
  let telemetry: TelemetryStatus = { kind: "ok" };
  if (health.shapeChanged !== null) {
    telemetry = { kind: "shape-changed", version: detectedClaudeVersion };
  } else if (
    detectedClaudeVersion !== null &&
    supportStatus(detectedClaudeVersion) === "unsupported"
  ) {
    telemetry = { kind: "unsupported-version", version: detectedClaudeVersion };
  }
  return {
    hooks: settings.hooks,
    hookRuntimeMissing:
      settings.hooks === "installed" && nodePath !== null && !inputs.pathExists(nodePath),
    disableAllHooks: settings.disableAllHooks,
    lastEventAt: health.lastEventAt,
    telemetry,
    detectedClaudeVersion,
    statusLine: settings.statusLine,
    statusLineReported: inputs.statusLineReported,
    transcriptAnalysis: { enabled: inputs.analysisEnabled },
    spoolDropCount: Math.max(0, Math.floor(inputs.dropCount)),
    unknownEventCount: health.unknownEventCount,
    cleanupPeriodDays: settings.cleanupPeriodDays,
  };
}
