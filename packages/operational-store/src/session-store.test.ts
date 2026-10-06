import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId, SessionRun } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { insertRun } from "./run-store.js";
import {
  findLiveRunByPid,
  findRunByIdentity,
  getSessionOverride,
  getSessionRun,
  latestRunByPid,
  latestRunBySession,
  listConflictCandidates,
  listRegisteredProjects,
  listRevivableRuns,
  listSessionRunsForView,
  ProjectNotRegisteredError,
  sessionRunIndex,
  setSessionOverride,
  upsertSessionRun,
} from "./session-store.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

let dir: string;
let db: Database.Database;

/** A RunId in the minted shape (25 lowercase base-36 characters), distinct per `n`. */
function runId(n: number): RunId {
  return `mgz1a2b3c${n.toString(16).padStart(16, "0")}` as RunId;
}

function sessionRun(overrides: Partial<SessionRun> = {}): SessionRun {
  return {
    runId: runId(1),
    revision: 3,
    claudeSessionId: "5f0c9a2e-0000-4000-8000-000000000001",
    pid: 4242,
    pidStartedAt: "Mon Sep 28 10:00:00 2026",
    state: "running",
    activity: "working",
    projectId: null,
    name: "Refactor the parser",
    model: "claude-opus-5-5",
    effort: "high",
    launchSource: "terminal",
    cwd: "/Users/USERNAME/code/example",
    worktreeRoot: "/Users/USERNAME/code/example",
    permissionMode: "default",
    lastError: null,
    claudeVersion: "2.1.214",
    transcriptPath: "/Users/USERNAME/.claude/projects/example/5f0c9a2e.jsonl",
    linkKind: "resume",
    linkedFromRunId: runId(99),
    subagentActiveIds: ["agent-a", "agent-b"],
    subagentLastType: "general-purpose",
    startedAt: "2026-09-28T10:00:00.000Z",
    lastActivityAt: "2026-09-28T10:05:00.000Z",
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    promptSeenAt: null,
    ...overrides,
  };
}

function runCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-session-store-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("session Run persistence (Test 4, SESS-07, D-21)", () => {
  it("an upserted session Run reads back deep-equal, pid identity and links included", () => {
    const run = sessionRun();
    upsertSessionRun(db, run);
    expect(getSessionRun(db, run.runId)).toEqual(run);
  });

  it("an upsert of an existing RunId updates it in place and keeps one row", () => {
    upsertSessionRun(db, sessionRun());
    const updated = sessionRun({
      revision: 4,
      state: "completed",
      activity: "idle",
      subagentActiveIds: [],
      endedAt: "2026-09-28T10:30:00.000Z",
      endObservedAt: "2026-09-28T10:30:00.000Z",
      promptSeenAt: null,
    });
    upsertSessionRun(db, updated);
    expect(runCount()).toBe(1);
    expect(getSessionRun(db, updated.runId)).toEqual(updated);
  });

  it("findRunByIdentity finds the Run by (claude session id, pid)", () => {
    const run = sessionRun();
    upsertSessionRun(db, run);
    expect(findRunByIdentity(db, run.claudeSessionId ?? "", 4242)).toEqual(run);
    expect(findRunByIdentity(db, run.claudeSessionId ?? "", 9999)).toBeNull();
  });

  it("the same claude session id under another pid is a second row", () => {
    const first = sessionRun();
    const second = sessionRun({ runId: runId(2), pid: 5151, linkedFromRunId: first.runId });
    upsertSessionRun(db, first);
    upsertSessionRun(db, second);
    expect(runCount()).toBe(2);
    expect(findRunByIdentity(db, first.claudeSessionId ?? "", 4242)?.runId).toBe(first.runId);
    expect(findRunByIdentity(db, first.claudeSessionId ?? "", 5151)?.runId).toBe(second.runId);
  });

  it("finds a PID-less Run by its session with a null pid", () => {
    const run = sessionRun({ pid: null, pidStartedAt: null });
    upsertSessionRun(db, run);
    expect(findRunByIdentity(db, run.claudeSessionId ?? "", null)).toEqual(run);
  });

  it("refuses an invalid state before the statement runs, writing nothing", () => {
    expect(() =>
      upsertSessionRun(db, sessionRun({ state: "finished" as SessionRun["state"] })),
    ).toThrow();
    expect(runCount()).toBe(0);
  });

  it("stores the Run with kind session", () => {
    upsertSessionRun(db, sessionRun());
    const row = db.prepare("SELECT kind FROM runs").get() as { kind: string };
    expect(row.kind).toBe("session");
  });
});

const NOW = "2026-09-28T12:00:00.000Z";
const HOURS_AGO = (hours: number): string =>
  new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

