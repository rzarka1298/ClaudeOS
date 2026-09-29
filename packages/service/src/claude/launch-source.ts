import type { LaunchSource } from "@ccc/domain";
import type { ProcessFacts } from "./process-facts.js";

// RED scaffold (05-11 Task 3): the real classifier replaces this body.
export async function classifyLaunchSource(
  _input: {
    readonly env: Readonly<Record<string, string | undefined>> | undefined;
    readonly pid: number | null;
  },
  _processFacts: Pick<ProcessFacts, "readTty" | "readAncestry">,
): Promise<LaunchSource | null> {
  return null;
}
