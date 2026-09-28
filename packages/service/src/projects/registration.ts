import { realpathSync, statSync } from "node:fs";

/** Why a candidate folder was refused — logged locally, never returned. */
export type ProjectRefusalReason =
  | "missing"
  | "not-a-directory"
  | "forbidden-location"
  | "inside-vault"
  | "above-vault"
  | "runtime-dir"
  | "access-denied"
  | "control-characters";

/**
 * Thrown when a candidate folder cannot be registered as a project. The
 * message is a constant that names nothing on disk; `candidate` is kept for
 * the local redacting log only (Shared Pattern 1, D-46).
 */
export class ProjectRefusedError extends Error {
  readonly candidate: string;
  readonly reason: ProjectRefusalReason;

  constructor(candidate: string, reason: ProjectRefusalReason) {
    super("project refused");
    this.name = "ProjectRefusedError";
    this.candidate = candidate;
    this.reason = reason;
  }
}

/**
 * Registration policy (D-04): resolves `candidate` with
 * `realpathSync.native` — which canonicalises letter case on APFS, so a
 * case alias or a symlink resolves to the same stored path — and requires a
 * directory. Returns the resolved path, which is what the store keeps.
 */
export function validateProjectCandidate(candidate: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(candidate);
  } catch {
    throw new ProjectRefusedError(candidate, "missing");
  }
  if (!statSync(resolved).isDirectory()) {
    throw new ProjectRefusedError(candidate, "not-a-directory");
  }
  return resolved;
}

// RED skeleton (plan 04-04 Task 2): lexical protected-location detection.
export function detectProtectedLocation(
  _candidate: string,
  _homeDir: string,
): "documents" | "desktop" | "downloads" | "icloud-drive" | null {
  return null;
}
