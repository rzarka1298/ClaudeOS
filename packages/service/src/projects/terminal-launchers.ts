import { constants, unlinkSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import type {
  LaunchResult,
  TerminalChoice,
  TerminalLauncher,
  TerminalLaunchInput,
} from "@ccc/domain";
import {
  mapLaunchFailure,
  openTerminalScript,
  renderCommandTemplate,
  renderLaunchScript,
  validateCommandTemplate,
} from "@ccc/launchers";
import { SCRIPT_MAX_AGE_MS, sweepStaleScripts, writeLaunchScript } from "./script-dir.js";
import type { Spawner, SpawnOutcome } from "./spawner.js";

/**
 * Terminal adapters behind the domain {@link TerminalLauncher} port (D-20,
 * D-23, D-28, D-49, PR-07). Phase 5's resume reuses the same port.
 *
 * Every adapter reaches a terminal the same way: render the launch script
 * (`renderLaunchScript` in `@ccc/launchers` — the only shell-parsed artifact
 * in the product, every value `shQuote`d), write it into the private 0700
 * script directory, and hand its PATH to the terminal. The argv and the env
 * never travel any other way:
 *
 * - The env (Phase 5's `CCC_RUN_ID`, `CCC_LAUNCH_SOURCE`) is exported INSIDE
 *   the script by the renderer and never passed to the `open` child, whose
 *   environment is the spawner's fixed allowlist (Pitfall 11, T-04-19).
 * - The Terminal.app hand-off is `open -b com.apple.Terminal <script>`:
 *   LaunchServices opens the `.command` file with Terminal by bundle ID.
 *   No Apple Event is sent, so no Automation prompt exists for it (D-28).
 *   `open` returns once LaunchServices has dispatched, so exit 0 means
 *   "handed off" (RESEARCH Pattern 1).
 *
 * The pipeline's abort signal (the 4 s cap) is honoured: an adapter checks
 * it before writing and before handing off, and passes it to the spawner,
 * which kills a still-running `open`. A hand-off that may have reached the
 * terminal (success, timeout, an unclassified failure) leaves its script for
 * the script itself or the sweeps to delete — never the service (Pitfall 5).
 * A script that provably never reached a terminal (nothing was spawned, the
 * spawn never started, the bundle was not found) is deleted at once.
 */

export interface TerminalAdapterDeps {
  readonly spawner: Spawner;
  /** The 0700 `<runtimeDir>/launch` directory from `ensureScriptDir`. */
  readonly scriptDir: string;
  /** The hand-off's own deadline; defaults to the launch pipeline's 4 s cap. */
  readonly capMs?: number;
  /** The custom template's `X_OK` check; defaults to an asynchronous `access(X_OK)`. */
  readonly isExecutable?: (path: string) => Promise<boolean>;
}

const DEFAULT_CAP_MS = 4000;

function removeUnsent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone: nothing to clean up.
  }
}

/**
 * The spawn provably never reached a terminal, so its script can go now: the
 * process never started, LaunchServices found no such bundle, or macOS
 * refused the Apple Event (-1743) before the terminal saw the script.
 */
function neverHandedOff(outcome: SpawnOutcome): boolean {
  return (
    outcome.errno !== null ||
    outcome.stderrClass === "bundle-not-found" ||
    outcome.stderrClass === "automation-denied"
  );
}

/**
 * A regular file (after following symlinks) that passes `access(X_OK)`, as a
 * boolean, asynchronously so a stalled volume never blocks the event loop.
 * `X_OK` alone is not enough: every searchable directory passes it, and an
 * `.app` bundle directory is not something `execve` can run.
 *
 * Check-then-spawn race (accepted, ADR-0024 Residual risks): the file can be
 * replaced or removed between this check and the spawn. A removal surfaces
 * as a spawn errno (`spawn-failed`, script removed); a same-user swap is the
 * same-user threat ADR-0001 accepts.
 */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawns the hand-off argv for a written script and maps the outcome. Shared
 * by every adapter so "exit 0 = handed off", the abort signal and the script
 * clean-up rules are one implementation.
 */
async function handOff(
  spawner: Spawner,
  argv: readonly string[],
  scriptPath: string,
  capMs: number,
  signal: AbortSignal,
): Promise<LaunchResult> {
  if (signal.aborted) {
    removeUnsent(scriptPath);
    return { ok: false, error: "timeout" };
  }
  const outcome = await spawner.run(argv, { timeoutMs: capMs, signal });
  if (signal.aborted) return { ok: false, error: "timeout" };
  if (outcome.exitCode === 0) return { ok: true };
  if (neverHandedOff(outcome)) removeUnsent(scriptPath);
  return { ok: false, error: mapLaunchFailure(outcome) };
}

/**
 * Renders and writes the script, or answers `spawn-failed` / `timeout`
 * without spawning anything. Rendering refuses NUL/CR/LF and non-`CCC_`
 * env keys before any file exists.
 */
