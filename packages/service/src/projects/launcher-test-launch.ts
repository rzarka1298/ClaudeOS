import { basename } from "node:path";
import {
  LAUNCHER_TEST_AUTOMATION_CAP_MS,
  type LaunchErrorKind,
  type LaunchResult,
  parseStoredLauncherConfig,
  type SystemSettingsPane,
  type TemplateRefusalReason,
  type TestLauncherId,
  terminalMayPromptForAutomation,
} from "@ccc/domain";
import {
  activateApp,
  mapLaunchFailure,
  OPEN,
  openUrl,
  revealInFinder,
  validateAgentLaunch,
  validateCommandTemplate,
} from "@ccc/launchers";
import { getLauncherConfig, type OperationalStore } from "@ccc/operational-store";
import { createAntigravityDeps } from "./antigravity-terminal.js";
import { VAULT_ROOT_META_KEY } from "./approved-roots.js";
import { LAUNCH_CAP_MS } from "./launch-service.js";
import type { Spawner } from "./spawner.js";
import { isExecutableFile, selectTerminalLauncher } from "./terminal-launchers.js";

/**
 * The Test step (D-28, RR-14, RR-15, PR-02): one REAL launch of the SAVED
 * configuration, through the same argv builders (`@ccc/launchers`) and the
 * same terminal adapters (`selectTerminalLauncher`) a project launch uses, so
 * a passing Test exercises the real path. What each Test opens (RR-15):
 *
 * - Antigravity: `open -b <saved bundle ID>` — the app, with no project;
 * - Claude Desktop: `open -b <saved bundle ID>` — brought to the front;
 * - Claude Code: the chosen terminal at the managed vault folder (the
 *   owner's home when no vault is set up) running `<saved claude> --version`,
 *   then the login shell. The stored arguments are a project launch's and are
 *   not used, but the stored template is re-validated first (D-22), exactly
 *   as before a launch;
 * - Codex (plan 05.1-21): the terminal chosen by the claude-code row, at the
 *   same folder, running `<saved codex> --version`, then the login shell. The
 *   saved row and the final argv are re-validated first (`codexRowRefusal`);
 * - Finder: `open -R <vault folder>`;
 * - GitHub: `open https://github.com`.
 *
 * "Tested" (RR-14) means the owner answered "It opened" after a Test whose
 * result was `{ ok: true }` — never an exit status alone; this module never
 * marks anything (the mark-tested route does, on the owner's word).
 *
 * Permissions (D-28, PR-02): the default mechanisms (`open -b`, `open -R`,
 * `open <url>`, Terminal's `.command` hand-off) send no Apple Event, so their
 * Test needs no permission. An osascript-driven custom terminal (the iTerm2
 * preset) does, and its Test is where macOS shows the first "wants to
 * control" prompt. osascript waits while that prompt is on screen, so its
 * Test runs under {@link LAUNCHER_TEST_AUTOMATION_CAP_MS} instead of the 4 s
 * launch cap (ADR-0024, wave-4b review). If even that passes, osascript is
 * killed and the Test answers `automation-denied` — whose copy names the
 * Automation pane and says to try again — rather than a bare `timeout` that
 * would blame the terminal for the owner reading a dialog. A -1743 refusal is
 * `automation-denied` at once, as for any launch.
 */

/** The two constant System Settings URLs (RR-16, T-04-22). The plugin sends only the enum. */
export const SYSTEM_SETTINGS_URLS: Readonly<Record<SystemSettingsPane, string>> = {
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  "privacy-security": "x-apple.systempreferences:com.apple.preference.security",
};

/** The `open` argv for a System Settings pane: a constant URL, never one from a request. */
export function openSystemSettingsArgv(pane: SystemSettingsPane): readonly string[] {
  return [OPEN, SYSTEM_SETTINGS_URLS[pane]];
}

const GITHUB_HOME = "https://github.com";
const TEST_VERSION_FLAG = "--version";

