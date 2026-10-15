// Job run idempotency keys (plan 07-05, D-19, PRD 9.7, ADR-09).
//
// Two key forms, kept apart by grammar so one can never be mistaken for or
// consume the other:
//
//   manual     <jobId>:manual:<runId>
//   scheduled  <jobId>:<cadence>:<YYYY-MM-DD>@<IANA zone>
//
// A job id holds neither a colon nor an at sign. A run id is the domain run id
// shape (25 lower-case base-36 characters), so it holds neither either. The
// middle segment of a manual key is the literal `manual` and of a scheduled key
// a cadence (only `daily` in milestone 1), and the scheduled key ends in
// `@<zone>` while a manual key never contains an at sign. A manual key can
// therefore never equal a scheduled key, and parsing a manual key never yields
// a window (PRD 9.7: a manual run never consumes or alters a scheduled window).
//
// The zone sits inside the scheduled key on purpose: changing the machine zone
// opens a new window deliberately, and one local date can therefore produce a
// second run if the zone changes between two runs (the ADR records this; a
// same-date guard is milestone-2 work).
//
// This file is pure and Node-free.

import { RUN_ID_PATTERN } from "@ccc/domain";
import { isValidTimeZone } from "./window.js";

/** Cadences a scheduled key may carry. Only `daily` exists in milestone 1. */
export const JOB_CADENCES = ["daily"] as const;
export type JobCadence = (typeof JOB_CADENCES)[number];

/** A job id: lower-case words joined by single dots or hyphens, at most 64 characters. */
export const JOB_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const JOB_ID_MAX = 64;

/** The shape of a window date. Calendar validity is checked separately. */
const WINDOW_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** The characters an IANA zone name uses. */
const ZONE_SHAPE_PATTERN = /^[A-Za-z0-9_+/-]{1,64}$/;

/** True for a real calendar date written `YYYY-MM-DD` (2026-02-30 is not one). */
function isCalendarDate(value: string): boolean {
  if (!WINDOW_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1000) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isZone(value: string): boolean {
  return ZONE_SHAPE_PATTERN.test(value) && isValidTimeZone(value);
}

export type ParsedJobRunKey =
  | { readonly kind: "manual"; readonly jobId: string; readonly runId: string }
  | {
      readonly kind: "scheduled";
      readonly jobId: string;
      readonly cadence: JobCadence;
      readonly window: string;
      readonly zone: string;
    };

/** Thrown when a key part is invalid. The message names the part, never its value. */
export class JobRunKeyError extends Error {
  readonly part: "jobId" | "runId" | "cadence" | "window" | "zone";
  constructor(part: JobRunKeyError["part"]) {
    super(`invalid ${part} for a job run key`);
    this.name = "JobRunKeyError";
    this.part = part;
  }
}

export function isValidJobId(value: string): boolean {
  return value.length <= JOB_ID_MAX && JOB_ID_PATTERN.test(value);
}

function isCadence(value: string): value is JobCadence {
  return (JOB_CADENCES as readonly string[]).includes(value);
}

/** `<jobId>:manual:<runId>`. Throws {@link JobRunKeyError} for an invalid part. */
export function manualJobRunKey(jobId: string, runId: string): string {
  if (!isValidJobId(jobId)) throw new JobRunKeyError("jobId");
  if (!RUN_ID_PATTERN.test(runId)) throw new JobRunKeyError("runId");
  return `${jobId}:manual:${runId}`;
}

/**
 * `<jobId>:<cadence>:<YYYY-MM-DD>@<zone>`, where the date is the local date the
 * occurrence belongs to. Throws {@link JobRunKeyError} for an invalid part.
 */
export function scheduledJobRunKey(
  jobId: string,
  cadence: string,
  window: string,
  zone: string,
): string {
  if (!isValidJobId(jobId)) throw new JobRunKeyError("jobId");
  if (!isCadence(cadence)) throw new JobRunKeyError("cadence");
  if (!isCalendarDate(window)) throw new JobRunKeyError("window");
  if (!isZone(zone)) throw new JobRunKeyError("zone");
  return `${jobId}:${cadence}:${window}@${zone}`;
}

/** The parts of a key, or null when the string is not exactly one of the two forms. Never throws. */
export function parseJobRunKey(key: string): ParsedJobRunKey | null {
  const parts = key.split(":");
  if (parts.length === 3 && parts[1] === "manual") {
    const [jobId, , runId] = parts as [string, string, string];
    if (!isValidJobId(jobId) || !RUN_ID_PATTERN.test(runId)) return null;
    return { kind: "manual", jobId, runId };
  }
  if (parts.length === 3) {
    const [jobId, cadence, rest] = parts as [string, string, string];
    const at = rest.indexOf("@");
    if (at < 0) return null;
    const window = rest.slice(0, at);
    const zone = rest.slice(at + 1);
    if (!isValidJobId(jobId) || !isCadence(cadence)) return null;
    if (!isCalendarDate(window) || !isZone(zone)) return null;
    return { kind: "scheduled", jobId, cadence, window, zone };
  }
  return null;
}
