import { unlinkSync } from "node:fs";
import type {
  LaunchResult,
  TerminalChoice,
  TerminalLauncher,
  TerminalLaunchInput,
} from "@ccc/domain";
import { mapLaunchFailure, openTerminalScript, renderLaunchScript } from "@ccc/launchers";
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

/** The spawn provably never reached a terminal, so its script can go now. */
function neverHandedOff(outcome: SpawnOutcome): boolean {
  return outcome.errno !== null || outcome.stderrClass === "bundle-not-found";
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
      if (input.signal.aborted) {
        removeUnsent(written.path);
        return { ok: false, error: "timeout" };
      }
      let argv: readonly string[];
      try {
        argv = openTerminalScript(written.path);
      } catch {
        removeUnsent(written.path);
        return { ok: false, error: "spawn-failed" };
      }
      const outcome = await deps.spawner.run(argv, { timeoutMs: capMs, signal: input.signal });
      if (input.signal.aborted) return { ok: false, error: "timeout" };
      if (outcome.exitCode === 0) return { ok: true };
      if (neverHandedOff(outcome)) removeUnsent(written.path);
      return { ok: false, error: mapLaunchFailure(outcome) };
    },
  };
}

export interface CustomTemplateDeps extends TerminalAdapterDeps {
  readonly template: readonly string[];
  readonly isExecutable: (path: string) => Promise<boolean>;
}

/** RED stub (04-09 Task 3): not implemented yet. */
export function createCustomTemplateLauncher(_deps: CustomTemplateDeps): TerminalLauncher {
  return {
    launch() {
      return Promise.reject(new Error("createCustomTemplateLauncher is not implemented"));
    },
  };
}

/**
 * The terminal the stored Claude Code configuration chose (PROJ-10, D-21).
 * `null` means no adapter exists for it yet — the caller answers
 * `launcher-not-configured`. The custom-template adapter lands with plan
 * 04-09 Task 3.
 */
export function selectTerminalLauncher(
  choice: TerminalChoice,
  deps: TerminalAdapterDeps,
): TerminalLauncher | null {
  switch (choice.kind) {
    case "terminal-app":
      return createTerminalAppLauncher(deps);
    case "custom":
      return null;
  }
}
