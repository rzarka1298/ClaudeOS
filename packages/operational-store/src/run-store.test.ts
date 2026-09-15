import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId, RunState } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { getRun, InvalidRunStateError, insertRun, listNonTerminalRuns } from "./run-store.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-run-store-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("run-store", () => {
  it("round-trips every field of a Run, including a null endedAt and a null claudeSessionId", () => {
    const runId = "run-1" as RunId;
    insertRun(db, {
      runId,
      kind: "session",
      projectId: null,
      claudeSessionId: null,
      state: "running",
      startedAt: "2026-09-16T00:00:00.000Z",
      lastActivityAt: "2026-09-16T00:01:00.000Z",
      endedAt: null,
    });
    const run = getRun(db, runId);
    expect(run).toEqual({
      runId,
      kind: "session",
      projectId: null,
      claudeSessionId: null,
      state: "running",
      startedAt: "2026-09-16T00:00:00.000Z",
      lastActivityAt: "2026-09-16T00:01:00.000Z",
      endedAt: null,
    });
  });

  it("listNonTerminalRuns returns exactly the four non-terminal states and no terminal one", () => {
    const cases: Array<{ id: string; state: RunState }> = [
      { id: "run-queued", state: "queued" },
      { id: "run-starting", state: "starting" },
      { id: "run-running", state: "running" },
      { id: "run-waiting", state: "waiting-for-approval" },
      { id: "run-completed", state: "completed" },
      { id: "run-failed", state: "failed" },
      { id: "run-cancelled", state: "cancelled" },
      { id: "run-stale", state: "stale" },
    ];
    for (const { id, state } of cases) {
      insertRun(db, {
        runId: id as RunId,
        kind: "automation",
        projectId: null,
        claudeSessionId: null,
        state,
        startedAt: "2026-09-16T00:00:00.000Z",
        lastActivityAt: null,
        endedAt: null,
      });
    }
    const nonTerminal = listNonTerminalRuns(db)
      .map((r) => r.runId)
      .sort();
    expect(nonTerminal).toEqual(
      ["run-queued", "run-running", "run-starting", "run-waiting"].sort(),
    );
  });

  it("rejects a state string outside the eight-member RunState union before it reaches the database", () => {
    expect(() =>
      insertRun(db, {
        runId: "run-invalid" as RunId,
        kind: "session",
        projectId: null,
        claudeSessionId: null,
        state: "bogus-state" as unknown as RunState,
        startedAt: "2026-09-16T00:00:00.000Z",
        lastActivityAt: null,
        endedAt: null,
      }),
    ).toThrow(InvalidRunStateError);
    const row = db.prepare("SELECT COUNT(*) as count FROM runs").get() as { count: number };
    expect(row.count).toBe(0);
  });
});
