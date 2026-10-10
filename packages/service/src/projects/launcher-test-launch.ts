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
 * Why a saved Codex row (plan 05.1-21) does not pass: a reason and the index into
 * `[executable, ...args]`. Signature stub; the checks land with the implementation.
 */
export interface CodexRowRefusal {
  readonly reason: TemplateRefusalReason;
  readonly index: number | null;
}

export function codexRowRefusal(
  _argv: readonly string[],
  _executableOk: boolean,
): CodexRowRefusal | null {
  return null;
}

async function prepareCodex(_deps: TestLaunchDeps): Promise<PreparedTest> {
  return { kind: "refuse", error: "launcher-not-configured" };
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
  if (launcherId !== "claude-code") return false;
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
