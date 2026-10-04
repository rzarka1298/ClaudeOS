import {
  hasControlCharacter,
  newProjectId,
  newScanRootId,
  type ProjectId,
  type ScanRootId,
} from "@ccc/domain";
import type Database from "better-sqlite3";

/**
 * Projects, scan-root and launcher-config persistence (Phase 4, D-01, D-02,
 * D-07, D-08, D-46, PROJ-01, PROJ-15).
 *
 * The operational store is the only home of a project's absolute path: the
 * store sits in the `0700` runtime directory, and nothing in this module
 * returns a path to anything but the service, which home-abbreviates it
 * before a view reaches the plugin (D-43).
 *
 * Every function takes an already-open `Database` and uses prepared
 * statements with named parameters only — no value is ever interpolated
 * into SQL. Booleans are stored as `"true"` / `"false"` and scan depth as a
 * digit string, per `schema.ts`'s all-text column rule, and converted at
 * this boundary. Validation runs BEFORE any statement, and a validation
 * error names the field, never the value (the value may be a path or a name
 * the owner typed, and error messages reach logs).
 *
 * This package performs no filesystem call at all: removing a project is a
 * row operation only and can never touch the folder on disk (D-08).
 *
 * Launcher configuration: callers validate with the domain launcher-config
 * schema before saving; this module stores the already-validated object as
 * JSON. No rendered command line, launch stderr or remote-URL userinfo is
 * ever passed in (D-46, PROJ-14).
 *
 * Rejected alternative: "insert, and let the UNIQUE index reject a
 * duplicate". Registering the same folder twice is a normal owner action
 * (PROJ-01) that must answer with the existing project, not an error; so the
 * lookup and the insert run in one transaction, and a UNIQUE violation from
 * a concurrent writer is caught and resolved to the row that won.
 */

/** Thrown before any statement runs when an input is invalid. Carries the field name only. */
export class ProjectStoreValidationError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`invalid ${field}`);
    this.name = "ProjectStoreValidationError";
    this.field = field;
  }
}

/** The longest display name the store accepts (RR-11). */
const MAX_DISPLAY_NAME_LENGTH = 64;

/** Trims and validates a display name (RR-11): 1..64 characters, no control characters. */
function normalizeDisplayName(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_DISPLAY_NAME_LENGTH ||
    hasControlCharacter(trimmed)
  ) {
    throw new ProjectStoreValidationError("displayName");
  }
  return trimmed;
}

/** A stored path must be a non-empty string with no control character (the route has already checked it is absolute). */
function assertValidStoredPath(value: string): void {
  if (value.length === 0 || hasControlCharacter(value)) {
    throw new ProjectStoreValidationError("path");
  }
}

/** True for better-sqlite3's UNIQUE-constraint error, without importing its error class. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

// ---------------------------------------------------------------------------
// Projects

/** A project row as the service sees it. `path` is the stored realpath. */
export interface ProjectRecord {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly displayName: string;
  readonly pinned: boolean;
  readonly lastOpenedAt: string | null;
  readonly githubUrlOverride: string | null;
  readonly registeredAt: string;
}

/** What registering a project needs; the ID is minted here, never supplied. */
export interface NewProject {
  readonly path: string;
  readonly displayName: string;
  /** Defaults to now; injectable so tests can pin time. */
  readonly registeredAt?: string;
}

/** `created: false` means the path was already registered and `record` is the existing row. */
export interface InsertProjectResult {
  readonly created: boolean;
  readonly record: ProjectRecord;
}

interface ProjectRow {
  project_id: string;
  path: string;
  display_name: string;
  pinned: string;
  last_opened_at: string | null;
  github_url_override: string | null;
  registered_at: string;
}

const PROJECT_COLUMNS =
  "project_id, path, display_name, pinned, last_opened_at, github_url_override, registered_at";

/**
 * PROJ-15 / UI-SPEC S1 order: pinned first, then most recently opened,
 * never-opened last, ties by display name case-insensitively. The domain
 * `compareProjectViews` implements the same order for the plugin.
 */
const PROJECT_ORDER =
  "pinned = 'true' DESC, last_opened_at IS NULL, last_opened_at DESC, display_name COLLATE NOCASE";

function rowToProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id as ProjectId,
    path: row.path,
    displayName: row.display_name,
    pinned: row.pinned === "true",
    lastOpenedAt: row.last_opened_at,
    githubUrlOverride: row.github_url_override,
    registeredAt: row.registered_at,
  };
}

