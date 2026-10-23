/**
 * The four counts the health response carries for the diagnostic bundle (plan 08-12; D-10): how
 * many projects, scan folders, open tasks and recorded reports the operational store holds.
 *
 * Each is one fixed `SELECT COUNT(*)` with no parameters, read from the store and nothing else (a
 * local synchronous SQLite read, which FIX2A accepts: it is not a file on a mount). A count whose
 * read fails, or whose answer is not a non-negative safe integer, is `null`, never zero: a failed
 * read is not an empty table (ADR-0002, never invent a state), and one failing table does not blank
 * the other three. Nothing a read throws is kept, so no path or SQL text can leave this module.
 *
 * - `openTasks` counts the actionable tasks (not done, not cancelled, not a suggestion waiting for a
 *   decision), the rule the tasks list's "open" total uses.
 * - `reports` counts the research report records the pipeline finalised. It is the store's own
 *   count; it does not walk the vault, because a vault walk is file-system work the health path
 *   must not do.
 */

/** The only thing this module asks of the database: prepare a statement and read one row. */
export interface CountDb {
  prepare(sql: string): { get(): unknown };
}

export interface HealthCounts {
  readonly projects: number | null;
  readonly scanFolders: number | null;
  readonly openTasks: number | null;
  readonly reports: number | null;
}

const QUERIES: Readonly<Record<keyof HealthCounts, string>> = {
  projects: "SELECT COUNT(*) AS n FROM projects",
  scanFolders: "SELECT COUNT(*) AS n FROM scan_roots",
  openTasks:
    "SELECT COUNT(*) AS n FROM task_index WHERE status NOT IN ('done','cancelled','proposed')",
  reports: "SELECT COUNT(*) AS n FROM research_report_records",
};

function countOf(db: CountDb, sql: string): number | null {
  try {
    const row = db.prepare(sql).get();
    if (typeof row !== "object" || row === null) return null;
    const value = (row as { n?: unknown }).n;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function readHealthCounts(db: CountDb): HealthCounts {
  return {
    projects: countOf(db, QUERIES.projects),
    scanFolders: countOf(db, QUERIES.scanFolders),
    openTasks: countOf(db, QUERIES.openTasks),
    reports: countOf(db, QUERIES.reports),
  };
}
