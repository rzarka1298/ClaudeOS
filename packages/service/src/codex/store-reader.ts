import {
  buildThreadsSelect,
  type CanaryRow,
  classifyThreadSource,
  compareCodexVersions,
  evaluateRolloutCanary,
  evaluateStoreShape,
  parseCodexVersion,
  type ThreadOrigin,
} from "@ccc/collectors";
import Database from "better-sqlite3";
import type { CodexHomePort } from "./codex-home.js";

/**
 * The read-only reader for Codex's thread store (CODEX-04, CODEX-07, D-16,
 * D-17, research R3).
 *
 * Codex keeps its thread list in a SQLite file the product does not own, in a
 * directory that also holds the owner's credentials. So the reader:
 *
 *   - learns the database path ONLY from the allowlisted port (never names a
 *     file itself),
 *   - opens it short-lived and read-only with `query_only` on and a busy
 *     timeout of at most 250 ms, and closes it before returning, on every path,
 *   - runs the shape gate (migrations table plus required columns) BEFORE
 *     reading any thread row, so a drifted store reads as "format changed",
 *   - builds the SELECT from named allowlisted columns (plan 08's builder), so
 *     identifier, git-origin, first-message and preview columns can never be
 *     selected, and title and name only under the analysis flag,
 *   - runs the rollout-freshness canary so a future move of live history out
 *     of rollouts reads as unavailable, never as quietly wrong.
 *
 * `ThreadRow` carries `cwd` and `rolloutPath` for service-internal use only
 * (attribution and file location). It is deliberately not exported from any
 * barrel and nothing here puts either on a domain wire type.
 */

/** A read-only open may create only the sidecars SQLite itself makes. */
export interface OpenDatabaseOptions {
  readonly readonly: true;
  readonly fileMustExist: true;
  /** The busy timeout in milliseconds (better-sqlite3 defaults to 5000). */
  readonly timeout: number;
}

export interface ReaderStatement {
  all(...params: unknown[]): unknown[];
}

/** The slice of a database connection the reader uses. */
export interface ReaderDatabase {
  pragma(source: string): unknown;
  prepare(sql: string): ReaderStatement;
  close(): void;
}

export type OpenDatabase = (path: string, options: OpenDatabaseOptions) => ReaderDatabase;

const defaultOpenDatabase: OpenDatabase = (path, options) => new Database(path, options);

/** The busy timeout never exceeds this: a busy store is skipped for the poll. */
export const MAX_BUSY_TIMEOUT_MS = 250;
export const MAX_THREAD_LIMIT = 500;
/** The freshness canary looks at threads updated within this window of `now`. */
export const CANARY_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const MIGRATIONS_TABLE = "_sqlx_migrations";
const MAX_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_LABEL_LENGTH = 128;
const MAX_TEXT_LENGTH = 512;

/** Service-private: carries cwd and rollout path, never placed on a wire type. */
export interface ThreadRow {
  readonly id: string;
  readonly rolloutPath: string;
  readonly cwd: string;
  /** One of the four visible source spellings (hidden children are never returned). */
  readonly source: string;
  readonly origin: ThreadOrigin;
  /** A well-formed Codex version, or null when the stored value is off-shape. */
  readonly cliVersion: string | null;
  readonly archived: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly threadSource?: string;
  readonly agentNickname?: string;
  /** Prompt-derived: present only when the caller passed the analysis flag. */
  readonly title?: string;
  readonly name?: string;
}

export type ThreadsUnavailableReason = "no-store" | "format-changed" | "busy" | "read-failed";

export type ThreadsRead =
  | {
      readonly kind: "ok";
      readonly threads: readonly ThreadRow[];
      /** Sub-agent children and unknown sources that Recent sessions does not list. */
      readonly hiddenCount: number;
      /** The highest well-formed cli version among the rows read, or null. */
      readonly newestCliVersion: string | null;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: ThreadsUnavailableReason;
      /** Known only when rows were read before the verdict (the canary case). */
      readonly newestCliVersion: string | null;
    };

export interface ReadThreadsInput {
  readonly sinceMs: number;
  readonly limit: number;
  readonly includePromptDerived: boolean;
}

export interface CodexStoreReader {
  readThreads(input: ReadThreadsInput): ThreadsRead;
}