/** Seeds a session Run numbered `n` with its own session ID unless overridden. */
function seed(n: number, overrides: Partial<SessionRun> = {}): SessionRun {
  const run = sessionRun({
    runId: runId(n),
    claudeSessionId: `session-${n}`,
    pid: 1000 + n,
    linkKind: null,
    linkedFromRunId: null,
    ...overrides,
  });
  upsertSessionRun(db, run);
  return run;
}

function seedAutomationRun(n: number): void {
  insertRun(db, {
    runId: runId(n),
    kind: "automation",
    projectId: null,
    claudeSessionId: null,
    state: "running",
    startedAt: HOURS_AGO(1),
    lastActivityAt: HOURS_AGO(1),
    endedAt: null,
  });
}

function seedProject(projectId: string, path: string, displayName: string): void {
  db.prepare(
    "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
  ).run(projectId, path, displayName, "2026-09-01T00:00:00.000Z");
}

function ids(runs: readonly SessionRun[]): string[] {
  return runs.map((run) => run.runId).sort();
}

describe("listRevivableRuns (Test 1, PR-12, D-22)", () => {
  it("returns non-terminal Runs and recent stale Runs with a pid and no end time", () => {
    seed(1, { state: "running" });
    seed(2, { state: "starting" });
    seed(3, { state: "waiting-for-approval" });
    seed(4, { state: "queued", pid: null, pidStartedAt: null });
    seed(5, { state: "stale", lastActivityAt: HOURS_AGO(2), endedAt: null });
    seed(6, { state: "stale", pid: null, pidStartedAt: null, lastActivityAt: HOURS_AGO(2) });
    seed(7, { state: "stale", lastActivityAt: HOURS_AGO(25) });
    seed(8, { state: "stale", lastActivityAt: HOURS_AGO(2), endedAt: HOURS_AGO(1) });
    seed(9, { state: "completed", endedAt: HOURS_AGO(1) });
    seedAutomationRun(10);

    expect(ids(listRevivableRuns(db, NOW))).toEqual([1, 2, 3, 4, 5].map(runId).sort());
  });

  it("falls back to the start time for a stale Run that never reported activity", () => {
    seed(1, { state: "stale", startedAt: HOURS_AGO(3), lastActivityAt: null });
    seed(2, { state: "stale", startedAt: HOURS_AGO(30), lastActivityAt: null });
    expect(listRevivableRuns(db, NOW).map((run) => run.runId)).toEqual([runId(1)]);
  });
});

describe("listSessionRunsForView (Test 2, R-07, R-08)", () => {
  it("returns every non-terminal Run plus terminal Runs ended on or after endedSince, never automation Runs", () => {
    const since = HOURS_AGO(24 * 7);
    seed(1, { state: "running" });
    seed(2, { state: "stale" });
    seed(3, { state: "completed", endedAt: HOURS_AGO(24 * 3) });
    seed(4, { state: "completed", endedAt: HOURS_AGO(24 * 8) });
    seed(5, { state: "failed", endedAt: since });
    seed(6, { state: "cancelled", endedAt: null });
    seedAutomationRun(7);

    expect(ids(listSessionRunsForView(db, { endedSince: since }))).toEqual(
      [runId(1), runId(2), runId(3), runId(5)].sort(),
    );
  });
});

describe("listConflictCandidates (Test 3, D-27)", () => {
  it("returns write-capable queued, active or stale Runs, including unattributed working trees", () => {
    seed(1, { state: "running", permissionMode: "default" });
    seed(2, { state: "running", permissionMode: "plan" });
    seed(3, { state: "running", permissionMode: null });
    seed(4, { state: "stale", permissionMode: "acceptEdits" });
    seed(5, { state: "starting", permissionMode: "default" });
    seed(6, { state: "waiting-for-approval", permissionMode: "default" });
    seed(7, { state: "queued", permissionMode: "default" });
    seed(8, { state: "completed", permissionMode: "default", endedAt: HOURS_AGO(1) });
    seed(9, { state: "running", permissionMode: "default", worktreeRoot: null });

    expect(ids(listConflictCandidates(db))).toEqual(
      [runId(1), runId(3), runId(4), runId(5), runId(6), runId(7), runId(9)].sort(),
    );
  });
});

