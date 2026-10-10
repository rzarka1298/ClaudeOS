import type { ProcessStatus, RunFacts, RunId, RunInspector } from "@ccc/domain";
import { getSessionRun } from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { type ProcessFacts, sameProcessStart } from "../claude/process-facts.js";

/**
 * The run inspector (plan 06-21, D-17, D-42): what the force-terminate
 * operation may know about a Run and a process. It is read-only. It answers
 * from the operational store and from the two read-only process facts (`isAlive`
 * is an existence probe and `readStartTimes` is a `ps` read), and it holds no
 * signal function of any kind, so it cannot affect a process. Identity uses
 * Phase 5's own comparison (`sameProcessStart`), so a pid reused by another
 * process reads as `different`, never as the approved process.
 */

/** The longest display name the operation's payload accepts. */
const DISPLAY_NAME_MAX = 120;

export interface RunInspectorDeps {
  readonly db: Database.Database;
  readonly processFacts: Pick<ProcessFacts, "isAlive" | "readStartTimes">;
}

/** A Run's display name: its own name, or the start of its session id, capped for the payload. */
function displayNameOf(name: string | null, claudeSessionId: string | null, runId: string): string {
  const own = name?.trim() ?? "";
  if (own.length > 0) return own.slice(0, DISPLAY_NAME_MAX);
  return `Session ${(claudeSessionId ?? runId).slice(0, 8)}`;
}

export function createRunInspector(deps: RunInspectorDeps): RunInspector {
  const { db, processFacts } = deps;
  return {
    readRun(runId: string): RunFacts | null {
      const run = getSessionRun(db, runId as RunId);
      if (run === null) return null;
      return {
        runId: run.runId,
        state: run.state,
        displayName: displayNameOf(run.name, run.claudeSessionId, run.runId),
        pid: run.pid,
        processStartedAt: run.pidStartedAt,
      };
    },

    async processStatus(pid: number, expectedStartedAt: string): Promise<ProcessStatus> {
      if (!processFacts.isAlive(pid)) return "gone";
      const read = (await processFacts.readStartTimes([pid])).get(pid);
      // Alive, but its start cannot be read: the identity is not established
      // either way. Refusing to answer lets reconcile record `unknown` rather
      // than invent a proof.
      if (read === undefined) throw new Error("process-start-unreadable");
      return sameProcessStart(read, expectedStartedAt) ? "same" : "different";
    },
  };
}

/**
 * The short name of a process (the last path segment of its command), or null
 * when it cannot be read. Used for the display line of a force-terminate
 * request; never a path.
 */
export function createProcessNamer(deps: {
  readonly readAncestry: ProcessFacts["readAncestry"];
}): (pid: number) => Promise<string | null> {
  return async (pid) => {
    try {
      const chain = await deps.readAncestry(pid);
      const self = chain.find((entry) => entry.pid === pid);
      if (self === undefined) return null;
      const last =
        self.comm
          .split("/")
          .filter((part) => part.length > 0)
          .pop() ?? "";
      const cleaned = [...last]
        .filter((ch) => ch >= " " && ch !== "\u007f")
        .join("")
        .slice(0, 64);
      return cleaned.length > 0 ? cleaned : null;
    } catch {
      return null;
    }
  };
}
