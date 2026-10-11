import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  CODEX_WRAPPER_RUN_ID_PATTERN,
  type CodexSessionsSnapshot,
  type ProjectRef,
} from "@ccc/domain";
import { projectStateCandidates } from "@ccc/launchers";
import { z } from "zod";

/**
 * The wrapper's own run records, read as hostile input (plan 05.1-26, D-20, CODEX-06,
 * T-05.1-07, T-05.1-36).
 *
 * Headless `codex exec` runs and bridge runs fire no hooks, so their truth lives in two small files
 * the wrapper writes under a project's state directory: `sessions/<run id>.json` (the tracking
 * record plan 05.1-10 versions) and `pending-resume.json`. Any same-user process can write those
 * files, so each one is parsed as hostile input:
 *
 * - the directory is a candidate of a REGISTERED project (the same pure function the wrapper uses)
 *   and its real path must stay inside that project's root or the bridge state directory;
 * - a record is a regular file (never a symlink, opened without following one), at most 16 KiB,
 *   named `<run id>.json`, valid JSON, and its run id agrees with its name;
 * - the parse keeps a NAMED allowlist of fields and drops every other key (worktree, fallback
 *   reasons, any report text), so nothing else can reach a view, an event or a log line;
 * - at most 100 records per directory are read, newest names first;
 * - a skipped file is only counted, by a fixed reason code. Nothing here throws on bad input and
 *   nothing here ever names a path, a run id or a value in an error.
 *
 * The reader never opens `reports/` (the verdict and report text live there) and never reads a
 * live log's content: a log is only `lstat`ed and `realpath`ed.
 */

export const RUN_RECORD_SCHEMA_VERSION = 1;
export const MAX_RECORD_BYTES = 16 * 1024;
export const MAX_RECORDS_PER_DIR = 100;
/** More registered projects than this are not scanned (a bound, not an expected count). */
const MAX_PROJECTS = 200;

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
  /** The registered projects; the reader scans no directory that is not one's candidate. */
  readonly listProjects: () => readonly ProjectRef[];
  /** The bridge state directory (or directories) the wrapper may have used. */
  readonly bridgeStateDir: string | readonly string[];
  /** The owner's home; a bridge state directory outside it is never scanned. */
  readonly home: string;
  readonly fs?: RunRecordFs;
  readonly maxRecordsPerDir?: number;
  readonly maxRecordBytes?: number;
}

export interface RunRecordReader {
  /** Reads every candidate directory once; concurrent calls share one scan. Never rejects. */
  scan(): Promise<RunRecordScan>;
  /** The most recent scan (empty before the first). */
  last(): RunRecordScan;
  /** Builds the live log path from the run's own state directory, kind and run id. */
  inspectLiveLog(run: Pick<PrivateRun, "stateDir" | "kind" | "runId">): Promise<LiveLogInspection>;
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SkipReason };

// ---------------------------------------------------------------------------
// The real filesystem

