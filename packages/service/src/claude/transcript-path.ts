import { isAbsolute } from "node:path";
import { checkPathContainment, type PathContainmentResult } from "@ccc/domain";

type RefusalReason =
  | Extract<PathContainmentResult, { contained: false }>["reason"]
  | "not-absolute"
  | "dot-dot-segment";

/**
 * Why a hook-reported transcript path was refused. Like
 * `PathNotAllowedError`, the message names neither the candidate nor the
 * root; only the reason is kept, for the local log.
 */
export class TranscriptPathRefusedError extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason) {
    super("transcript path refused");
    this.name = "TranscriptPathRefusedError";
    this.reason = reason;
  }
}

/**
 * The read-only containment check for a hook-reported `transcript_path`
 * (PR-28, Pitfall 9): the candidate must resolve, symlinks included,
 * strictly under `claudeProjectsRoot` (`<claude-config>/projects`). Returns
 * the resolved path.
 *
 * This is deliberately NOT the write allowlist. It checks against one fixed
 * root and never calls `registerApprovedRoot`, so a transcript path that
 * passes here still fails `assertPathAllowed` (PR-07, SESS-15): the service
 * may read a transcript and can never write one.
 */
export function assertTranscriptPath(candidate: string, claudeProjectsRoot: string): string {
  if (!isAbsolute(candidate)) throw new TranscriptPathRefusedError("not-absolute");
  // A `..` segment is refused outright, even one that would resolve back
  // inside: no real transcript path Claude Code reports carries one.
  if (candidate.split("/").includes("..")) throw new TranscriptPathRefusedError("dot-dot-segment");
  const result = checkPathContainment(candidate, claudeProjectsRoot);
  if (!result.contained) throw new TranscriptPathRefusedError(result.reason);
  return result.resolved;
}
