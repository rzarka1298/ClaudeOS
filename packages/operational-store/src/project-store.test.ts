import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_PROJECTS_SNAPSHOT,
  LAUNCHER_IDS,
  type ProjectId,
  ProjectsSnapshotSchema,
  type ProjectView,
  RegisterProjectRequestSchema,
  type RunId,
} from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import {
  findProjectByPath,
  findScanRootByPath,
  getLauncherConfig,
  getProject,
  getScanRoot,
  insertProject,
  insertScanRoot,
  listLauncherConfigs,
  listProjects,
  listScanRoots,
  markLauncherTested,
  type ProjectRecord,
  ProjectStoreValidationError,
  removeProject,
  removeScanRoot,
  renameProject,
  STORED_LAUNCHER_IDS,
  saveLauncherConfig,
  setGithubUrlOverride,
  setProjectPinned,
  setScanRootDepth,
  touchLastOpened,
  touchScanned,
} from "./project-store.js";
import { getRun, insertRun } from "./run-store.js";

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

/** Registers a synthetic project and returns its record. */
function register(name: string, path = `/Users/USERNAME/code/${name}`): ProjectRecord {
  return insertProject(db, { path, displayName: name }).record;
}

function orderedNames(): string[] {
  return listProjects(db).map((project) => project.displayName);
}

