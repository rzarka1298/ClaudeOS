import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId, SessionRun } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { findRunByIdentity, getSessionRun, upsertSessionRun } from "./session-store.js";

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
