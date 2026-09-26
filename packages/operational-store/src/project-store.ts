// RED skeleton (plan 04-01 Task 1): typed exports only, so the failing tests
// fail on their assertions rather than on a missing module.
import type { ProjectId } from "@ccc/domain";
import type Database from "better-sqlite3";

export interface ProjectRecord {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly displayName: string;
  readonly pinned: boolean;
  readonly lastOpenedAt: string | null;
  readonly githubUrlOverride: string | null;
  readonly registeredAt: string;
}

export interface NewProject {
  readonly path: string;
  readonly displayName: string;
  readonly registeredAt?: string;
}

export interface InsertProjectResult {
  readonly created: boolean;
  readonly record: ProjectRecord;
}

function notImplemented(name: string): never {
  throw new Error(
    `${name} is not implemented yet (packages/operational-store/src/project-store.ts)`,
  );
}

export function findProjectByPath(_db: Database.Database, _path: string): ProjectRecord | null {
  return notImplemented("findProjectByPath");
}

export function getProject(_db: Database.Database, _projectId: ProjectId): ProjectRecord | null {
  return notImplemented("getProject");
}

export function listProjects(_db: Database.Database): ProjectRecord[] {
  return notImplemented("listProjects");
}

export function insertProject(_db: Database.Database, _input: NewProject): InsertProjectResult {
  return notImplemented("insertProject");
}
