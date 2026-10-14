import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isSameOrInside, isSymlinkOnDisk, MSG_PATH_LINK } from "./canonical-path.js";
import { realRuntimeDir } from "./isolation-guards.js";

/**
 * Read-only access to the throwaway service's operational store (05.2-04, D-02, T-05.2-15).
 *
 * The live database is never opened: it is COPIED (database plus write-ahead file) to a name
 * ending `-copy.db`, and only that copy is read, with the sqlite3 command-line tool in
 * `-readonly -json` mode through an argv array (no shell). No database binding is imported
 * (backstop rule 3). The statements the specs run are the fixed constants below, written from
 * the three queries in 06-UAT.md tests 7 to 9; they are never built from request text.
 */

/** Prefer the system tool; fall back to PATH lookup on machines without /usr/bin/sqlite3. */
export const SQLITE_TOOL = existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";

export const COPY_DB_NAME = "operational-copy.db";

/** Newest six audit rows (06-UAT test 7). */
export const AUDIT_ROWS_SQL =
  "select seq, event, decided_via, detail from approval_audit order by seq desc limit 6;";

/** Effects per proposal (06-UAT test 8): every approved proposal appears with a count of 1. */
export const EFFECTS_PER_PROPOSAL_SQL =
  "select proposal_id, count(*) as effects from diagnostic_effects group by proposal_id order by proposal_id;";

/** Plain effect count (test 7 asserts zero after a denial). */
export const EFFECT_COUNT_SQL = "select count(*) as effects from diagnostic_effects;";

/** When each expiry was audited, service side (Wave 3 WR-08): `at` is an ISO timestamp. */
export const EXPIRED_EVENT_TIMES_SQL =
  "select proposal_id, at from approval_audit where event = 'expired' order by seq;";

/** Expired audit events (06-UAT test 9). */
export const EXPIRED_EVENTS_SQL =
  "select seq, proposal_id, event from approval_audit where event = 'expired' order by seq;";

export interface StoreCopyDeps {
  execFile: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
}

const execFileAsync = promisify(execFile);
const defaultDeps: StoreCopyDeps = {
  execFile: async (file, args) => {
    const { stdout } = await execFileAsync(file, [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout };
  },
};

/** The name must end `-copy.db`, so the live database can never be passed by mistake. */
export function assertCopyPath(copyPath: string): void {
  if (typeof copyPath !== "string" || !copyPath.endsWith("-copy.db")) {
    throw new Error("The store may only be read from a copy whose name ends -copy.db.");
  }
}

const MSG_REAL_RUNTIME = "Refusing the owner's real runtime folder.";
const MSG_OUTSIDE_ROOT = "Refusing a store path outside the run root.";

/** Rejects a path in the owner's real runtime folder, and one outside `runRoot` when given. */
function assertStorePath(path: string, runRoot: string | undefined): void {
  const real = realRuntimeDir(homedir());
  if (isSameOrInside(real, resolve(path))) throw new Error(MSG_REAL_RUNTIME);
  if (runRoot !== undefined && !isSameOrInside(resolve(runRoot), resolve(path))) {
    throw new Error(MSG_OUTSIDE_ROOT);
  }
}

const FORBIDDEN_SQL_WORDS =
  /\b(?:attach|detach|vacuum|pragma|insert|update|delete|drop|create|alter|replace|reindex|analyze|load_extension|begin|commit|rollback|savepoint|release)\b/i;

/**
 * Only a single read-only SELECT (or WITH ... SELECT) statement may reach sqlite3: no second
 * statement, no dot-command, and none of the keywords that write, attach another file or change
 * settings (`VACUUM INTO` is an arbitrary file write even on a read-only connection).
 */
export function assertReadOnlySql(sql: string): void {
  const text = sql.trim().replace(/;\s*$/, "");
  if (text === "" || text.startsWith(".")) {
    throw new Error("A sqlite3 dot-command is not allowed; pass one SQL statement.");
  }
  if (!/^(?:select|with)\b/i.test(text) || text.includes(";") || FORBIDDEN_SQL_WORDS.test(text)) {
    throw new Error("Only one read-only SELECT statement may be run against the store copy.");
  }
}

function snapshotOf(path: string): string {
  try {
    const info = statSync(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "";
  }
}

const COPY_ATTEMPTS = 5;

/**
 * Copies `operational.db` and (when present) `operational.db-wal` from the runtime directory
 * to `operational-copy.db` and `operational-copy.db-wal` in `destDir`. Never opens the source.
 */
export function copyStore(input: {
  runtimeDir: string;
  destDir: string;
  /** When given, both folders must sit inside it. */
  runRoot?: string | undefined;
}): { copyPath: string } {
  assertStorePath(input.runtimeDir, input.runRoot);
  assertStorePath(input.destDir, input.runRoot);
  const source = join(input.runtimeDir, "operational.db");
  if (!existsSync(source)) {
    throw new Error("Store copy failed: the operational database is not present.");
  }
  const copyPath = join(input.destDir, COPY_DB_NAME);
  const copyWal = `${copyPath}-wal`;
  // copyFileSync and rmSync follow a link: refuse one at the folder or at any file we touch.
  for (const path of [input.destDir, copyPath, copyWal, `${copyPath}-shm`]) {
    if (isSymlinkOnDisk(path)) throw new Error(MSG_PATH_LINK);
  }
  mkdirSync(input.destDir, { recursive: true, mode: 0o700 });
  // A stale copied log from an earlier read must never be replayed onto a fresh copy.
  rmSync(copyWal, { force: true });
  rmSync(`${copyPath}-shm`, { force: true });
  const sourceWal = `${source}-wal`;
  // The running service may checkpoint between the two copies; repeat until the database and
  // log did not change while they were copied (best effort after COPY_ATTEMPTS).
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
    const before = `${snapshotOf(source)}|${snapshotOf(sourceWal)}`;
    copyFileSync(source, copyPath);
    rmSync(copyWal, { force: true });
    if (existsSync(sourceWal)) copyFileSync(sourceWal, copyWal);
    if (before === `${snapshotOf(source)}|${snapshotOf(sourceWal)}`) break;
  }
  return { copyPath };
}

/** Runs one statement against a copy, read-only, and returns the rows parsed from JSON. */
export async function queryStore(input: {
  copyPath: string;
  sql: string;
  deps?: StoreCopyDeps;
  /** When given, the copy must sit inside it. */
  runRoot?: string | undefined;
}): Promise<Array<Record<string, unknown>>> {
  assertCopyPath(input.copyPath);
  assertStorePath(input.copyPath, input.runRoot);
  assertReadOnlySql(input.sql);
  const deps = input.deps ?? defaultDeps;
  let stdout: string;
  try {
    ({ stdout } = await deps.execFile(SQLITE_TOOL, [
      "-readonly",
      "-json",
      input.copyPath,
      input.sql,
    ]));
  } catch (error) {
    // The tool's own error text names the failure (e.g. "attempt to write a readonly database").
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim().split("\n")[0]
        : "";
    throw new Error(`Store read failed: ${stderr || "sqlite3 exited with an error"}`);
  }
  const text = stdout.trim();
  if (text === "") return [];
  return JSON.parse(text) as Array<Record<string, unknown>>;
}