export interface TestLaunchDeps {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  /** The 0700 launch-script directory (`ensureScriptDir`). */
  readonly scriptDir: string;
  /** The resolved home directory: the Test folder when no vault is set up. */
  readonly homeDir: string;
  /** Regular file + `X_OK`; defaults to {@link isExecutableFile}. */
  readonly isExecutable?: (path: string) => Promise<boolean>;
  /** The normal cap; defaults to {@link LAUNCH_CAP_MS}. */
  readonly capMs?: number;
  /** The cap for a Test that may meet the Automation prompt; defaults to {@link LAUNCHER_TEST_AUTOMATION_CAP_MS}. */
  readonly automationCapMs?: number;
}

/** What one Test will do, decided before anything is spawned. */
type PreparedTest =
  | { readonly kind: "refuse"; readonly error: LaunchErrorKind }
  | { readonly kind: "spawn"; readonly argv: readonly string[] }
  | {
      readonly kind: "terminal";
      readonly run: (signal: AbortSignal, capMs: number) => Promise<LaunchResult>;
    };

function failure(error: LaunchErrorKind): LaunchResult {
  return { ok: false, error };
}

/** The managed vault folder, or the owner's home when none is set up (RR-15). */
function testFolder(deps: TestLaunchDeps): string {
  const vaultRoot = deps.store.readServiceMeta(VAULT_ROOT_META_KEY);
  return vaultRoot === null || vaultRoot.length === 0 ? deps.homeDir : vaultRoot;
}

function savedBundleId(
  store: OperationalStore,
  launcherId: "antigravity" | "claude-desktop",
): string | null {
  const record = getLauncherConfig(store.db, launcherId);
  if (record === null) return null;
  return parseStoredLauncherConfig(launcherId, record.config)?.bundleId ?? null;
}

async function prepareClaudeCode(deps: TestLaunchDeps): Promise<PreparedTest> {
  const record = getLauncherConfig(deps.store.db, "claude-code");
  const config = record === null ? null : parseStoredLauncherConfig("claude-code", record.config);
  if (config === null) return { kind: "refuse", error: "launcher-not-configured" };
  const isExecutable = deps.isExecutable ?? isExecutableFile;
  const executableOk = await isExecutable(config.executablePath);
  // The saved template is re-validated exactly as before a launch (D-22): a
  // row that no longer passes is a setup problem, never a Test.
  const validation = validateCommandTemplate([config.executablePath, ...config.args], {
    kind: "claude-code",
    isExecutable: (path) => executableOk && path === config.executablePath,
  });
  if (!validation.ok) return { kind: "refuse", error: "launcher-not-configured" };
  const cwd = testFolder(deps);
  return {
    kind: "terminal",
    run: async (signal, capMs) => {
      const terminal = selectTerminalLauncher(config.terminal, {
        spawner: deps.spawner,
        scriptDir: deps.scriptDir,
        capMs,
        isExecutable,
        antigravity: createAntigravityDeps({ store: deps.store, spawner: deps.spawner }),
      });
      if (terminal === null) return failure("launcher-not-configured");
      return terminal.launch({ cwd, argv: [config.executablePath, TEST_VERSION_FLAG], signal });
    },
  };
}

/**
 * Why a Codex row (plan 05.1-21, D-11) does not pass: a reason and the index
 * into `[executable, ...args]`; `null` means the row passes.
 */
export interface CodexRowRefusal {
  readonly reason: TemplateRefusalReason;
  readonly index: number | null;
}

/**
 * The one Codex row check, shared by the save route and the Test step so a
 * saved row is held to exactly what was checked at save (T-05.1-15):
 *
 * 1. `argv[0]` is an absolute path whose basename is exactly `codex` (this
 *    also refuses every interpreter or launcher shim);
 * 2. `validateCommandTemplate` with the `codex` kind: the ban set in every
 *    spelling, the config-carrying flags, only the project-path placeholder,
 *    no line break, at most 32 elements;
 * 3. `validateAgentLaunch` on the same argv, so the per-agent flag allowlist
 *    the bridge helper applies to the final argv is applied here too.
 *
 * `executableOk` is the answer to "is `argv[0]` an executable file now",
 * obtained by the caller (the check is asynchronous). The agent validator
 * reports no index, so one is derived: the first element whose prefix is
 * refused and stays refused after the next element (a value flag is refused
 * until its value arrives).
 */