function unavailable(
  reason: ThreadsUnavailableReason,
  newestCliVersion: string | null = null,
): ThreadsRead {
  return { kind: "unavailable", reason, newestCliVersion };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

interface MappedRow {
  readonly row: ThreadRow;
  readonly visible: boolean;
}

function mapRow(raw: unknown, includePromptDerived: boolean): MappedRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = boundedString(record.id, MAX_ID_LENGTH);
  const rolloutPath = boundedString(record.rollout_path, MAX_PATH_LENGTH);
  const cwd = boundedString(record.cwd, MAX_PATH_LENGTH);
  const source = typeof record.source === "string" ? record.source : "";
  const updatedAtMs = finiteMs(record.updated_at_ms);
  const createdAtMs = finiteMs(record.created_at_ms);
  if (
    id === null ||
    rolloutPath === null ||
    cwd === null ||
    updatedAtMs === null ||
    createdAtMs === null
  ) {
    return null;
  }
  const classification = classifyThreadSource(source);
  const cliVersion =
    typeof record.cli_version === "string" && parseCodexVersion(record.cli_version) !== null
      ? record.cli_version
      : null;
  const model = boundedString(record.model, MAX_LABEL_LENGTH);
  const reasoningEffort = boundedString(record.reasoning_effort, MAX_LABEL_LENGTH);
  const threadSource = boundedString(record.thread_source, MAX_LABEL_LENGTH);
  const agentNickname = boundedString(record.agent_nickname, MAX_LABEL_LENGTH);
  const title = includePromptDerived ? boundedString(record.title, MAX_TEXT_LENGTH) : null;
  const name = includePromptDerived ? boundedString(record.name, MAX_TEXT_LENGTH) : null;
  const row: ThreadRow = {
    id,
    rolloutPath,
    cwd,
    // Hidden sources may carry parent identifiers; the string is kept only for visible rows.
    source: classification.visible ? source.trim() : "",
    origin: classification.origin,
    cliVersion,
    archived: record.archived === 1 || record.archived === true,
    createdAtMs,
    updatedAtMs,
    ...(model === null ? {} : { model }),
    ...(reasoningEffort === null ? {} : { reasoningEffort }),
    ...(threadSource === null ? {} : { threadSource }),
    ...(agentNickname === null ? {} : { agentNickname }),
    ...(title === null ? {} : { title }),
    ...(name === null ? {} : { name }),
  };
  return { row, visible: classification.visible };
}

function newestVersion(rows: readonly ThreadRow[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (row.cliVersion === null) continue;
    if (best === null || compareCodexVersions(row.cliVersion, best) > 0) best = row.cliVersion;
  }
  return best;
}

export function createCodexStoreReader(options: {
  /** Only the allowlisted port: the reader never learns a path any other way. */
  readonly port: Pick<CodexHomePort, "stateDbPath" | "statRollout">;
  readonly openDatabase?: OpenDatabase;
  readonly now?: () => number;
  readonly busyTimeoutMs?: number;
}): CodexStoreReader {
  const { port } = options;
  const open = options.openDatabase ?? defaultOpenDatabase;
  const now = options.now ?? Date.now;
  const timeout = Math.max(
    0,
    Math.min(MAX_BUSY_TIMEOUT_MS, Math.floor(options.busyTimeoutMs ?? MAX_BUSY_TIMEOUT_MS)),
  );

  function rolloutMtime(row: ThreadRow): number | null {
    try {
      return port.statRollout({ path: row.rolloutPath })?.mtimeMs ?? null;
    } catch {
      // A refused rollout path counts as a missing rollout for the canary.
      return null;
    }
  }

  return {
    readThreads(input: ReadThreadsInput): ThreadsRead {
      const sinceMs = Number.isFinite(input.sinceMs) ? Math.floor(input.sinceMs) : 0;
      const limit = Math.max(1, Math.min(MAX_THREAD_LIMIT, Math.floor(input.limit) || 1));

      let dbPath: string | null;
      try {
        dbPath = port.stateDbPath();
      } catch {
        return unavailable("read-failed");
      }
      if (dbPath === null) return unavailable("no-store");

      let db: ReaderDatabase | undefined;
      try {
        db = open(dbPath, { readonly: true, fileMustExist: true, timeout });
        db.pragma("query_only = ON");
        db.pragma(`busy_timeout = ${timeout}`);

        const migrationsTable =
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .all(MIGRATIONS_TABLE).length > 0;
        const info = db.pragma("table_info(threads)");
        const columns = (Array.isArray(info) ? info : [])
          .map((entry) => (entry as { name?: unknown } | null)?.name)
          .filter((name): name is string => typeof name === "string");

        // The shape gate runs BEFORE any thread row is read.
        const shape = evaluateStoreShape({ migrationsTable, columns });
        if (!shape.ok) return unavailable("format-changed");

        const select = buildThreadsSelect(columns, {
          includePromptDerived: input.includePromptDerived,
        });
        const rawRows = db.prepare(select.sql).all(sinceMs, limit);

        const threads: ThreadRow[] = [];
        const all: ThreadRow[] = [];
        let hiddenCount = 0;
        for (const raw of rawRows) {
          const mapped = mapRow(raw, input.includePromptDerived);
          if (mapped === null) continue;
          all.push(mapped.row);
          if (mapped.visible) threads.push(mapped.row);
          else hiddenCount += 1;
        }
        const newestCliVersion = newestVersion(all);

        // Rollout freshness canary (Assumption A17), over recent live threads.
        const horizon = now() - CANARY_RECENT_MS;
        const canaryRows: CanaryRow[] = all
          .filter((row) => !row.archived && row.updatedAtMs >= horizon)
          .map((row) => ({ updatedAtMs: row.updatedAtMs, rolloutMtimeMs: rolloutMtime(row) }));
        if (evaluateRolloutCanary(canaryRows).verdict === "suspect") {
          return unavailable("format-changed", newestCliVersion);
        }
        return { kind: "ok", threads, hiddenCount, newestCliVersion };
      } catch (error) {
        if (isBusy(error)) return unavailable("busy");
        if (errorCode(error) === "SQLITE_CANTOPEN") return unavailable("no-store");
        return unavailable("read-failed");
      } finally {
        try {
          db?.close();
        } catch {
          // Closing a connection that failed to open or already closed is not an error to surface.
        }
      }
    },
  };
}
