import type { LaunchErrorKind } from "@ccc/domain";

/**
 * The launch error taxonomy's pure half (D-26, PROJ-12, Pitfall 7).
 *
 * `open(1)` and `osascript` report failures as English stderr text, and
 * that text carries values from the owner's machine: "The file <path> does
 * not exist.", the bundle identifier it could not find. So the text is
 * reduced to a {@link StderrClass} the moment it is read (inside the
 * service's spawner) and dropped; only the class travels, and
 * {@link mapLaunchFailure} turns it — with the exit status, spawn errno and
 * timeout flag — into exactly one {@link LaunchErrorKind}.
 *
 * Signals (RESEARCH ADR-0024 checklist item 6, verified by local probe):
 *
 * | stderr contains                              | class               | kind                   |
 * |----------------------------------------------|---------------------|------------------------|
 * | `LSCopyApplicationURLsForBundleIdentifier`   | `bundle-not-found`  | `app-not-found`        |
 * | `does not exist`                             | `path-missing`      | `project-missing`      |
 * | `-1743` (Apple Events refused)               | `automation-denied` | `automation-denied`    |
 * | `Operation not permitted`                    | `permission-denied` | `folder-access-denied` |
 * | nothing                                      | `none`              | `spawn-failed`         |
 * | anything else                                | `other`             | `spawn-failed`         |
 *
 * The run's deadline passing is `timeout` whatever stderr says, and a
 * process that never started (`ENOENT`, `EACCES`) is `spawn-failed`.
 */

export const STDERR_CLASSES = [
  "none",
  "bundle-not-found",
  "path-missing",
  "automation-denied",
  "permission-denied",
  "other",
] as const;
export type StderrClass = (typeof STDERR_CLASSES)[number];

/** Everything a failed spawn is judged on. No text: stderr is already a class. */
export interface LaunchFailureSignals {
  readonly exitCode: number | null;
  readonly errno: string | null;
  readonly stderrClass: StderrClass;
  readonly timedOut: boolean;
}

const BUNDLE_NOT_FOUND = "LSCopyApplicationURLsForBundleIdentifier";
/** The Apple Events error number, as a whole token (`(-1743)`, `-1743.`). */
const AUTOMATION_DENIED = /(^|[^0-9])-1743(?![0-9])/;
const PERMISSION_DENIED = "Operation not permitted";
const PATH_MISSING = "does not exist";

/** Reduces stderr to its class. Total; the checks run most specific first. */
export function classifyStderr(text: string): StderrClass {
  if (text.trim() === "") return "none";
  if (text.includes(BUNDLE_NOT_FOUND)) return "bundle-not-found";
  if (AUTOMATION_DENIED.test(text)) return "automation-denied";
  if (text.includes(PERMISSION_DENIED)) return "permission-denied";
  if (text.includes(PATH_MISSING)) return "path-missing";
  return "other";
}

/**
 * Maps a failed spawn to its kind. Call it only for a failure (exit status
 * not 0). The switch is exhaustive with no default, so adding a stderr class
 * without deciding its kind fails compilation.
 */
export function mapLaunchFailure(signals: LaunchFailureSignals): LaunchErrorKind {
  if (signals.timedOut) return "timeout";
  if (signals.errno !== null) return "spawn-failed";
  switch (signals.stderrClass) {
    case "bundle-not-found":
      return "app-not-found";
    case "path-missing":
      return "project-missing";
    case "automation-denied":
      return "automation-denied";
    case "permission-denied":
      return "folder-access-denied";
    case "none":
    case "other":
      return "spawn-failed";
  }
}