export function codexRowRefusal(
  argv: readonly string[],
  executableOk: boolean,
): CodexRowRefusal | null {
  const executable = argv[0];
  if (executable === undefined || !executable.startsWith("/")) {
    return { reason: "executable-not-absolute", index: 0 };
  }
  if (basename(executable) !== "codex") return { reason: "executable-not-found", index: 0 };
  const template = validateCommandTemplate(argv, {
    kind: "codex",
    isExecutable: (path) => executableOk && path === executable,
  });
  if (!template.ok) return { reason: template.reason, index: template.index };
  const passes = (length: number): boolean =>
    validateAgentLaunch({ agent: "codex", argv: argv.slice(0, length), env: {} }).ok;
  if (passes(argv.length)) return null;
  for (let length = 1; length <= argv.length; length++) {
    if (passes(length)) continue;
    if (length < argv.length && passes(length + 1)) continue;
    const index = length - 1;
    return index === 0
      ? { reason: "executable-not-found", index: 0 }
      : { reason: "forbidden-flag", index };
  }
  return { reason: "forbidden-flag", index: argv.length - 1 };
}

/** The saved Codex launcher run with `--version` in the claude-code row's terminal. */
async function prepareCodex(deps: TestLaunchDeps): Promise<PreparedTest> {
  const codexRecord = getLauncherConfig(deps.store.db, "codex");
  const config =
    codexRecord === null ? null : parseStoredLauncherConfig("codex", codexRecord.config);
  if (config === null) return { kind: "refuse", error: "launcher-not-configured" };
  // Codex has no terminal of its own (D-11): the claude-code row decides.
  const claudeRecord = getLauncherConfig(deps.store.db, "claude-code");
  const claude =
    claudeRecord === null ? null : parseStoredLauncherConfig("claude-code", claudeRecord.config);
  if (claude === null) return { kind: "refuse", error: "launcher-not-configured" };
  const isExecutable = deps.isExecutable ?? isExecutableFile;
  const executableOk = await isExecutable(config.executablePath);
  // The saved row is re-validated exactly as before a launch (D-22) ...
  if (codexRowRefusal([config.executablePath, ...config.args], executableOk) !== null) {
    return { kind: "refuse", error: "launcher-not-configured" };
  }
  // ... and so is the final argv this Test will actually run.
  const argv = [config.executablePath, TEST_VERSION_FLAG];
  if (codexRowRefusal(argv, executableOk) !== null) {
    return { kind: "refuse", error: "launcher-not-configured" };
  }
  const cwd = testFolder(deps);
  return {
    kind: "terminal",
    run: async (signal, capMs) => {
      const terminal = selectTerminalLauncher(claude.terminal, {
        spawner: deps.spawner,
        scriptDir: deps.scriptDir,
        capMs,
        isExecutable,
        antigravity: createAntigravityDeps({ store: deps.store, spawner: deps.spawner }),
      });
      if (terminal === null) return failure("launcher-not-configured");
      return terminal.launch({ cwd, argv, signal });
    },
  };
}

async function prepare(launcherId: TestLauncherId, deps: TestLaunchDeps): Promise<PreparedTest> {
  switch (launcherId) {
    case "antigravity":
    case "claude-desktop": {
      const bundleId = savedBundleId(deps.store, launcherId);
      if (bundleId === null) return { kind: "refuse", error: "launcher-not-configured" };
      return { kind: "spawn", argv: activateApp(bundleId) };
    }
    case "finder":
      return { kind: "spawn", argv: revealInFinder(testFolder(deps)) };
    case "github":
      return { kind: "spawn", argv: openUrl(GITHUB_HOME) };
    case "claude-code":
      return prepareClaudeCode(deps);
    case "codex":
      return prepareCodex(deps);
  }
}

