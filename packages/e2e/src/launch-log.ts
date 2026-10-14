import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The log in the kept wdio folder where launch trouble is recorded for the report. */
export const LAUNCH_EVENTS_LOG = "launch-retries.log";

/** A launch event that makes a run unratifiable: the window was swapped, or the app race was hit. */
export type LaunchEventKind = "launch-retry" | "app-exit-timeout";

const KINDS: readonly LaunchEventKind[] = ["launch-retry", "app-exit-timeout"];

/** Appends one event line; never throws (the console line beside the call is the fallback record). */
export function recordLaunchEvent(wdioDir: string, kind: LaunchEventKind, message: string): void {
  try {
    mkdirSync(wdioDir, { recursive: true });
    appendFileSync(
      join(wdioDir, LAUNCH_EVENTS_LOG),
      `${new Date().toISOString()} ${kind}: ${message}\n`,
      { mode: 0o600 },
    );
  } catch {
    // recording must never stop a run
  }
}

/** The distinct event kinds recorded so far, in first-seen order. */
export function readLaunchEvents(wdioDir: string): LaunchEventKind[] {
  let text: string;
  try {
    text = readFileSync(join(wdioDir, LAUNCH_EVENTS_LOG), "utf8");
  } catch {
    return [];
  }
  const found: LaunchEventKind[] = [];
  for (const line of text.split("\n")) {
    const kind = KINDS.find((candidate) => line.includes(` ${candidate}: `));
    if (kind !== undefined && !found.includes(kind)) found.push(kind);
  }
  return found;
}
