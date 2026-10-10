import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import {
  type CodexFs,
  type CodexHomePort,
  defaultCodexFs,
  type RolloutRef,
} from "../codex/codex-home.js";
import type { CodexStoreReader, OpenDatabase } from "../codex/store-reader.js";

/**
 * A temporary CODEX_HOME for tests (plan 05.1-14). Everything lives under one
 * `mkdtemp` directory with synthetic content; the owner's real Codex home is
 * never read. The decoy credential and config files carry an obviously fake
 * marker, and their names are ASSEMBLED here at runtime so no source line
 * spells them (the CODEX-09 backstop covers non-test source, this keeps the
 * fixtures honest too).
 */

/** The fake secret planted in every decoy; it must never appear in any output. */
export const DECOY_MARKER = "DECOY-SECRET-MARKER-NOT-A-REAL-CREDENTIAL-7f3a";

const CREDENTIAL_NAME = ["auth", "json"].join(".");
const CONFIG_NAME = ["config", "toml"].join(".");

/** Names that look like the decoys or like allowlisted files. */
const LOOKALIKE_NAMES: readonly string[] = [
  `${CREDENTIAL_NAME}.bak`,
  `${CREDENTIAL_NAME}.old`,
  `backup-${CREDENTIAL_NAME}`,
  `${CONFIG_NAME}.bak`,
  `old-${CONFIG_NAME}`,
  "session_index.jsonl.bak",
  "hooks.json.bak",
  "version.json.old",
];

export interface FakeRollout {
  /** The dated folder, `YYYY-MM-DD`. */
  readonly day: string;
  /** File name, e.g. `rollout-2026-10-06T10-00-00-aaaa.jsonl`. */
  readonly name: string;
  readonly content?: string;
  /** Optional modification time to stamp on the file. */
  readonly mtimeMs?: number;
}

export interface FakeCodexHomeOptions {
  readonly rollouts?: readonly FakeRollout[];
  /** Rollouts under the archived folder (never readable through the port). */
  readonly archivedRollouts?: readonly FakeRollout[];
  readonly sessionIndex?: string | undefined;
  readonly hooksJson?: string | undefined;
  readonly version?: string | undefined;
  /** Plants the decoy credential file, the decoy config file and lookalikes. */
  readonly withDecoys?: boolean;
  /** Plants a rollout-named symlink inside sessions that points at the decoy credential file. */
  readonly escapeSymlink?: boolean;
  /** Creates the synthetic thread store from one of the DDL fixtures. */
  readonly database?: FakeDatabaseOptions;
}

export type FakeDdl = "floor" | "current" | "changed";

export interface FakeThread {
  readonly id: string;
  readonly updatedAtMs: number;
  readonly createdAtMs?: number;
  readonly rolloutPath?: string;
  readonly cwd?: string;
  readonly source?: string;
  readonly cliVersion?: string;
  readonly archived?: boolean;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly threadSource?: string;
  readonly agentNickname?: string;
  readonly title?: string;
  readonly name?: string;
}

export interface FakeDatabaseOptions {
  readonly ddl: FakeDdl;
  readonly threads?: readonly FakeThread[];
  /** Default "wal", the mode the real store uses. */
  readonly journalMode?: "wal" | "delete";
}

/** Planted in the never-select columns; none of these may reach any reader output. */
export const DECOY_PROMPT = "DECOY-PROMPT-TEXT-NOT-REAL";
export const DECOY_GIT_ORIGIN = "DECOY-GIT-ORIGIN-NOT-REAL";
export const DECOY_CREATOR_ID = "DECOY-CREATOR-ID-NOT-REAL";
export const DECOY_PREVIEW = "DECOY-PREVIEW-TEXT-NOT-REAL";
export const NEVER_SELECT_DECOYS: readonly string[] = [
  DECOY_PROMPT,
  DECOY_GIT_ORIGIN,
  DECOY_CREATOR_ID,
  DECOY_PREVIEW,
];

const DDL_DIR = new URL("./codex-fixtures/", import.meta.url);

export function loadFakeDdl(ddl: FakeDdl): string {
  return readFileSync(new URL(`ddl-${ddl}.sql`, DDL_DIR), "utf8");
}