describe("project order (PROJ-15)", () => {
  it("puts a pinned project first and unpinning restores the last-opened order", () => {
    const alpha = register("alpha");
    const beta = register("beta");
    touchLastOpened(db, alpha.projectId, "2026-09-10T00:00:00.000Z");
    touchLastOpened(db, beta.projectId, "2026-09-01T00:00:00.000Z");
    expect(orderedNames()).toEqual(["alpha", "beta"]);

    expect(setProjectPinned(db, beta.projectId, true)).toBe(true);
    expect(orderedNames()).toEqual(["beta", "alpha"]);
    expect(getProject(db, beta.projectId)?.pinned).toBe(true);

    setProjectPinned(db, beta.projectId, false);
    expect(orderedNames()).toEqual(["alpha", "beta"]);
  });

  it("orders by last opened descending with never-opened projects last", () => {
    const older = register("older");
    register("never");
    const newer = register("newer");
    touchLastOpened(db, older.projectId, "2026-09-01T00:00:00.000Z");
    touchLastOpened(db, newer.projectId, "2026-09-20T00:00:00.000Z");
    expect(orderedNames()).toEqual(["newer", "older", "never"]);
    expect(getProject(db, newer.projectId)?.lastOpenedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("breaks equal keys by display name, case-insensitively", () => {
    register("beta");
    register("Alpha");
    register("gamma");
    expect(orderedNames()).toEqual(["Alpha", "beta", "gamma"]);
  });

  it("touchLastOpened defaults to now and reports an unknown project", () => {
    const alpha = register("alpha");
    expect(touchLastOpened(db, alpha.projectId)).toBe(true);
    expect(getProject(db, alpha.projectId)?.lastOpenedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(touchLastOpened(db, "0000000000fffffffffffffff" as ProjectId)).toBe(false);
  });
});

describe("renameProject (RR-11)", () => {
  it("stores the trimmed name", () => {
    const project = register("example-project");
    expect(renameProject(db, project.projectId, "  demo-api  ")).toBe(true);
    expect(getProject(db, project.projectId)?.displayName).toBe("demo-api");
  });

  it("refuses a 65-character, an empty and a control-character name without echoing it", () => {
    const project = register("example-project");
    const bell = `demo${String.fromCharCode(7)}api`;
    for (const name of ["x".repeat(65), "   ", bell]) {
      let thrown: unknown;
      try {
        renameProject(db, project.projectId, name);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ProjectStoreValidationError);
      expect((thrown as Error).message).not.toContain(name);
      expect((thrown as ProjectStoreValidationError).field).toBe("displayName");
    }
    expect(getProject(db, project.projectId)?.displayName).toBe("example-project");
  });

  it("accepts exactly 64 characters", () => {
    const project = register("example-project");
    expect(renameProject(db, project.projectId, "y".repeat(64))).toBe(true);
  });

  it("insertProject applies the same display-name rule", () => {
    expect(() =>
      insertProject(db, { path: "/Users/USERNAME/code/bad", displayName: "x".repeat(65) }),
    ).toThrow(ProjectStoreValidationError);
  });
});

describe("setGithubUrlOverride (RR-12)", () => {
  it("stores an override and null clears it", () => {
    const project = register("example-project");
    expect(setGithubUrlOverride(db, project.projectId, "https://github.com/owner/repo")).toBe(true);
    expect(getProject(db, project.projectId)?.githubUrlOverride).toBe(
      "https://github.com/owner/repo",
    );
    setGithubUrlOverride(db, project.projectId, null);
    expect(getProject(db, project.projectId)?.githubUrlOverride).toBeNull();
  });

  it("does no URL validation beyond a non-empty string (the route validates with the domain schema)", () => {
    const project = register("example-project");
    expect(setGithubUrlOverride(db, project.projectId, "not a url")).toBe(true);
    expect(() => setGithubUrlOverride(db, project.projectId, "")).toThrow(
      ProjectStoreValidationError,
    );
  });
});

describe("removeProject (D-08)", () => {
  it("deletes the row, keeps the run's history with project_id NULL and leaves the folder on disk", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ccc-project-folder-"));
    try {
      db.pragma("foreign_keys = ON");
      const project = insertProject(db, {
        path: projectDir,
        displayName: "example-project",
      }).record;
      const runId = "run-remove-1" as RunId;
      insertRun(db, {
        runId,
        kind: "session",
        projectId: project.projectId,
        claudeSessionId: null,
        state: "completed",
        startedAt: "2026-09-16T00:00:00.000Z",
        lastActivityAt: null,
        endedAt: "2026-09-16T00:05:00.000Z",
      });

      expect(removeProject(db, project.projectId)).toBe(true);

      expect(getProject(db, project.projectId)).toBeNull();
      const run = getRun(db, runId);
      expect(run?.projectId).toBeNull();
      expect(run?.state).toBe("completed");
      expect(existsSync(projectDir)).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns false for an unknown project", () => {
    expect(removeProject(db, "0000000000fffffffffffffff" as ProjectId)).toBe(false);
  });
});

describe("scan roots (D-02, D-07)", () => {
  const ROOT_PATH = "/Users/USERNAME/code";

  it("insertScanRoot is idempotent by path and lists every field", () => {
    const first = insertScanRoot(db, {
      path: ROOT_PATH,
      depth: 1,
      addedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(first.created).toBe(true);
    expect(first.record.scanRootId).toMatch(ID_SHAPE);
    const second = insertScanRoot(db, { path: ROOT_PATH, depth: 2 });
    expect(second.created).toBe(false);
    expect(second.record.scanRootId).toBe(first.record.scanRootId);
    expect(listScanRoots(db)).toEqual([
      {
        scanRootId: first.record.scanRootId,
        path: ROOT_PATH,
        depth: 1,
        addedAt: "2026-09-01T00:00:00.000Z",
        lastScannedAt: null,
      },
    ]);
    expect(findScanRootByPath(db, ROOT_PATH)?.scanRootId).toBe(first.record.scanRootId);
    expect(getScanRoot(db, first.record.scanRootId)?.path).toBe(ROOT_PATH);
  });

  it("refuses a depth outside 1..3", () => {
    for (const depth of [0, 4, 1.5, -1]) {
      expect(() => insertScanRoot(db, { path: ROOT_PATH, depth }), `depth ${depth}`).toThrow(
        ProjectStoreValidationError,
      );
    }
    const { record } = insertScanRoot(db, { path: ROOT_PATH, depth: 3 });
    expect(() => setScanRootDepth(db, record.scanRootId, 4)).toThrow(ProjectStoreValidationError);
    expect(setScanRootDepth(db, record.scanRootId, 2)).toBe(true);
    expect(getScanRoot(db, record.scanRootId)?.depth).toBe(2);
  });

  it("touchScanned sets lastScannedAt", () => {
    const { record } = insertScanRoot(db, { path: ROOT_PATH, depth: 1 });
    expect(touchScanned(db, record.scanRootId, "2026-09-02T00:00:00.000Z")).toBe(true);
    expect(getScanRoot(db, record.scanRootId)?.lastScannedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("removeScanRoot deletes only the scan_roots row", () => {
    const project = register("example-project");
    const { record } = insertScanRoot(db, { path: ROOT_PATH, depth: 1 });
    expect(removeScanRoot(db, record.scanRootId)).toBe(true);
    expect(listScanRoots(db)).toEqual([]);
    expect(getProject(db, project.projectId)).not.toBeNull();
    expect(removeScanRoot(db, record.scanRootId)).toBe(false);
  });
});

describe("launcher config (D-22, D-46)", () => {
  it("saves and reads back a config untested, and re-saving replaces it and resets tested", () => {
    const saved = saveLauncherConfig(db, "antigravity", { bundleId: "com.example.app" });
    expect(saved.tested).toBe(false);
    expect(getLauncherConfig(db, "antigravity")).toEqual({
      launcherId: "antigravity",
      config: { bundleId: "com.example.app" },
      tested: false,
      updatedAt: saved.updatedAt,
    });

    expect(markLauncherTested(db, "antigravity")).toBe(true);
    expect(getLauncherConfig(db, "antigravity")?.tested).toBe(true);

    saveLauncherConfig(db, "antigravity", { bundleId: "com.example.other" });
    const replaced = getLauncherConfig(db, "antigravity");
    expect(replaced?.config).toEqual({ bundleId: "com.example.other" });
    expect(replaced?.tested).toBe(false);
  });

  it("refuses an unknown launcher id", () => {
    expect(() => saveLauncherConfig(db, "finder", { bundleId: "com.example.app" })).toThrow(
      ProjectStoreValidationError,
    );
    expect(() => getLauncherConfig(db, "finder")).toThrow(ProjectStoreValidationError);
    expect(() => markLauncherTested(db, "finder")).toThrow(ProjectStoreValidationError);
  });

  it("markLauncherTested reports a launcher with no saved config", () => {
    expect(markLauncherTested(db, "claude-desktop")).toBe(false);
    expect(getLauncherConfig(db, "claude-desktop")).toBeNull();
  });

  it("reads a row whose config_json is corrupt as not configured, for that launcher only", () => {
    saveLauncherConfig(db, "claude-desktop", { bundleId: "com.example.desktop" });
    db.prepare(
      "INSERT INTO launcher_config (launcher_id, config_json, tested, updated_at) VALUES ('antigravity', '{not json', 'true', '2026-09-01T00:00:00.000Z')",
    ).run();

    expect(() => getLauncherConfig(db, "antigravity")).not.toThrow();
    expect(getLauncherConfig(db, "antigravity")).toBeNull();
    expect(getLauncherConfig(db, "claude-desktop")?.config).toEqual({
      bundleId: "com.example.desktop",
    });
    expect(listLauncherConfigs(db).map((row) => row.launcherId)).toEqual(["claude-desktop"]);
    // A corrupt row is not a configuration that can be marked tested.
    expect(markLauncherTested(db, "antigravity")).toBe(false);

    // Saving over it repairs the launcher.
    saveLauncherConfig(db, "antigravity", { bundleId: "com.example.app" });
    expect(getLauncherConfig(db, "antigravity")?.config).toEqual({ bundleId: "com.example.app" });
  });

  it("skips a stored row whose launcher id is not a stored launcher", () => {
    db.prepare(
      "INSERT INTO launcher_config (launcher_id, config_json, tested, updated_at) VALUES ('finder', '{}', 'false', '2026-09-01T00:00:00.000Z')",
    ).run();
    expect(listLauncherConfigs(db)).toEqual([]);
  });

  it("lists every saved row", () => {
    saveLauncherConfig(db, "antigravity", { bundleId: "com.example.app" });
    saveLauncherConfig(db, "claude-desktop", { bundleId: "com.example.desktop" });
    expect(
      listLauncherConfigs(db)
        .map((row) => row.launcherId)
        .sort(),
    ).toEqual(["antigravity", "claude-desktop"]);
  });
});

describe("STORED_LAUNCHER_IDS", () => {
  it("equals the domain LAUNCHER_IDS", () => {
    expect([...STORED_LAUNCHER_IDS]).toEqual([...LAUNCHER_IDS]);
    expect([...STORED_LAUNCHER_IDS]).toContain("codex");
  });
});
