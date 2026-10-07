import type { RunInspector } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { ProcessFacts } from "../claude/process-facts.js";

/** Skeleton (RED): the real adapter follows in the GREEN commit. */
export interface RunInspectorDeps {
  readonly db: Database.Database;
  readonly processFacts: Pick<ProcessFacts, "isAlive" | "readStartTimes">;
}

export function createRunInspector(_deps: RunInspectorDeps): RunInspector {
  return {
    readRun: () => null,
    processStatus: async () => "gone",
  };
}