describe("session overrides (Test 4, SESS-17, D-24)", () => {
  it("upserts an override by claude session id and reads back the project id", () => {
    seedProject("project-a", "/Users/USERNAME/code/a", "Project A");
    seedProject("project-b", "/Users/USERNAME/code/b", "Project B");

    setSessionOverride(db, "session-1", "project-a", NOW);
    expect(getSessionOverride(db, "session-1")).toBe("project-a");

    setSessionOverride(db, "session-1", "project-b", NOW);
    expect(getSessionOverride(db, "session-1")).toBe("project-b");
    expect(getSessionOverride(db, "session-unknown")).toBeNull();
  });

  it("refuses an unregistered project id and writes nothing", () => {
    expect(() => setSessionOverride(db, "session-1", "project-missing", NOW)).toThrow(
      ProjectNotRegisteredError,
    );
    expect(getSessionOverride(db, "session-1")).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS n FROM session_overrides").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("listRegisteredProjects (Test 5, D-57)", () => {
  it("returns projectId, root and name from existing projects rows", () => {
    seedProject("project-b", "/Users/USERNAME/code/b", "Beta");
    seedProject("project-a", "/Users/USERNAME/code/a", "Alpha");

    expect(listRegisteredProjects(db)).toEqual([
      { projectId: "project-a", root: "/Users/USERNAME/code/a", name: "Alpha" },
      { projectId: "project-b", root: "/Users/USERNAME/code/b", name: "Beta" },
    ]);
  });

  it("leaves every projects row exactly as it was after the session store's writes", () => {
    seedProject("project-a", "/Users/USERNAME/code/a", "Alpha");
    const before = db.prepare("SELECT * FROM projects").all();
    seed(1, { projectId: "project-a" });
    setSessionOverride(db, "session-1", "project-a", NOW);
    listRegisteredProjects(db);
    expect(db.prepare("SELECT * FROM projects").all()).toEqual(before);
  });

  it("session-store.ts contains no INSERT, UPDATE or DELETE statement naming the projects table", () => {
    const source = readFileSync(join(import.meta.dirname, "session-store.ts"), "utf8");
    const table = "[`\"']?projects[`\"']?\\b";
    const writes = [
      new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}`, "i"),
      new RegExp(`\\bREPLACE\\s+INTO\\s+${table}`, "i"),
      new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?${table}`, "i"),
      new RegExp(`\\bDELETE\\s+FROM\\s+${table}`, "i"),
    ];
    // The patterns must be able to fire, or the scan proves nothing.
    expect(writes.some((pattern) => pattern.test("INSERT OR REPLACE INTO projects (a)"))).toBe(
      true,
    );
    expect(writes.some((pattern) => pattern.test("UPDATE `projects` SET a = 1"))).toBe(true);
    expect(writes.some((pattern) => pattern.test("DELETE FROM projects"))).toBe(true);
    for (const pattern of writes) {
      expect(source).not.toMatch(pattern);
    }
  });
});

describe("identity lookups and the RunIndex accessors (Test 6, D-21)", () => {
  it("latestRunBySession returns the most recently started Run of that session", () => {
    seed(1, { claudeSessionId: "shared", pid: 700, startedAt: HOURS_AGO(5) });
    seed(2, { claudeSessionId: "shared", pid: 701, startedAt: HOURS_AGO(1) });
    seed(3, { claudeSessionId: "other", pid: 702, startedAt: HOURS_AGO(0.5) });
    expect(latestRunBySession(db, "shared")?.runId).toBe(runId(2));
    expect(latestRunBySession(db, "absent")).toBeNull();
  });

  it("findLiveRunByPid returns the latest non-terminal Run on that pid; latestRunByPid ignores state", () => {
    seed(1, { pid: 700, state: "running", startedAt: HOURS_AGO(3) });
    seed(2, {
      pid: 700,
      state: "completed",
      startedAt: HOURS_AGO(1),
      endedAt: HOURS_AGO(0.5),
    });
    seed(3, { pid: 800, state: "completed", startedAt: HOURS_AGO(2), endedAt: HOURS_AGO(1) });
    seed(4, { pid: 900, state: "stale", startedAt: HOURS_AGO(2) });

    expect(findLiveRunByPid(db, 700)?.runId).toBe(runId(1));
    expect(findLiveRunByPid(db, 800)).toBeNull();
    expect(findLiveRunByPid(db, 900)?.runId).toBe(runId(4));
    expect(latestRunByPid(db, 700)?.runId).toBe(runId(2));
    expect(latestRunByPid(db, 800)?.runId).toBe(runId(3));
    expect(latestRunByPid(db, 999)).toBeNull();
  });

  it("sessionRunIndex answers all five RunIndex accessors from the store", () => {
    const first = seed(1, { claudeSessionId: "shared", pid: 700, startedAt: HOURS_AGO(3) });
    const second = seed(2, {
      claudeSessionId: "shared",
      pid: 701,
      state: "completed",
      startedAt: HOURS_AGO(1),
      endedAt: HOURS_AGO(0.5),
    });
    const index = sessionRunIndex(db);
    expect(index.byRunId(first.runId)).toEqual(first);
    expect(index.byIdentity("shared", 700)).toEqual(first);
    expect(index.latestBySession("shared")).toEqual(second);
    expect(index.liveByPid(700)).toEqual(first);
    expect(index.liveByPid(701)).toBeNull();
    expect(index.latestByPid(701)).toEqual(second);
  });
});
