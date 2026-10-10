import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type LaunchResult,
  parseStoredLauncherConfig,
  type ResolvedProject,
  type TerminalLauncher,
} from "@ccc/domain";
import {
  renderCommandTemplate,
  validateAgentLaunchChecked,
  validateCommandTemplate,
} from "@ccc/launchers";
import { getLauncherConfig, type OperationalStore } from "@ccc/operational-store";
import { isExecutableFile } from "./terminal-launchers.js";

/**
 * The Codex half of the pair launch (plan 05.1-20, D-10, D-11, D-15, OQ-6).
 *
 * What it builds: `[saved codex executable, ...saved args]` with `{projectPath}` rendered, read
 * from the saved `codex` launcher row only. The pair request can name no executable, argument or
 * path; the product adds no Codex flag of its own (A14: default args are empty, the owner's own
 * Codex configuration governs sandbox and approvals).
 *
 * What it refuses, as the calm `setup` state and never as a failure of the other half: no saved
 * row, a row that no longer parses, a template the codex validator refuses (a bypass flag, a
 * config-carrying flag, an unknown placeholder), a final argv the agent-launch validator refuses
 * (a flag or operand outside the per-agent allowlist, a directory argument outside the project)
 * and an executable that is missing or not executable. The same two validators run again here at
 * every launch, so a row written before a validator change can never run.
 *
 * What it never does: ask the concurrent-write guard (the guard stays Claude-only, OQ-6), create a
 * Run (Codex sessions are a read-only mirror, D-15), pass an environment, or log anything.
 */

export interface CodexHalfDeps {
  readonly store: OperationalStore;
  /** Defaults to the asynchronous executable check the Claude half uses. */
  readonly isExecutable?: (path: string) => Promise<boolean>;
}

/** What preparing the Codex half decided. */
export type CodexHalf =
  | { readonly kind: "setup" }
  | {
      readonly kind: "launch";
      /** Hands the already validated argv to the terminal the claude-code row chose. */
      readonly run: (terminal: TerminalLauncher, signal: AbortSignal) => Promise<LaunchResult>;
    };

const SETUP: CodexHalf = { kind: "setup" };

/** `realpath(resolve(base, path))` when that is an existing directory, else `null`. */
async function realDirectory(path: string, base: string): Promise<string | null> {
  try {
    const real = await realpath(resolve(base, path));
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export async function prepareCodexHalf(
  deps: CodexHalfDeps,
  project: ResolvedProject,
): Promise<CodexHalf> {
  try {
    const record = getLauncherConfig(deps.store.db, "codex");
    const config = record === null ? null : parseStoredLauncherConfig("codex", record.config);
    if (config === null) return SETUP;
    const isExecutable = deps.isExecutable ?? isExecutableFile;
    const executable = await isExecutable(config.executablePath);
    const template = [config.executablePath, ...config.args];
    const templateVerdict = validateCommandTemplate(template, {
      kind: "codex",
      isExecutable: (path) => executable && path === config.executablePath,
    });
    if (!templateVerdict.ok) return SETUP;
    const argv = renderCommandTemplate(template, { projectPath: project.path });
    const launchVerdict = await validateAgentLaunchChecked(
      { agent: "codex", argv, env: {}, projectRoot: project.path, cwd: project.path },
      { isExecutable, realDir: realDirectory },
    );
    if (!launchVerdict.ok) return SETUP;
    return {
      kind: "launch",
      run: (terminal, signal) => terminal.launch({ cwd: project.path, argv, signal }),
    };
  } catch {
    // A store or filesystem fault: the half is not runnable, which is a setup state, not a launch.
    return SETUP;
  }
}
