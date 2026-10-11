import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

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

/**
 * Copies `operational.db` and (when present) `operational.db-wal` from the runtime directory
 * to `operational-copy.db` and `operational-copy.db-wal` in `destDir`. Never opens the source.
 */
export function copyStore(input: { runtimeDir: string; destDir: string }): { copyPath: string } {
  const source = join(input.runtimeDir, "operational.db");
  if (!existsSync(source)) {
    throw new Error("Store copy failed: the operational database is not present.");
  }
  mkdirSync(input.destDir, { recursive: true, mode: 0o700 });
  const copyPath = join(input.destDir, COPY_DB_NAME);
  const copyWal = `${copyPath}-wal`;
  // A stale copied log from an earlier read must never be replayed onto a fresh copy.
  rmSync(copyWal, { force: true });
  rmSync(`${copyPath}-shm`, { force: true });
  copyFileSync(source, copyPath);
  const sourceWal = `${source}-wal`;
  if (existsSync(sourceWal)) copyFileSync(sourceWal, copyWal);
  return { copyPath };
}

/** Runs one statement against a copy, read-only, and returns the rows parsed from JSON. */
export async function queryStore(input: {
  copyPath: string;
  sql: string;
  deps?: StoreCopyDeps;
}): Promise<Array<Record<string, unknown>>> {
  assertCopyPath(input.copyPath);
  // A leading dot is a sqlite3 shell dot-command (.shell, .system, .output ...), not SQL.
  if (input.sql.trimStart().startsWith(".")) {
    throw new Error("A sqlite3 dot-command is not allowed; pass one SQL statement.");
  }
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
