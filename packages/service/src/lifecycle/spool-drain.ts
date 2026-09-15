import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Logger } from "pino";

/** One parsed line of the hook spool's newline-delimited JSON. */
export type SpoolRecord = Record<string, unknown>;

/**
 * Reads `spoolPath` whole, splits it on newline, parses every *complete*
 * line (one that was followed by a newline) as JSON, and truncates the
 * file to whatever trailing fragment has no terminating newline yet —
 * never to empty when a write was interleaved mid-drain, so a record the
 * hook writer is still in the middle of appending is neither lost nor
 * half-parsed. ADR-0007 and ADR-0010 together make this truncation
 * mandatory: the spool is a transient queue the service drains on every
 * startup, never a retained record of the user's session activity, which
 * the in-memory-replay decision (ADR-0007) and the spool-fallback contract
 * (ADR-0010) both require.
 *
 * A missing spool file is not an error — nothing has been written yet. A
 * line that fails `JSON.parse` is logged (with its 1-based line number)
 * and skipped rather than aborting the whole drain: the spool is written
 * by a process this service does not control (the hook writer, T-01-21/
 * T-01-22 in this plan's threat model), so its content is untrusted input
 * that must be handled defensively line-by-line.
 */
export function drainSpool(spoolPath: string, logger: Logger): SpoolRecord[] {
  if (!existsSync(spoolPath)) {
    return [];
  }

  const raw = readFileSync(spoolPath, "utf8");
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  // A file ending in a newline has no trailing partial record -- the empty
  // string `split` leaves after the final "\n" is not a fragment to keep.
  // A file NOT ending in a newline has its last element as an in-progress
  // write; pop it off and write it back untouched rather than parsing it.
  const trailing = endsWithNewline ? "" : (lines.pop() ?? "");

  const records: SpoolRecord[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      records.push(JSON.parse(trimmed) as SpoolRecord);
    } catch {
      logger.warn({ line: index + 1 }, "spool record failed to parse; skipped");
    }
  });

  writeFileSync(spoolPath, trailing);
  return records;
}
