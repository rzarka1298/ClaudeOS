import { newProjectId, type ProjectId, type ScanRootId } from "@ccc/domain";
import type Database from "better-sqlite3";

/**
 * Projects persistence (Phase 4, D-01, D-02, PROJ-01, PROJ-15).
 *
 * The operational store is the only home of a project's absolute path: the
 * store sits in the `0700` runtime directory, and nothing in this module
 * returns a path to anything but the service, which home-abbreviates it
 * before a view reaches the plugin (D-43).
 *
 * Every function takes an already-open `Database` and uses prepared
 * statements with named parameters only — no value is ever interpolated
 * into SQL. Booleans are stored as `"true"` / `"false"` per `schema.ts`'s
 * all-text column rule and converted at this boundary.
 *
 * Rejected alternative: "insert, and let the UNIQUE index reject a
 * duplicate". Registering the same folder twice is a normal owner action
 * (PROJ-01) that must answer with the existing project, not an error; so the
 * lookup and the insert run in one transaction, and a UNIQUE violation from
 * a concurrent writer is caught and resolved to the row that won.
 */

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

/** True for better-sqlite3's UNIQUE-constraint error, without importing its error class. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
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
      displayName: input.displayName,
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

// ---------------------------------------------------------------------------
// RED skeleton (plan 04-01 Task 2): typed exports only, so the failing tests
// fail on their assertions rather than on a missing export.

export class ProjectStoreValidationError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`invalid ${field}`);
    this.name = "ProjectStoreValidationError";
    this.field = field;
  }
}

function pendingTask2(name: string): never {
  throw new Error(
    `${name} is not implemented yet (packages/operational-store/src/project-store.ts)`,
  );
}

export function setProjectPinned(
  _db: Database.Database,
  _id: ProjectId,
  _pinned: boolean,
): boolean {
  return pendingTask2("setProjectPinned");
}
export function renameProject(_db: Database.Database, _id: ProjectId, _name: string): boolean {
  return pendingTask2("renameProject");
}
export function setGithubUrlOverride(
  _db: Database.Database,
  _id: ProjectId,
  _url: string | null,
): boolean {
  return pendingTask2("setGithubUrlOverride");
}
export function touchLastOpened(_db: Database.Database, _id: ProjectId, _at?: string): boolean {
  return pendingTask2("touchLastOpened");
}
export function removeProject(_db: Database.Database, _id: ProjectId): boolean {
  return pendingTask2("removeProject");
}

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
  readonly addedAt?: string;
}
export interface InsertScanRootResult {
  readonly created: boolean;
  readonly record: ScanRootRecord;
}
export function insertScanRoot(_db: Database.Database, _input: NewScanRoot): InsertScanRootResult {
  return pendingTask2("insertScanRoot");
}
export function findScanRootByPath(_db: Database.Database, _path: string): ScanRootRecord | null {
  return pendingTask2("findScanRootByPath");
}
export function getScanRoot(_db: Database.Database, _id: ScanRootId): ScanRootRecord | null {
  return pendingTask2("getScanRoot");
}
export function listScanRoots(_db: Database.Database): ScanRootRecord[] {
  return pendingTask2("listScanRoots");
}
export function setScanRootDepth(_db: Database.Database, _id: ScanRootId, _depth: number): boolean {
  return pendingTask2("setScanRootDepth");
}
export function touchScanned(_db: Database.Database, _id: ScanRootId, _at?: string): boolean {
  return pendingTask2("touchScanned");
}
export function removeScanRoot(_db: Database.Database, _id: ScanRootId): boolean {
  return pendingTask2("removeScanRoot");
}

export const STORED_LAUNCHER_IDS = ["antigravity", "claude-code", "claude-desktop"] as const;
export type StoredLauncherId = (typeof STORED_LAUNCHER_IDS)[number];
export interface LauncherConfigRecord {
  readonly launcherId: StoredLauncherId;
  readonly config: unknown;
  readonly tested: boolean;
  readonly updatedAt: string;
}
export function saveLauncherConfig(
  _db: Database.Database,
  _launcherId: string,
  _config: unknown,
  _updatedAt?: string,
): LauncherConfigRecord {
  return pendingTask2("saveLauncherConfig");
}
export function getLauncherConfig(
  _db: Database.Database,
  _launcherId: string,
): LauncherConfigRecord | null {
  return pendingTask2("getLauncherConfig");
}
export function listLauncherConfigs(_db: Database.Database): LauncherConfigRecord[] {
  return pendingTask2("listLauncherConfigs");
}
export function markLauncherTested(_db: Database.Database, _launcherId: string): boolean {
  return pendingTask2("markLauncherTested");
}
