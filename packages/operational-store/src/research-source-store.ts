import {
  CONTENT_HASH_PATTERN,
  HttpsUrlSchema,
  plainLineText,
  RUN_ID_PATTERN,
  rawSnapshotPathFor,
  SOURCE_ID_PATTERN,
} from "@ccc/domain";
import type Database from "better-sqlite3";

/**
 * The research provenance record (07-FIX6, decision D-A, ADR-0030): what a research run wrote to
 * the vault for each source, kept where the vault's writers cannot reach it.
 *
 * A report and the raw source notes it cites are Markdown files, so anyone who can write the vault
 * can make a matching pair (an invented body, its real hash, a frontmatter that agrees). Only a
 * record the vault does not hold can tell the pair from the run's own work. The pipeline writes
 * one row here when a source's raw note has been written and read back; the view model counts a
 * quote as evidence only when the raw note it reads hashes to the row recorded for the report's
 * own run and that source.
 *
 * **The record is content-free.** A run id, a source id, an https address the owner's allowlist
 * already named, a SHA-256, the vault-relative snapshot path derived from the two, the owner's own
 * short label and an ISO instant. Each input is checked before any statement runs, so fetched
 * text, a remote title or model output cannot reach the table through this module.
 *
 * **Write once.** A row is never updated. Recording the same values again is a no-op; recording a
 * different set of values for the same run and source throws, because a record that could be
 * rewritten would not be a root of trust.
 */

export interface ResearchSourceRecord {
  readonly jobRunId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly contentHash: string;
  readonly snapshotPath: string;
  /** The owner's own label for the source (never a remote title). */
  readonly label: string;
  readonly recordedAt: string;
}

/** Thrown before any write when an input is outside the content-free shapes this module accepts. */
export class ResearchSourceRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchSourceRecordError";
  }
}

/** Thrown when a run already has a different record for the same source. */
export class ResearchSourceRecordConflictError extends Error {
  constructor() {
    super("a different record already exists for this run and source");
    this.name = "ResearchSourceRecordConflictError";
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const LABEL = plainLineText(200);

function fail(message: string): never {
  throw new ResearchSourceRecordError(message);
}

/** Validates a record and returns the plain object that is stored. */
function checkRecord(input: ResearchSourceRecord): ResearchSourceRecord {
  if (typeof input.jobRunId !== "string" || !RUN_ID_PATTERN.test(input.jobRunId)) {
    fail("jobRunId is not a run id");
  }
  if (typeof input.sourceId !== "string" || !SOURCE_ID_PATTERN.test(input.sourceId)) {
    fail("sourceId is not a source id");
  }
  if (!HttpsUrlSchema.safeParse(input.canonicalUrl).success) {
    fail("canonicalUrl is not an https address");
  }
  if (typeof input.contentHash !== "string" || !CONTENT_HASH_PATTERN.test(input.contentHash)) {
    fail("contentHash is not a SHA-256");
  }
  if (input.snapshotPath !== rawSnapshotPathFor(input.sourceId, input.contentHash)) {
    fail("snapshotPath is not the path derived from the source id and the hash");
  }
  if (!LABEL.safeParse(input.label).success) fail("label is not a short plain line");
  if (
    typeof input.recordedAt !== "string" ||
    !ISO_INSTANT.test(input.recordedAt) ||
    Number.isNaN(Date.parse(input.recordedAt))
  ) {
    fail("recordedAt is not an ISO instant");
  }
  return {
    jobRunId: input.jobRunId,
    sourceId: input.sourceId,
    canonicalUrl: input.canonicalUrl,
    contentHash: input.contentHash,
    snapshotPath: input.snapshotPath,
    label: input.label,
    recordedAt: input.recordedAt,
  };
}

interface Row {
  job_run_id: string;
  source_id: string;
  canonical_url: string;
  content_hash: string;
  snapshot_path: string;
  label: string;
  recorded_at: string;
}

function toRecord(row: Row): ResearchSourceRecord {
  return {
    jobRunId: row.job_run_id,
    sourceId: row.source_id,
    canonicalUrl: row.canonical_url,
    contentHash: row.content_hash,
    snapshotPath: row.snapshot_path,
    label: row.label,
    recordedAt: row.recorded_at,
  };
}

function sameBinding(a: ResearchSourceRecord, b: ResearchSourceRecord): boolean {
  return (
    a.canonicalUrl === b.canonicalUrl &&
    a.contentHash === b.contentHash &&
    a.snapshotPath === b.snapshotPath &&
    a.label === b.label
  );
}

/**
 * Records that a run wrote and read back the raw note of one source. Idempotent for the same
 * values (the original `recordedAt` is kept); a different record for the same run and source
 * throws {@link ResearchSourceRecordConflictError} and changes nothing.
 */
export function recordResearchSource(db: Database.Database, input: ResearchSourceRecord): void {
  const record = checkRecord(input);
  db.transaction(() => {
    const existing = getResearchSourceRecord(db, record.jobRunId, record.sourceId);
    if (existing !== null) {
      if (!sameBinding(existing, record)) throw new ResearchSourceRecordConflictError();
      return;
    }
    db.prepare(
      `INSERT INTO research_source_records
         (job_run_id, source_id, canonical_url, content_hash, snapshot_path, label, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.jobRunId,
      record.sourceId,
      record.canonicalUrl,
      record.contentHash,
      record.snapshotPath,
      record.label,
      record.recordedAt,
    );
  }).immediate();
}

/**
 * The record for one run and one source, or null. A row that fails the shape checks the writer
 * applies (a hand-edited store) reads as absent: an unverifiable record is no record.
 */
export function getResearchSourceRecord(
  db: Database.Database,
  jobRunId: string,
  sourceId: string,
): ResearchSourceRecord | null {
  const row = db
    .prepare("SELECT * FROM research_source_records WHERE job_run_id = ? AND source_id = ?")
    .get(jobRunId, sourceId) as Row | undefined;
  if (row === undefined) return null;
  const record = toRecord(row);
  try {
    return checkRecord(record);
  } catch {
    return null;
  }
}