export interface FakeCodexHome {
  /** The real (symlink-free) temporary root. */
  readonly root: string;
  readonly decoys: {
    readonly credentialName: string;
    readonly configName: string;
    readonly credentialPath: string;
    readonly configPath: string;
    readonly lookalikeNames: readonly string[];
    readonly marker: string;
  };
  /** Absolute path of a rollout under `sessions/YYYY/MM/DD/`. */
  rolloutPath(day: string, name: string): string;
  /** Path of the escape symlink when `escapeSymlink` was requested. */
  readonly escapeSymlinkPath: string;
  /** Absolute path of the synthetic thread store (it exists only when `database` was given). */
  readonly dbPath: string;
  /** name, size and mtime of every entry under the root, keyed by relative path. */
  snapshot(): Map<string, string>;
  cleanup(): void;
}

function datedDir(root: string, folder: string, day: string): string {
  const [year, month, date] = day.split("-");
  return join(root, folder, year ?? "", month ?? "", date ?? "");
}

function writeRollout(root: string, folder: string, rollout: FakeRollout): void {
  const dir = datedDir(root, folder, rollout.day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, rollout.name);
  writeFileSync(file, rollout.content ?? "");
  if (rollout.mtimeMs !== undefined) {
    const seconds = rollout.mtimeMs / 1000;
    utimesSync(file, seconds, seconds);
  }
}