function writeScript(
  scriptDir: string,
  input: TerminalLaunchInput,
): { readonly path: string } | { readonly result: LaunchResult } {
  if (input.signal.aborted) return { result: { ok: false, error: "timeout" } };
  // Leftovers from interrupted hand-offs; a fresh file is never touched.
  sweepStaleScripts(scriptDir, { olderThanMs: SCRIPT_MAX_AGE_MS });
  let body: string;
  try {
    body = renderLaunchScript(
      input.env === undefined
        ? { cwd: input.cwd, argv: input.argv }
        : { cwd: input.cwd, argv: input.argv, env: input.env },
    );
  } catch {
    return { result: { ok: false, error: "spawn-failed" } };
  }
  try {
    return { path: writeLaunchScript(scriptDir, body) };
  } catch {
    return { result: { ok: false, error: "spawn-failed" } };
  }
}

/** Terminal.app: `open -b com.apple.Terminal <script>` (D-20, D-28). */
export function createTerminalAppLauncher(deps: TerminalAdapterDeps): TerminalLauncher {
  const capMs = deps.capMs ?? DEFAULT_CAP_MS;
  return {
    async launch(input) {
      const written = writeScript(deps.scriptDir, input);
      if ("result" in written) return written.result;
      let argv: readonly string[];
      try {
        argv = openTerminalScript(written.path);
      } catch {
        removeUnsent(written.path);
        return { ok: false, error: "spawn-failed" };
      }
      return handOff(deps.spawner, argv, written.path, capMs, input.signal);
    },
  };
}

export interface CustomTemplateDeps extends TerminalAdapterDeps {
  /** The owner's stored terminal argv template (`TerminalChoice.argv`), with a `{script}` element. */
  readonly template: readonly string[];
  /** The `X_OK` check for `template[0]`; asynchronous so no launch blocks the event loop. */
  readonly isExecutable: (path: string) => Promise<boolean>;
}

/**
 * The generic "Custom terminal" adapter (D-22, D-23, PR-07): the owner's
 * argv template with `{script}` (and optionally `{projectPath}`) as whole
 * elements. iTerm2, Ghostty and WezTerm ship as presets of this template and
 * stay "Unverified" until the owner's Test step confirms one (D-23) — this
 * adapter claims only that it rendered and spawned the argv.
 *
 * Before EVERY spawn the stored template is validated again, whatever was
 * checked when it was saved: `argv[0]` absolute and passing `X_OK` right
 * now, placeholders whole elements only, and no Claude Code permission
 * bypass in any spelling (`--dangerously-skip-permissions`,
 * `bypassPermissions` as a mode, a flag value or inside `--settings` JSON).
 * A template that fails is a setup problem, answered
 * `launcher-not-configured` before any script exists, so nothing is left
 * behind and nothing is spawned (the same kind the launch service gives a
 * stored Claude Code template that no longer validates).
 *
 * Rendering replaces `{script}` with the written script's path and
 * `{projectPath}` with the launch's working directory, element for element;
 * nothing is split, joined or parsed. Only presets routed through
 * `/usr/bin/open` or `/usr/bin/osascript` keep "exit 0 = handed off" true:
 * both return once the terminal has the script. A template that runs a
 * terminal binary directly stays running and meets the cap even though its
 * window opened.
 *
 * `input.env` is how Phase 5 passes `CCC_RUN_ID` / `CCC_LAUNCH_SOURCE`
 * without amending the port (PR-07): it is exported inside the script by
 * the renderer, keys limited to `^CCC_[A-Z0-9_]+$`, and never reaches the
 * spawned child's environment (Pitfall 11). An osascript preset refused by
 * macOS (-1743) is `automation-denied` (D-28).
 */
export function createCustomTemplateLauncher(deps: CustomTemplateDeps): TerminalLauncher {
  const capMs = deps.capMs ?? DEFAULT_CAP_MS;
  return {
    async launch(input) {
      if (input.signal.aborted) return { ok: false, error: "timeout" };
      const executable = deps.template[0];
      const executableOk = executable === undefined ? false : await deps.isExecutable(executable);
      if (input.signal.aborted) return { ok: false, error: "timeout" };
      const validation = validateCommandTemplate(deps.template, {
        kind: "terminal",
        isExecutable: (path) => executableOk && path === executable,
      });
      if (!validation.ok) return { ok: false, error: "launcher-not-configured" };
      const written = writeScript(deps.scriptDir, input);
      if ("result" in written) return written.result;
      let argv: readonly string[];
      try {
        argv = renderCommandTemplate(validation.argv, {
          script: written.path,
          projectPath: input.cwd,
        });
      } catch {
        removeUnsent(written.path);
        return { ok: false, error: "spawn-failed" };
      }
      return handOff(deps.spawner, argv, written.path, capMs, input.signal);
    },
  };
}

/**
 * The terminal the stored Claude Code configuration chose (PROJ-10, D-21,
 * D-23): the first-class Terminal.app adapter, or the Custom terminal
 * adapter over the stored argv template. `null` is reserved for a choice no
 * adapter handles; the caller answers `launcher-not-configured`.
 */
export function selectTerminalLauncher(
  choice: TerminalChoice,
  deps: TerminalAdapterDeps,
): TerminalLauncher | null {
  switch (choice.kind) {
    case "terminal-app":
      return createTerminalAppLauncher(deps);
    case "custom":
      return createCustomTemplateLauncher({
        ...deps,
        template: choice.argv,
        isExecutable: deps.isExecutable ?? isExecutableFile,
      });
  }
}
