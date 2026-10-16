import {
  CONTENT_HASH_PATTERN,
  NOTE_ID_PATTERN,
  RESEARCH_JOB_ID,
  RUN_ID_PATTERN,
} from "@ccc/domain";
import type Database from "better-sqlite3";
import { assertJobRunInFlight } from "./job-run-store.js";

/**
 * The research report record (07-FIX6b, ADR-0030): which report a research run published and a
 * digest of what that report said when the run finalised it.
 *
 * 0011 binds each SOURCE to a run in the operational store. That is not enough on its own: a
 * report keeps its id and its run id when it is edited in place, so its claims, kinds, quotes and
 * flags could be rewritten while every source still verified. This record binds the REPORT. The
 * pipeline writes one row when it has finalised the report and read it back; the reader recomputes
 * the digest from the report it parses from the vault and counts a quote as evidence only when the
 * two are equal.
 *
 * **Content-free.** A run id, a note id, a SHA-256 and an ISO instant. The digest is computed by
 * the service (it needs the report's shape); this module only checks the shapes it is handed.
 *
 * **Write once, for a run that is still working.** A run that does not exist or has ended cannot
 * take a record (a record nobody produced), recording identical values again is a no-op, and a
 * different report or digest for the same run throws. The one deletion is {@link
 * removeResearchReportRecord}, for a publication the pipeline took back: a missing record only
 * ever means "unverified", so deleting is the safe direction.
 */

export interface ResearchReportRecord {
  readonly jobRunId: string;
  readonly reportNoteId: string;
  /** SHA-256 (lowercase hex) of the canonical serialisation of the report's served content. */
  readonly contentDigest: string;
  readonly recordedAt: string;
}

/** Thrown before any write when an input is outside the content-free shapes this module accepts. */
export class ResearchReportRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchReportRecordError";
  }
}

/** Thrown when a run already has a different record. */
export class ResearchReportRecordConflictError extends Error {
  constructor() {
    super("a different report record already exists for this run");
    this.name = "ResearchReportRecordConflictError";
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function fail(message: string): never {
  throw new ResearchReportRecordError(message);
}

function checkRecord(input: ResearchReportRecord): ResearchReportRecord {
  if (typeof input.jobRunId !== "string" || !RUN_ID_PATTERN.test(input.jobRunId)) {
    fail("jobRunId is not a run id");
  }
  if (typeof input.reportNoteId !== "string" || !NOTE_ID_PATTERN.test(input.reportNoteId)) {
    fail("reportNoteId is not a note id");
  }
  if (typeof input.contentDigest !== "string" || !CONTENT_HASH_PATTERN.test(input.contentDigest)) {
    fail("contentDigest is not a SHA-256");
  }
  if (
    typeof input.recordedAt !== "string" ||
    !ISO_INSTANT.test(input.recordedAt) ||
    Number.isNaN(Date.parse(input.recordedAt))
  ) {
    fail("recordedAt is not an ISO instant");
  }
  return {
    jobRunId: input.jobRunId,
    reportNoteId: input.reportNoteId,
    contentDigest: input.contentDigest,
    recordedAt: input.recordedAt,
  };
}

interface Row {
  job_run_id: string;
  report_note_id: string;
  content_digest: string;
  recorded_at: string;
}

/**
 * Records the report a run finalised. The run must exist and still be in flight
 * ({@link JobRunNotFoundError} or {@link JobRunNotInFlightError} otherwise, nothing written).
 * Idempotent for the same report and digest (the first instant is kept); a different report or
 * digest for the same run throws {@link ResearchReportRecordConflictError}.
 */
export function recordResearchReport(db: Database.Database, input: ResearchReportRecord): void {
  const record = checkRecord(input);
  db.transaction(() => {
    assertJobRunInFlight(db, record.jobRunId, RESEARCH_JOB_ID);
    const existing = getResearchReportRecord(db, record.jobRunId);
    if (existing !== null) {
      if (
        existing.reportNoteId !== record.reportNoteId ||
        existing.contentDigest !== record.contentDigest
      ) {
        throw new ResearchReportRecordConflictError();
      }
      return;
    }
    db.prepare(
      `INSERT INTO research_report_records (job_run_id, report_note_id, content_digest, recorded_at)
       VALUES (?, ?, ?, ?)`,
    ).run(record.jobRunId, record.reportNoteId, record.contentDigest, record.recordedAt);
  }).immediate();
}

/**
 * The record for one run, or null. A row that fails the shape checks the writer applies (a
 * hand-edited store) reads as absent: an unverifiable record is no record.
 */
export function getResearchReportRecord(
  db: Database.Database,
  jobRunId: string,
): ResearchReportRecord | null {
  const row = db
    .prepare("SELECT * FROM research_report_records WHERE job_run_id = ?")
    .get(jobRunId) as Row | undefined;
  if (row === undefined) return null;
  try {
    return checkRecord({
      jobRunId: row.job_run_id,
      reportNoteId: row.report_note_id,
      contentDigest: row.content_digest,
      recordedAt: row.recorded_at,
    });
  } catch {
    return null;
  }
}

/** Removes a run's report record (a publication that was taken back). Absent is fine. */
export function removeResearchReportRecord(db: Database.Database, jobRunId: string): void {
  db.prepare("DELETE FROM research_report_records WHERE job_run_id = ?").run(jobRunId);
}