export const nodeRunRecordFs: RunRecordFs = {
  async lstat(path) {
    try {
      const info = await lstat(path);
      return {
        isFile: info.isFile(),
        isSymlink: info.isSymbolicLink(),
        isDirectory: info.isDirectory(),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    } catch {
      return null;
    }
  },
  async realpath(path) {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  },
  async readdir(path) {
    try {
      return await readdir(path);
    } catch {
      return null;
    }
  },
  async readFile(path, maxBytes) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // A final symlink is refused by the open itself, so a swap after the lstat is not followed.
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const buffer = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total <= maxBytes) {
        const { bytesRead } = await handle.read(buffer, total, maxBytes + 1 - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > maxBytes) return { kind: "too-large" };
      return { kind: "ok", text: buffer.toString("utf8", 0, total) };
    } catch {
      return { kind: "failed" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};

// ---------------------------------------------------------------------------
// The allowlisted schemas. z.object drops every key it does not name, so the parsed value is an
// allowlist by construction.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IsoSchema = z.iso.datetime({ offset: true });
const NullableIso = IsoSchema.nullish().transform((value) => value ?? null);
const RoleSchema = z
  .string()
  .regex(/^[a-z][a-z-]{0,15}$/)
  .nullish()
  .transform((value) => value ?? null);
const RunIdSchema = z.string().regex(CODEX_WRAPPER_RUN_ID_PATTERN);

/** A session id that is not a UUID is kept as null, never a reason to skip the record. */
const LenientSessionId = z
  .unknown()
  .optional()
  .transform((value) =>
    typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null,
  );

const RunRecordSchema = z.object({
  runId: RunIdSchema,
  kind: z.enum(RUN_KINDS),
  role: RoleSchema,
  mode: z
    .enum(["tui", "headless"])
    .nullish()
    .transform((value) => value ?? null),
  sessionId: LenientSessionId,
  status: z.enum(RUN_STATUSES),
  resetsAt: NullableIso,
  startedAt: IsoSchema,
  finishedAt: NullableIso,
});

const PendingResumeSchema = z.object({
  sessionId: z.string().regex(UUID_PATTERN),
  runId: RunIdSchema,
  kind: z.enum(RUN_KINDS),
  role: RoleSchema,
  resetsAt: NullableIso,
  recordedAt: IsoSchema,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent is version 0; 0 and 1 parse; a higher version is unsupported; anything else is malformed. */
function versionGate(raw: Record<string, unknown>): "ok" | "unsupported" | "malformed" {
  const version = raw.schemaVersion;
  if (version === undefined) return "ok";
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return "malformed";
  return version > RUN_RECORD_SCHEMA_VERSION ? "unsupported" : "ok";
}

/** Parses a session record; `fileRunId` is the run id its file name claims. */
export function parseRunRecord(raw: unknown, fileRunId: string): Parsed<RunFact> {
  if (!isPlainObject(raw)) return { ok: false, reason: "bad-shape" };
  const gate = versionGate(raw);
  if (gate === "unsupported") return { ok: false, reason: "unsupported-version" };
  if (gate === "malformed") return { ok: false, reason: "bad-shape" };
  const parsed = RunRecordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "bad-shape" };
  if (parsed.data.runId !== fileRunId) return { ok: false, reason: "id-mismatch" };
  return { ok: true, value: parsed.data };
}

/** Parses `pending-resume.json`. */
export function parsePendingResume(raw: unknown): Parsed<PendingFact> {
  if (!isPlainObject(raw)) return { ok: false, reason: "bad-shape" };
  const gate = versionGate(raw);
  if (gate === "unsupported") return { ok: false, reason: "unsupported-version" };
  if (gate === "malformed") return { ok: false, reason: "bad-shape" };
  const parsed = PendingResumeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "bad-shape" };
  return {
    ok: true,
    value: { ...parsed.data, sessionId: parsed.data.sessionId.toLowerCase() },
  };
}

/**
 * The repository-relative worktree name of a record, or null. It is service-private (the follow
 * route resolves a working directory from it only when it is a contained existing directory) and is
 * deliberately NOT part of {@link RunFact}.
 */
function worktreeNameOf(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null;
  const value = raw.worktree;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  if (value.startsWith("/") || value.includes("\0")) return null;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  if (value.split("/").some((segment) => segment === "..")) return null;
  return value;
}

// ---------------------------------------------------------------------------
// The reader

const RECORD_FILE_PATTERN = /^(\d{8}T\d{9}Z)\.json$/;

function zeroCounters(): Record<SkipReason, number> {
  return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<
    SkipReason,
    number
  >;
}

const EMPTY_SCAN: RunRecordScan = {
  runs: [],
  pending: [],
  skipped: zeroCounters(),
  signature: "",
};

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function createRunRecordReader(deps: RunRecordReaderDeps): RunRecordReader {
  const fs = deps.fs ?? nodeRunRecordFs;
  const maxPerDir = clampInt(deps.maxRecordsPerDir, MAX_RECORDS_PER_DIR, 1, MAX_RECORDS_PER_DIR);
  const maxBytes = clampInt(deps.maxRecordBytes, MAX_RECORD_BYTES, 1, MAX_RECORD_BYTES);
  const bridgeDirs =
    typeof deps.bridgeStateDir === "string" ? [deps.bridgeStateDir] : [...deps.bridgeStateDir];
  let lastScan: RunRecordScan = EMPTY_SCAN;
  let inFlight: Promise<RunRecordScan> | null = null;

  async function inspectLiveLog(
    run: Pick<PrivateRun, "stateDir" | "kind" | "runId">,
  ): Promise<LiveLogInspection> {
    try {
      const path = join(run.stateDir, "live", `${run.runId}-${run.kind}.log`);
      const info = await fs.lstat(path);
      if (info === null) return { kind: "missing" };
      if (info.isSymlink || !info.isFile) return { kind: "unsafe" };
      const [stateReal, fileReal] = await Promise.all([
        fs.realpath(run.stateDir),
        fs.realpath(path),
      ]);
      if (stateReal === null || fileReal === null) return { kind: "missing" };
      if (!isInside(fileReal, stateReal)) return { kind: "unsafe" };
      return { kind: "live", path: fileReal, mtimeMs: info.mtimeMs };
    } catch {
      return { kind: "missing" };
    }
  }

  async function scanOnce(): Promise<RunRecordScan> {
    const skipped = zeroCounters();
    const signatureParts: string[] = [];
    const runsById = new Map<string, Omit<PrivateRun, "liveLog">>();
    const pending: PrivatePending[] = [];

    let projects: readonly ProjectRef[] = [];
    try {
      projects = deps.listProjects().slice(0, MAX_PROJECTS);
    } catch {
      projects = [];
    }

    const homeReal = (await fs.realpath(deps.home)) ?? deps.home;
    // A bridge state directory must sit under the owner's home, lexically and after symlinks.
    const bridgeRoots: Array<{ readonly dir: string; readonly real: string }> = [];
    for (const dir of bridgeDirs) {
      const lexicalOk = isInside(dir, deps.home) || isInside(dir, homeReal);
      const real = lexicalOk ? ((await fs.realpath(dir)) ?? dir) : null;
      if (real === null || !isInside(real, homeReal)) {
        skipped["outside-root"] += 1;
        continue;
      }
      bridgeRoots.push({ dir, real });
    }

    async function readRecordFile(
      path: string,
      read: (text: string) => void,
      sign: (info: RunFileInfo) => void,
    ): Promise<void> {
      const info = await fs.lstat(path);
      if (info === null) return;
      if (info.isSymlink) {
        skipped.symlink += 1;
        return;
      }
      if (!info.isFile) {
        skipped["not-regular"] += 1;
        return;
      }
      if (info.size > maxBytes) {
        skipped.oversize += 1;
        return;
      }
      const body = await fs.readFile(path, maxBytes);
      if (body.kind === "too-large") {
        skipped.oversize += 1;
        return;
      }
      if (body.kind === "failed") {
        skipped["read-failed"] += 1;
        return;
      }
      sign(info);
      read(body.text);
    }

    async function readSessions(
      stateReal: string,
      project: ProjectRef,
      projectRoot: string,
    ): Promise<void> {
      const dirReal = await fs.realpath(join(stateReal, "sessions"));
      if (dirReal === null) return;
      if (!isInside(dirReal, stateReal)) {
        skipped["outside-root"] += 1;
        return;
      }
      const names = await fs.readdir(dirReal);
      if (names === null) return;
      const valid: string[] = [];
      for (const name of names) {
        // The wrapper's atomic writer leaves dot-named temp files; they are not records.
        if (name.startsWith(".")) continue;
        if (RECORD_FILE_PATTERN.test(name)) valid.push(name);
        else skipped["bad-name"] += 1;
      }
      // Run ids are timestamps, so a descending name sort is newest first.
      valid.sort().reverse();
      skipped.capped += Math.max(0, valid.length - maxPerDir);
      for (const name of valid.slice(0, maxPerDir)) {
        const fileRunId = name.slice(0, -".json".length);
        const path = join(dirReal, name);
        let signed = "";
        await readRecordFile(
          path,
          (text) => {
            let raw: unknown;
            try {
              raw = JSON.parse(text);
            } catch {
              skipped["bad-json"] += 1;
              return;
            }
            const parsed = parseRunRecord(raw, fileRunId);
            if (!parsed.ok) {
              skipped[parsed.reason] += 1;
              return;
            }
            signatureParts.push(signed);
            const fact = parsed.value;
            const existing = runsById.get(fact.runId);
            if (existing !== undefined && timeOf(existing.startedAt) >= timeOf(fact.startedAt)) {
              return;
            }
            runsById.set(fact.runId, {
              ...fact,
              projectId: project.projectId,
              projectName: project.name,
              projectRoot,
              stateDir: stateReal,
              worktree: worktreeNameOf(raw),
            });
          },
          (info) => {
            signed = `${project.projectId}|${path}|${info.size}|${info.mtimeMs}`;
          },
        );
      }
    }

    async function readPending(stateReal: string, project: ProjectRef): Promise<void> {
      const path = join(stateReal, "pending-resume.json");
      let signed = "";
      await readRecordFile(
        path,
        (text) => {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            skipped["bad-json"] += 1;
            return;
          }
          const parsed = parsePendingResume(raw);
          if (!parsed.ok) {
            skipped[parsed.reason] += 1;
            return;
          }
          signatureParts.push(signed);
          pending.push({ ...parsed.value, projectId: project.projectId });
        },
        (info) => {
          signed = `${project.projectId}|${path}|${info.size}|${info.mtimeMs}`;
        },
      );
    }

    async function readCandidate(
      dir: string,
      containedIn: string,
      project: ProjectRef,
      projectRoot: string,
    ): Promise<void> {
      const stateReal = await fs.realpath(dir);
      if (stateReal === null) return;
      if (!isInside(stateReal, containedIn)) {
        skipped["outside-root"] += 1;
        return;
      }
      await readSessions(stateReal, project, projectRoot);
      await readPending(stateReal, project);
    }

    for (const project of projects) {
      const rootReal = await fs.realpath(project.root);
      if (rootReal === null) continue;
      // The wrapper hashes the realpath of its main checkout, so the candidates are built from it.
      const [local] = projectStateCandidates(rootReal, bridgeRoots[0]?.dir ?? deps.home);
      if (local !== undefined) await readCandidate(local, rootReal, project, rootReal);
      for (const bridge of bridgeRoots) {
        const user = projectStateCandidates(rootReal, bridge.dir)[1];
        if (user !== undefined) await readCandidate(user, bridge.real, project, rootReal);
      }
    }

    const merged = [...runsById.values()].sort(
      (a, b) => timeOf(b.startedAt) - timeOf(a.startedAt) || (a.runId < b.runId ? 1 : -1),
    );
    const runs: PrivateRun[] = [];
    for (const run of merged) {
      const wantsLog = run.status === "running" && run.mode !== "tui";
      runs.push({ ...run, liveLog: wantsLog ? await inspectLiveLog(run) : null });
    }
    const signature =
      signatureParts.length === 0
        ? ""
        : createHash("sha256").update(signatureParts.sort().join("\n")).digest("hex");
    return { runs, pending, skipped, signature };
  }

  function scan(): Promise<RunRecordScan> {
    if (inFlight !== null) return inFlight;
    const attempt = scanOnce()
      .catch((): RunRecordScan => {
        // An unexpected fault is an empty scan, never a throw and never a message.
        const skipped = zeroCounters();
        skipped["read-failed"] = 1;
        return { runs: [], pending: [], skipped, signature: "" };
      })
      .then((result) => {
        lastScan = result;
        return result;
      })
      .finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  }

  return { scan, last: () => lastScan, inspectLiveLog };
}

// ---------------------------------------------------------------------------
// The paused-run summary (CODEX-11, D-04)

export interface PausedRunSummary {
  /** Sessions currently shown as paused by the usage limit. */
  readonly count: number;
  /** The earliest known resume time, or null when none is known. */
  readonly earliestResetAt: string | null;
  /** How many paused sessions have no reported resume time. */
  readonly withoutResetAt: number;
}

/**
 * The paused runs of a sessions snapshot, for the headroom signal. Pure: it reads no file and no
 * clock, and it only describes; it never dispatches a resume.
 */
export function summarizePausedRuns(snapshot: CodexSessionsSnapshot | null): PausedRunSummary {
  if (snapshot === null || snapshot.kind !== "available") {
    return { count: 0, earliestResetAt: null, withoutResetAt: 0 };
  }
  let count = 0;
  let withoutResetAt = 0;
  let earliest: { readonly iso: string; readonly ms: number } | null = null;
  for (const session of snapshot.sessions) {
    if (session.state !== "limit-paused") continue;
    count += 1;
    if (session.resumesAfter === null) {
      withoutResetAt += 1;
      continue;
    }
    const ms = Date.parse(session.resumesAfter);
    if (!Number.isFinite(ms)) {
      withoutResetAt += 1;
      continue;
    }
    if (earliest === null || ms < earliest.ms) earliest = { iso: session.resumesAfter, ms };
  }
  return { count, earliestResetAt: earliest?.iso ?? null, withoutResetAt };
}