export function createFakeCodexHome(options: FakeCodexHomeOptions = {}): FakeCodexHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-fake-codex-")));
  mkdirSync(join(root, "sessions"), { recursive: true });
  for (const rollout of options.rollouts ?? []) writeRollout(root, "sessions", rollout);
  for (const rollout of options.archivedRollouts ?? []) {
    writeRollout(root, "archived_sessions", rollout);
  }
  if (options.sessionIndex !== undefined) {
    writeFileSync(join(root, "session_index.jsonl"), options.sessionIndex);
  }
  if (options.hooksJson !== undefined) writeFileSync(join(root, "hooks.json"), options.hooksJson);
  if (options.version !== undefined) writeFileSync(join(root, "version.json"), options.version);

  const credentialPath = join(root, CREDENTIAL_NAME);
  const configPath = join(root, CONFIG_NAME);
  if (options.withDecoys === true) {
    writeFileSync(credentialPath, `{"token":"${DECOY_MARKER}"}\n`);
    writeFileSync(configPath, `notify = ["${DECOY_MARKER}"]\n`);
    for (const name of LOOKALIKE_NAMES) writeFileSync(join(root, name), `${DECOY_MARKER}\n`);
  }

  const escapeSymlinkPath = join(root, "sessions", "2026", "10", "06", "rollout-escape-link.jsonl");
  if (options.escapeSymlink === true) {
    mkdirSync(join(root, "sessions", "2026", "10", "06"), { recursive: true });
    if (options.withDecoys !== true) writeFileSync(credentialPath, `${DECOY_MARKER}\n`);
    symlinkSync(credentialPath, escapeSymlinkPath);
  }

  const dbPath = join(root, "state_5.sqlite");
  if (options.database !== undefined) buildFakeDatabase(root, dbPath, options.database);

  return {
    root,
    dbPath,
    decoys: {
      credentialName: CREDENTIAL_NAME,
      configName: CONFIG_NAME,
      credentialPath,
      configPath,
      lookalikeNames: LOOKALIKE_NAMES,
      marker: DECOY_MARKER,
    },
    escapeSymlinkPath,
    rolloutPath: (day, name) => join(datedDir(root, "sessions", day), name),
    snapshot: () => snapshotTree(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function buildFakeDatabase(root: string, dbPath: string, options: FakeDatabaseOptions): void {
  const db = new Database(dbPath);
  try {
    db.pragma(`journal_mode = ${options.journalMode === "delete" ? "DELETE" : "WAL"}`);
    db.exec(loadFakeDdl(options.ddl));
    const present = new Set(
      (db.pragma("table_info(threads)") as { name: string }[]).map((row) => row.name),
    );
    for (const thread of options.threads ?? []) {
      const created = thread.createdAtMs ?? thread.updatedAtMs - 1000;
      const values: Record<string, string | number | null> = {
        id: thread.id,
        rollout_path:
          thread.rolloutPath ??
          join(root, "sessions", "2026", "10", "06", `rollout-${thread.id}.jsonl`),
        cwd: thread.cwd ?? "/Users/USERNAME/repo",
        source: thread.source ?? "cli",
        cli_version: thread.cliVersion ?? "0.159.2",
        archived: thread.archived === true ? 1 : 0,
        updated_at_ms: thread.updatedAtMs,
        created_at_ms: created,
        created_at: Math.floor(created / 1000),
        updated_at: Math.floor(thread.updatedAtMs / 1000),
        model: thread.model ?? null,
        reasoning_effort: thread.reasoningEffort ?? null,
        thread_source: thread.threadSource ?? null,
        agent_nickname: thread.agentNickname ?? null,
        title: thread.title ?? null,
        name: thread.name ?? null,
        first_user_message: DECOY_PROMPT,
        preview: DECOY_PREVIEW,
        git_origin_url: DECOY_GIT_ORIGIN,
        git_sha: DECOY_GIT_ORIGIN,
        git_branch: DECOY_GIT_ORIGIN,
        creator_user_id: DECOY_CREATOR_ID,
        creator_account_id: DECOY_CREATOR_ID,
      };
      const columns = Object.keys(values).filter((column) => present.has(column));
      const marks = columns.map(() => "?").join(", ");
      db.prepare(`INSERT INTO threads (${columns.join(", ")}) VALUES (${marks})`).run(
        ...columns.map((column) => values[column] ?? null),
      );
    }
    db.prepare("INSERT INTO _sqlx_migrations (version, description, success) VALUES (?, ?, ?)").run(
      1,
      "synthetic",
      1,
    );
  } finally {
    db.close();
  }
}

function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      out.set(relative(root, full), `${stat.isDirectory() ? "dir" : stat.size}:${stat.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

export interface RecordedCall {
  readonly op: string;
  readonly path: string;
}

export interface RecordingFs {
  readonly fs: CodexFs;
  readonly calls: RecordedCall[];
}

/** Wraps real (or supplied) read operations and logs every operation with its path argument. */
export function recordingFs(base: CodexFs = defaultCodexFs): RecordingFs {
  const calls: RecordedCall[] = [];
  const fs: CodexFs = {
    realpath: (path) => {
      calls.push({ op: "realpath", path });
      return base.realpath(path);
    },
    stat: (path) => {
      calls.push({ op: "stat", path });
      return base.stat(path);
    },
    readDir: (path) => {
      calls.push({ op: "readDir", path });
      return base.readDir(path);
    },
    readBytes: (path, offset, length) => {
      calls.push({ op: "readBytes", path });
      return base.readBytes(path, offset, length);
    },
  };
  return { fs, calls };
}

const ALLOWED_ROOT_NAMES: readonly string[] = [
  "state_5.sqlite",
  "state_5.sqlite-wal",
  "state_5.sqlite-shm",
  "session_index.jsonl",
  "version.json",
  "hooks.json",
];
const SESSIONS_RELATIVE =
  /^sessions(\/\d{4}(\/\d{2}(\/\d{2}(\/rollout-[A-Za-z0-9._-]+\.jsonl)?)?)?)?$/;

/**
 * True when a recorded path is one the port may legitimately touch: the home
 * root, an allowlisted file name directly under it, or the dated sessions
 * tree. Anything else (a decoy, a lookalike, the archived folder) is false.
 */
export function isAllowedCodexAccess(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  if (rel.startsWith("..")) return false;
  if (ALLOWED_ROOT_NAMES.includes(rel)) return true;
  return SESSIONS_RELATIVE.test(rel);
}

/**
 * The canary assertion (CODEX-09, D-26): every recorded access is on the
 * allowlist and none names a decoy or a lookalike. Throws on the first
 * violation, so a negative control can prove the check is able to fail.
 */
export function assertNoForbiddenAccess(calls: readonly RecordedCall[], home: FakeCodexHome): void {
  const forbidden = new Set<string>([
    home.decoys.credentialName,
    home.decoys.configName,
    ...home.decoys.lookalikeNames,
  ]);
  for (const call of calls) {
    const base = call.path.split("/").pop() ?? "";
    if (forbidden.has(base)) {
      throw new Error(`canary: forbidden access ${call.op} on a decoy name`);
    }
    if (
      call.path.includes(home.decoys.credentialName) ||
      call.path.includes(home.decoys.configName)
    ) {
      throw new Error(`canary: forbidden access ${call.op} naming a decoy`);
    }
    if (!isAllowedCodexAccess(call.path, home.root)) {
      throw new Error(`canary: access ${call.op} outside the allowlist`);
    }
  }
}

/** Everything a caller could see from an exercise: values, error messages. */
export interface PortExercise {
  readonly outputs: string[];
}

/**
 * Drives EVERY port method with benign and hostile arguments, swallowing the
 * expected refusals. Returns the strings the canary scans for the marker
 * (return values and thrown messages).
 */
export function exerciseCodexHomePort(port: CodexHomePort, home: FakeCodexHome): PortExercise {
  const outputs: string[] = [];
  const note = (value: unknown): void => {
    if (value instanceof Buffer) outputs.push(value.toString("utf8"));
    else outputs.push(JSON.stringify(value) ?? "undefined");
  };
  const attempt = (action: () => unknown): void => {
    try {
      const value = action();
      if (value !== null && typeof value === "object" && "bytes" in value) {
        note((value as { bytes: Buffer }).bytes);
      } else {
        note(value);
      }
    } catch (error) {
      outputs.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  };

  const names: readonly string[] = [
    "session_index.jsonl",
    "version.json",
    "hooks.json",
    "state_5.sqlite",
    home.decoys.credentialName,
    home.decoys.configName,
    ...home.decoys.lookalikeNames,
    "../x",
    "",
  ];
  for (const name of names) attempt(() => port.readNamed(name, 4096));
  attempt(() => port.stateDbPath());

  const dayStart = Date.UTC(2026, 9, 6);
  attempt(() => port.listRolloutFiles({ from: dayStart, to: dayStart + 86_400_000 }));
  const refs: RolloutRef[] = [
    { path: home.rolloutPath("2026-10-06", "rollout-2026-10-06T10-00-00-aaaa.jsonl") },
    { path: home.decoys.credentialPath },
    { path: home.decoys.configPath },
    { path: join(home.root, "archived_sessions", "2026", "10", "06", "rollout-x.jsonl") },
    { path: `${home.root}/sessions/2026/10/06/../../../../${home.decoys.credentialName}` },
    { path: "rollout-relative.jsonl" },
  ];
  for (const ref of refs) {
    attempt(() => port.statRollout(ref));
    attempt(() => port.readRolloutRange(ref, 0, 4096));
    attempt(() => port.resolveSessionsFile(ref.path));
  }
  return { outputs };
}

/** The only files SQLite itself may create next to the database for a read-only open of a closed WAL store. */
export const SQLITE_SIDECARS: readonly string[] = ["state_5.sqlite-wal", "state_5.sqlite-shm"];

export interface SnapshotDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

// RED stubs (plan 05.1-14, task 3): neutral behaviour; real versions land in GREEN.
export function diffSnapshots(
  _before: Map<string, string>,
  _after: Map<string, string>,
): SnapshotDiff {
  return { added: [], removed: [], changed: [] };
}

export function assertOnlySidecarChanges(_diff: SnapshotDiff): void {}

export function assertNoMarkerLeak(_texts: readonly string[], _home: FakeCodexHome): void {}

/**
 * A database opener that records the path it is asked to open (as an
 * `openDatabase` call, so the canary sees it) and then opens it for real.
 */
export function recordingOpener(calls: RecordedCall[]): OpenDatabase {
  return (path, options) => {
    calls.push({ op: "openDatabase", path });
    return new Database(path, options);
  };
}

/** Drives the store reader with benign and odd arguments; returns the strings a leak would show in. */
export function exerciseCodexStoreReader(reader: CodexStoreReader, nowMs: number): PortExercise {
  const outputs: string[] = [];
  const inputs = [
    { sinceMs: nowMs - 86_400_000, limit: 50, includePromptDerived: false },
    { sinceMs: nowMs - 86_400_000, limit: 50, includePromptDerived: true },
    { sinceMs: 0, limit: 1, includePromptDerived: false },
    { sinceMs: Number.NaN, limit: 0, includePromptDerived: true },
    { sinceMs: nowMs + 86_400_000, limit: 10_000, includePromptDerived: false },
  ];
  for (const input of inputs) {
    try {
      outputs.push(JSON.stringify(reader.readThreads(input)));
    } catch (error) {
      outputs.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }
  return { outputs };
}
