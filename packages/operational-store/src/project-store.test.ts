import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_PROJECTS_SNAPSHOT,
  ProjectsSnapshotSchema,
  type ProjectView,
  RegisterProjectRequestSchema,
} from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import {
  findProjectByPath,
  insertProject,
  listProjects,
  type ProjectRecord,
} from "./project-store.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

/** Synthetic fixture path only — never a real home directory (Shared Pattern 8). */
const EXAMPLE_PATH = "/Users/USERNAME/code/example-project";
const ID_SHAPE = /^[0-9a-z]{9}[0-9a-f]{16}$/;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-project-store-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The plugin-facing projection the service will build (plan 04-04 owns the
 * real one). The absolute path stays behind; only the home-abbreviated
 * display path crosses (D-43).
 */
function toView(record: ProjectRecord): ProjectView {
  return {
    projectId: record.projectId,
    displayName: record.displayName,
    displayPath: record.path.replace(/^\/Users\/[^/]+/, "~"),
    pinned: record.pinned,
    lastOpenedAt: record.lastOpenedAt,
    observedAt: null,
    gitReadFailed: false,
    git: { kind: "pending" },
    github: { kind: "none" },
  };
}

describe("project-store tracer (D-47 slice 1)", () => {
  it("a registered project row round-trips through the migrated store into the snapshot shape", () => {
    const request = RegisterProjectRequestSchema.parse({ path: EXAMPLE_PATH });
    const { created, record } = insertProject(db, {
      path: request.path,
      displayName: "example-project",
    });
    expect(created).toBe(true);

    const snapshot = {
      projects: listProjects(db).map(toView),
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    const parsed = ProjectsSnapshotSchema.parse(snapshot);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]?.projectId).toBe(record.projectId);
    expect(parsed.projects[0]?.displayPath).toBe("~/code/example-project");
    expect(JSON.stringify(parsed)).not.toContain("/Users/");
  });
});

describe("insertProject", () => {
  it("returns a fresh record with a minted id, unpinned, never opened and no GitHub override", () => {
    const { created, record } = insertProject(db, {
      path: EXAMPLE_PATH,
      displayName: "example-project",
    });
    expect(created).toBe(true);
    expect(record.projectId).toMatch(ID_SHAPE);
    expect(record.path).toBe(EXAMPLE_PATH);
    expect(record.displayName).toBe("example-project");
    expect(record.pinned).toBe(false);
    expect(record.lastOpenedAt).toBeNull();
    expect(record.githubUrlOverride).toBeNull();
    expect(typeof record.registeredAt).toBe("string");
  });

  it("is listed by listProjects and found by findProjectByPath under the same id", () => {
    const { record } = insertProject(db, { path: EXAMPLE_PATH, displayName: "example-project" });
    expect(listProjects(db)).toEqual([record]);
    expect(findProjectByPath(db, EXAMPLE_PATH)?.projectId).toBe(record.projectId);
    expect(findProjectByPath(db, "/Users/USERNAME/code/other-project")).toBeNull();
  });

  it("registering the same path twice returns the existing record and never adds a second row (PROJ-01)", () => {
    const first = insertProject(db, { path: EXAMPLE_PATH, displayName: "example-project" });
    const second = insertProject(db, { path: EXAMPLE_PATH, displayName: "renamed" });
    expect(second.created).toBe(false);
    expect(second.record.projectId).toBe(first.record.projectId);
    expect(second.record.displayName).toBe("example-project");
    expect(listProjects(db)).toHaveLength(1);
  });
});