/** The project registered at exactly `path` (a stored realpath), or `null`. */
export function findProjectByPath(db: Database.Database, path: string): ProjectRecord | null {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE path = @path`)
    .get({ path }) as ProjectRow | undefined;
  return row ? rowToProjectRecord(row) : null;
}

/** The project with `projectId`, or `null`. */
export function getProject(db: Database.Database, projectId: ProjectId): ProjectRecord | null {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE project_id = @projectId`)
    .get({ projectId }) as ProjectRow | undefined;
  return row ? rowToProjectRecord(row) : null;
}

/** Every registered project in the PROJ-15 order. */
export function listProjects(db: Database.Database): ProjectRecord[] {
  const rows = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY ${PROJECT_ORDER}`)
    .all() as ProjectRow[];
  return rows.map(rowToProjectRecord);
}

/**
 * Registers `input.path`, idempotently (PROJ-01): if the path is already
 * registered the existing record comes back with `created: false` and
 * nothing is written — in particular the stored display name is kept.
 */
export function insertProject(db: Database.Database, input: NewProject): InsertProjectResult {
  assertValidStoredPath(input.path);
  const displayName = normalizeDisplayName(input.displayName);
  const insert = db.transaction((): InsertProjectResult => {
    const existing = findProjectByPath(db, input.path);
    if (existing) {
      return { created: false, record: existing };
    }
    const projectId = newProjectId();
    db.prepare(
      `INSERT INTO projects (project_id, path, display_name, registered_at, pinned)
       VALUES (@projectId, @path, @displayName, @registeredAt, 'false')`,
    ).run({
      projectId,
      path: input.path,
      displayName,
      registeredAt: input.registeredAt ?? new Date().toISOString(),
    });
    const record = getProject(db, projectId);
    if (!record) {
      throw new Error("inserted project row could not be read back");
    }
    return { created: true, record };
  });
  try {
    return insert();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = findProjectByPath(db, input.path);
      if (existing) {
        return { created: false, record: existing };
      }
    }
    throw err;
  }
}

/** Pins or unpins a project. Returns `false` when no such project exists. */
export function setProjectPinned(
  db: Database.Database,
  projectId: ProjectId,
  pinned: boolean,
): boolean {
  const result = db
    .prepare("UPDATE projects SET pinned = @pinned WHERE project_id = @projectId")
    .run({ projectId, pinned: pinned ? "true" : "false" });
  return result.changes > 0;
}

/** Renames a project's display name (RR-11: trimmed, 1..64 characters, no control characters). */
export function renameProject(
  db: Database.Database,
  projectId: ProjectId,
  displayName: string,
): boolean {
  const normalized = normalizeDisplayName(displayName);
  const result = db
    .prepare("UPDATE projects SET display_name = @displayName WHERE project_id = @projectId")
    .run({ projectId, displayName: normalized });
  return result.changes > 0;
}

/**
 * Sets or clears (`null`) the owner-typed GitHub link (RR-12). The store
 * checks only that a set value is a non-empty string; the route validates
 * the URL shape with the domain `GithubLinkSchema` before calling this.
 */
export function setGithubUrlOverride(
  db: Database.Database,
  projectId: ProjectId,
  url: string | null,
): boolean {
  if (url !== null && url.length === 0) {
    throw new ProjectStoreValidationError("githubUrlOverride");
  }
  const result = db
    .prepare("UPDATE projects SET github_url_override = @url WHERE project_id = @projectId")
    .run({ projectId, url });
  return result.changes > 0;
}

/** Records a launch against the project (drives the PROJ-15 order). `at` defaults to now. */
export function touchLastOpened(
  db: Database.Database,
  projectId: ProjectId,
  at: string = new Date().toISOString(),
): boolean {
  const result = db
    .prepare("UPDATE projects SET last_opened_at = @at WHERE project_id = @projectId")
    .run({ projectId, at });
  return result.changes > 0;
}

/**
 * Removes a project from the store (D-08). In ONE transaction, every Run
 * that referenced it keeps its history with `project_id` set to NULL, then
 * the project row is deleted — so the delete is valid with foreign keys
 * enforced and no Run is ever lost. Nothing on disk is touched: this
 * package has no filesystem access at all. Returns `false` for an unknown
 * project.
 */
export function removeProject(db: Database.Database, projectId: ProjectId): boolean {
  const remove = db.transaction((): boolean => {
    db.prepare("UPDATE runs SET project_id = NULL WHERE project_id = @projectId").run({
      projectId,
    });
    const result = db
      .prepare("DELETE FROM projects WHERE project_id = @projectId")
      .run({ projectId });
    return result.changes > 0;
  });
  return remove();
}

// ---------------------------------------------------------------------------
// Scan roots

/** A folder the owner nominated for project suggestions (D-07). */
export interface ScanRootRecord {
  readonly scanRootId: ScanRootId;
  readonly path: string;
  readonly depth: number;
  readonly addedAt: string;
  readonly lastScannedAt: string | null;
}

export interface NewScanRoot {
  readonly path: string;
  readonly depth: number;
  /** Defaults to now; injectable so tests can pin time. */
  readonly addedAt?: string;
}

/** `created: false` means the path was already a scan root and `record` is the existing row. */
export interface InsertScanRootResult {
  readonly created: boolean;
  readonly record: ScanRootRecord;
}

interface ScanRootRow {
  scan_root_id: string;
  path: string;
  depth: string;
  added_at: string;
  last_scanned_at: string | null;
}

const SCAN_ROOT_COLUMNS = "scan_root_id, path, depth, added_at, last_scanned_at";

/** Scan depth is 1..3 levels (D-07); anything else is refused before SQL. */
function assertValidDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
    throw new ProjectStoreValidationError("depth");
  }
}

function rowToScanRootRecord(row: ScanRootRow): ScanRootRecord {
  return {
    scanRootId: row.scan_root_id as ScanRootId,
    path: row.path,
    depth: Number(row.depth),
    addedAt: row.added_at,
    lastScannedAt: row.last_scanned_at,
  };
}

/** The scan root at exactly `path`, or `null`. */
export function findScanRootByPath(db: Database.Database, path: string): ScanRootRecord | null {
  const row = db
    .prepare(`SELECT ${SCAN_ROOT_COLUMNS} FROM scan_roots WHERE path = @path`)
    .get({ path }) as ScanRootRow | undefined;
  return row ? rowToScanRootRecord(row) : null;
}

/** The scan root with `scanRootId`, or `null`. */
export function getScanRoot(db: Database.Database, scanRootId: ScanRootId): ScanRootRecord | null {
  const row = db
    .prepare(`SELECT ${SCAN_ROOT_COLUMNS} FROM scan_roots WHERE scan_root_id = @scanRootId`)
    .get({ scanRootId }) as ScanRootRow | undefined;
  return row ? rowToScanRootRecord(row) : null;
}

/** Every scan root, oldest first. */
export function listScanRoots(db: Database.Database): ScanRootRecord[] {
  const rows = db
    .prepare(`SELECT ${SCAN_ROOT_COLUMNS} FROM scan_roots ORDER BY added_at, path`)
    .all() as ScanRootRow[];
  return rows.map(rowToScanRootRecord);
}

/** Nominates `input.path` as a scan root, idempotently by path (like {@link insertProject}). */
export function insertScanRoot(db: Database.Database, input: NewScanRoot): InsertScanRootResult {
  assertValidStoredPath(input.path);
  assertValidDepth(input.depth);
  const insert = db.transaction((): InsertScanRootResult => {
    const existing = findScanRootByPath(db, input.path);
    if (existing) {
      return { created: false, record: existing };
    }
    const scanRootId = newScanRootId();
    db.prepare(
      `INSERT INTO scan_roots (scan_root_id, path, depth, added_at)
       VALUES (@scanRootId, @path, @depth, @addedAt)`,
    ).run({
      scanRootId,
      path: input.path,
      depth: String(input.depth),
      addedAt: input.addedAt ?? new Date().toISOString(),
    });
    const record = getScanRoot(db, scanRootId);
    if (!record) {
      throw new Error("inserted scan root row could not be read back");
    }
    return { created: true, record };
  });
  try {
    return insert();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = findScanRootByPath(db, input.path);
      if (existing) {
        return { created: false, record: existing };
      }
    }
    throw err;
  }
}

/** Changes a scan root's depth (1..3). Returns `false` when no such scan root exists. */
export function setScanRootDepth(
  db: Database.Database,
  scanRootId: ScanRootId,
  depth: number,
): boolean {
  assertValidDepth(depth);
  const result = db
    .prepare("UPDATE scan_roots SET depth = @depth WHERE scan_root_id = @scanRootId")
    .run({ scanRootId, depth: String(depth) });
  return result.changes > 0;
}

/** Records that a scan of this root finished. `at` defaults to now. */
export function touchScanned(
  db: Database.Database,
  scanRootId: ScanRootId,
  at: string = new Date().toISOString(),
): boolean {
  const result = db
    .prepare("UPDATE scan_roots SET last_scanned_at = @at WHERE scan_root_id = @scanRootId")
    .run({ scanRootId, at });
  return result.changes > 0;
}

/** Stops scanning a folder: deletes the scan_roots row only. Registered projects are untouched. */
export function removeScanRoot(db: Database.Database, scanRootId: ScanRootId): boolean {
  const result = db
    .prepare("DELETE FROM scan_roots WHERE scan_root_id = @scanRootId")
    .run({ scanRootId });
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Launcher configuration

/**
 * The launchers that carry stored configuration. Finder and GitHub need no
 * setup (RR-26). Declared here rather than imported so this store does not
 * depend on a same-wave domain file; a test asserts it equals the domain
 * `LAUNCHER_IDS`.
 */
export const STORED_LAUNCHER_IDS = ["antigravity", "claude-code", "claude-desktop"] as const;
export type StoredLauncherId = (typeof STORED_LAUNCHER_IDS)[number];

/** One launcher's saved configuration. `config` is the parsed JSON the caller validated before saving. */
export interface LauncherConfigRecord {
  readonly launcherId: StoredLauncherId;
  readonly config: unknown;
  readonly tested: boolean;
  readonly updatedAt: string;
}

interface LauncherConfigRow {
  launcher_id: string;
  config_json: string;
  tested: string;
  updated_at: string;
}

function assertStoredLauncherId(value: string): asserts value is StoredLauncherId {
  if (!(STORED_LAUNCHER_IDS as readonly string[]).includes(value)) {
    throw new ProjectStoreValidationError("launcherId");
  }
}

/**
 * `null` when the row cannot be read: an unknown launcher id or a
 * `config_json` that is not JSON. Such a row reads as "not configured" for
 * that launcher only, so one damaged row never breaks every launcher;
 * saving the launcher again replaces it.
 */
function rowToLauncherConfigRecord(row: LauncherConfigRow): LauncherConfigRecord | null {
  if (!(STORED_LAUNCHER_IDS as readonly string[]).includes(row.launcher_id)) return null;
  let config: unknown;
  try {
    config = JSON.parse(row.config_json) as unknown;
  } catch {
    return null;
  }
  return {
    launcherId: row.launcher_id as StoredLauncherId,
    config,
    tested: row.tested === "true",
    updatedAt: row.updated_at,
  };
}

/**
 * Saves (or replaces) a launcher's configuration. Saving always resets
 * `tested` to false: a changed configuration has not been proven to open
 * anything yet (RR-14).
 */
export function saveLauncherConfig(
  db: Database.Database,
  launcherId: string,
  config: unknown,
  updatedAt: string = new Date().toISOString(),
): LauncherConfigRecord {
  assertStoredLauncherId(launcherId);
  const configJson = JSON.stringify(config);
  if (configJson === undefined) {
    throw new ProjectStoreValidationError("config");
  }
  db.prepare(
    `INSERT INTO launcher_config (launcher_id, config_json, tested, updated_at)
     VALUES (@launcherId, @configJson, 'false', @updatedAt)
     ON CONFLICT(launcher_id) DO UPDATE SET
       config_json = excluded.config_json,
       tested = 'false',
       updated_at = excluded.updated_at`,
  ).run({ launcherId, configJson, updatedAt });
  return { launcherId, config: JSON.parse(configJson) as unknown, tested: false, updatedAt };
}

/** A launcher's saved configuration, or `null` when it has never been set up or its row is unreadable. */
export function getLauncherConfig(
  db: Database.Database,
  launcherId: string,
): LauncherConfigRecord | null {
  assertStoredLauncherId(launcherId);
  const row = db
    .prepare(
      "SELECT launcher_id, config_json, tested, updated_at FROM launcher_config WHERE launcher_id = @launcherId",
    )
    .get({ launcherId }) as LauncherConfigRow | undefined;
  return row ? rowToLauncherConfigRecord(row) : null;
}

/** Every readable saved launcher configuration; unreadable rows are skipped. */
export function listLauncherConfigs(db: Database.Database): LauncherConfigRecord[] {
  const rows = db
    .prepare(
      "SELECT launcher_id, config_json, tested, updated_at FROM launcher_config ORDER BY launcher_id",
    )
    .all() as LauncherConfigRow[];
  return rows.flatMap((row) => {
    const record = rowToLauncherConfigRecord(row);
    return record === null ? [] : [record];
  });
}

/** Marks a saved configuration as tested (RR-14). Returns `false` when nothing readable is saved for it. */
export function markLauncherTested(db: Database.Database, launcherId: string): boolean {
  assertStoredLauncherId(launcherId);
  const result = db
    .prepare(
      "UPDATE launcher_config SET tested = 'true' WHERE launcher_id = @launcherId AND json_valid(config_json)",
    )
    .run({ launcherId });
  return result.changes > 0;
}