/**
 * Whether this Test may meet the Automation prompt, decided from the saved
 * row alone — synchronously, before any check runs — so the cap that covers
 * the whole Test is known when it starts.
 */
function mayPromptForAutomation(launcherId: TestLauncherId, store: OperationalStore): boolean {
  // Codex opens in the claude-code row's terminal, so it shares that row's answer.
  if (launcherId !== "claude-code" && launcherId !== "codex") return false;
  const record = getLauncherConfig(store.db, "claude-code");
  const config = record === null ? null : parseStoredLauncherConfig("claude-code", record.config);
  return config !== null && terminalMayPromptForAutomation(config.terminal);
}

/** What the race between the preparation and the deadline produced. */
const DEADLINE: unique symbol = Symbol("test deadline");

/**
 * Runs one Test under ONE cap that starts before anything else (codex
 * review 3, finding 5): preparing — reading the saved row and checking the
 * executable on disk, which can stall on an unmounted volume or a privacy
 * prompt — and launching share the same deadline. A preparation that
 * finishes after the deadline never spawns anything. Never rejects.
 */
export async function testLaunch(
  launcherId: TestLauncherId,
  deps: TestLaunchDeps,
): Promise<LaunchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await runTest(launcherId, deps, (ms, onDeadline) => {
      timer = setTimeout(onDeadline, ms);
    });
  } catch {
    // A store that throws reading the saved row (a locked or corrupt
    // database), or a builder refusal (LaunchArgumentError) — either message
    // could name a value. Nothing past the throw ran (codex review 3b,
    // finding 4: a Test never rejects).
    return failure("spawn-failed");
  } finally {
    clearTimeout(timer);
  }
}

/** {@link testLaunch}'s body; any throw is the caller's to turn into a failure. */
async function runTest(
  launcherId: TestLauncherId,
  deps: TestLaunchDeps,
  startDeadline: (ms: number, onDeadline: () => void) => void,
): Promise<LaunchResult> {
  const automation = mayPromptForAutomation(launcherId, deps.store);
  const capMs = automation
    ? (deps.automationCapMs ?? LAUNCHER_TEST_AUTOMATION_CAP_MS)
    : (deps.capMs ?? LAUNCH_CAP_MS);
  const controller = new AbortController();
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    startDeadline(capMs, () => {
      controller.abort();
      resolve(DEADLINE);
    });
  });

  const preparing = prepare(launcherId, deps);
  // A late rejection of an abandoned preparation is absorbed.
  preparing.catch(() => undefined);
  const prepared = await Promise.race([preparing, deadline]);
  // Nothing ran yet, so this is a stall, never an unanswered prompt.
  if (prepared === DEADLINE || controller.signal.aborted) return failure("timeout");
  if (prepared.kind === "refuse") return failure(prepared.error);

  const ready = prepared;
  const attempt = async (): Promise<LaunchResult> => {
    if (ready.kind === "terminal") return ready.run(controller.signal, capMs);
    const outcome = await deps.spawner.run(ready.argv, {
      timeoutMs: capMs,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return failure("timeout");
    return outcome.exitCode === 0 ? { ok: true } : failure(mapLaunchFailure(outcome));
  };

  let result: LaunchResult;
  try {
    const launched = await Promise.race([attempt(), deadline]);
    result = launched === DEADLINE ? failure("timeout") : launched;
  } catch {
    result = failure("spawn-failed");
  }
  // osascript killed while macOS may still be asking the owner: explain the
  // prompt (Automation pane, try again), not a bare timeout (ADR-0024).
  if (automation && !result.ok && result.error === "timeout") {
    return failure("automation-denied");
  }
  return result;
}
