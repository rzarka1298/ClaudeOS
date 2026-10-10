import type { CodexSessionsSnapshot, ProjectRef } from "@ccc/domain";

/**
 * The wrapper's own run records, read as hostile input (plan 05.1-26, D-20, CODEX-06,
 * T-05.1-07, T-05.1-36). SIGNATURE STUBS for the red commit: the implementation follows.
 */

export const RUN_RECORD_SCHEMA_VERSION = 1;
export const MAX_RECORD_BYTES = 16 * 1024;
export const MAX_RECORDS_PER_DIR = 100;

export const RUN_KINDS = ["review", "task", "resume"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_STATUSES = ["running", "ok", "limit", "timeout", "failed", "refused"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunMode = "tui" | "headless";

export const SKIP_REASONS = [
  "symlink",
  "not-regular",
  "oversize",
  "bad-name",
  "bad-json",
  "bad-shape",
  "id-mismatch",
  "unsupported-version",
  "outside-root",
  "read-failed",
  "capped",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What the allowlisted parse keeps of a session record. */
export interface RunFact {
  readonly runId: string;
  readonly kind: RunKind;
  readonly role: string | null;
  readonly mode: RunMode | null;
  readonly sessionId: string | null;
  readonly status: RunStatus;
  readonly resetsAt: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** What the allowlisted parse keeps of `pending-resume.json`. */
export interface PendingFact {
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: RunKind;
  readonly role: string | null;
  readonly resetsAt: string | null;
  readonly recordedAt: string;
}

export interface LiveLogInfo {
  readonly kind: "live";
  /** Service-private: built from the state directory, kind and run id. */
  readonly path: string;
  readonly mtimeMs: number;
}

/** `missing`: no such file. `unsafe`: a symlink, not a regular file, or outside the state directory. */
export type LiveLogInspection =
  | LiveLogInfo
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe" };

/** A run fact plus the service-private context the overlay and the follow route need. */
export interface PrivateRun extends RunFact {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  /** The real path of the directory the record was read from. Never leaves the service. */
  readonly stateDir: string;
  /** A repository-relative worktree name, or null. Never leaves the service. */
  readonly worktree: string | null;
  /** Only inspected for a running record whose mode is not the interactive terminal mode. */
  readonly liveLog: LiveLogInspection | null;
}

export interface PrivatePending extends PendingFact {
  readonly projectId: string;
}

export interface RunRecordScan {
  /** Merged by run id (the newer start time wins), newest first. */
  readonly runs: readonly PrivateRun[];
  readonly pending: readonly PrivatePending[];
  readonly skipped: Readonly<Record<SkipReason, number>>;
  /** Changes when a record is added, removed or rewritten (name, size, modification time). */
  readonly signature: string;
}

export interface RunFileInfo {
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** The filesystem operations the reader may use; every read is bounded. */
export interface RunRecordFs {
  lstat(path: string): Promise<RunFileInfo | null>;
  realpath(path: string): Promise<string | null>;
  readdir(path: string): Promise<string[] | null>;
  readFile(
    path: string,
    maxBytes: number,
  ): Promise<
    | { readonly kind: "ok"; readonly text: string }
    | { readonly kind: "too-large" }
    | { readonly kind: "failed" }
  >;
}

export interface RunRecordReaderDeps {
  readonly listProjects: () => readonly ProjectRef[];
  /** The bridge state directory (or directories) the wrapper may have used. */
  readonly bridgeStateDir: string | readonly string[];
  readonly home: string;
  readonly fs?: RunRecordFs;
  readonly maxRecordsPerDir?: number;
  readonly maxRecordBytes?: number;
}

export interface RunRecordReader {
  scan(): Promise<RunRecordScan>;
  /** The most recent scan (empty before the first). */
  last(): RunRecordScan;
  inspectLiveLog(run: Pick<PrivateRun, "stateDir" | "kind" | "runId">): Promise<LiveLogInspection>;
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SkipReason };

const NOT_IMPLEMENTED = "run-records: not implemented";

export const nodeRunRecordFs: RunRecordFs = {
  lstat: () => Promise.reject(new Error(NOT_IMPLEMENTED)),
  realpath: () => Promise.reject(new Error(NOT_IMPLEMENTED)),
  readdir: () => Promise.reject(new Error(NOT_IMPLEMENTED)),
  readFile: () => Promise.reject(new Error(NOT_IMPLEMENTED)),
};

export function parseRunRecord(_raw: unknown, _fileRunId: string): Parsed<RunFact> {
  throw new Error(NOT_IMPLEMENTED);
}

export function parsePendingResume(_raw: unknown): Parsed<PendingFact> {
  throw new Error(NOT_IMPLEMENTED);
}

export function createRunRecordReader(_deps: RunRecordReaderDeps): RunRecordReader {
  throw new Error(NOT_IMPLEMENTED);
}

export interface PausedRunSummary {
  readonly count: number;
  readonly earliestResetAt: string | null;
  readonly withoutResetAt: number;
}

export function summarizePausedRuns(_snapshot: CodexSessionsSnapshot | null): PausedRunSummary {
  throw new Error(NOT_IMPLEMENTED);
}
