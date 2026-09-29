import { basename } from "node:path";
import type { LaunchSource } from "@ccc/domain";
import type { AncestorEntry, ProcessFacts } from "./process-facts.js";

/**
 * Service-side launch-source classification (PR-03, RESEARCH C-1 and A9),
 * run once per SessionStart from OS process metadata:
 *
 * 1. `dashboard` when the hook forwarded `CCC_LAUNCH_SOURCE=dashboard`
 *    (the dashboard's own launcher sets it), whatever the tty;
 * 2. else `external` when a process ABOVE the Claude pid is itself a Claude
 *    Code process (a nested session, or the desktop app's supervisor —
 *    Pitfall 15), or the Claude process has no controlling tty;
 * 3. else `terminal`.
 *
 * `CLAUDE_CODE_CHILD_SESSION` is ignored: Claude Code sets it for every
 * hook command, so it cannot tell a terminal session from a nested one
 * (C-1). When the process facts cannot be read, the answer is null — Not
 * reported — never a guess.
 */

export interface LaunchSourceInput {
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
  readonly pid: number | null;
}

/** RESEARCH A9: a Claude Code executable is a `…/claude/versions/<v>` path or named `claude`. */
function isClaudeCode(entry: AncestorEntry): boolean {
  return entry.comm.includes("/claude/versions/") || basename(entry.comm) === "claude";
}

export async function classifyLaunchSource(
  input: LaunchSourceInput,
  processFacts: Pick<ProcessFacts, "readTty" | "readAncestry">,
): Promise<LaunchSource | null> {
  if (input.env?.CCC_LAUNCH_SOURCE === "dashboard") return "dashboard";
  if (input.pid === null) return null;
  let ancestry: AncestorEntry[];
  let tty: string | null;
  try {
    [ancestry, tty] = await Promise.all([
      processFacts.readAncestry(input.pid),
      processFacts.readTty(input.pid),
    ]);
  } catch {
    return null;
  }
  // The chain always starts with the pid itself when ps could read it; an
  // empty chain is a failed read (or a vanished process): unknown.
  if (ancestry.length === 0) return null;
  const above = ancestry.filter((entry) => entry.pid !== input.pid);
  if (above.some(isClaudeCode)) return "external";
  return tty === null ? "external" : "terminal";
}
