import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId, SessionRun } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { listNonTerminalRuns } from "./run-store.js";
import {
  listRevivableRuns,
  ProjectNotRegisteredError,
  setSessionOverride,
  upsertSessionRun,
} from "./session-store.js";

/**
 * Audit (05-05 truths 3-4): listNonTerminalRuns keeps excluding stale session
 * Runs while listRevivableRuns includes them (SVC-11 recovery stays
 * idempotent), and a refused override writes nothing anywhere, including
 * outside the store's own directory.
 */

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");
const NOW = "2026-09-28T12:00:00.000Z";
const HOURS_AGO = (h: number): string => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

let dir: string;
let db: Database.Database;

function runId(n: number): RunId {
  return `mgz1a2b3c${n.toString(16).padStart(16, "0")}` as RunId;
}

function run(n: number, overrides: Partial<SessionRun> = {}): SessionRun {
  return {
    runId: runId(n),
    revision: 1,
    claudeSessionId: `audit-session-${n}`,
    pid: 5000 + n,
    pidStartedAt: "Mon Sep 28 10:00:00 2026",
    state: "running",
    activity: "working",
    projectId: null,
    name: null,
    model: null,
    effort: null,
    launchSource: "terminal",
    cwd: null,
    worktreeRoot: null,
    permissionMode: null,
    lastError: null,
    claudeVersion: null,
    transcriptPath: null,
    linkKind: null,
    linkedFromRunId: null,
    subagentActiveIds: [],
    subagentLastType: null,
    startedAt: HOURS_AGO(3),
    lastActivityAt: HOURS_AGO(2),
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-session-audit-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("stale session Runs across the two recovery queries (audit, 05-05)", () => {
  it("listNonTerminalRuns excludes a recent stale Run that listRevivableRuns includes", () => {
    upsertSessionRun(db, run(1, { state: "running" }));
    upsertSessionRun(db, run(2, { state: "stale" }));

    const nonTerminal = listNonTerminalRuns(db).map((r) => r.runId);
    const revivable = listRevivableRuns(db, NOW).map((r) => r.runId);

    expect(nonTerminal).toEqual([runId(1)]);
    expect(revivable.sort()).toEqual([runId(1), runId(2)].sort());
  });

  // AUDIT-BUG (05-05 truth 3, MINOR), fixed in wave 2: the truth says
  // "fewer than 24 h since last activity", so exactly 24 h is out.
  it("a stale Run exactly 24 h past its last activity is not revivable", () => {
    upsertSessionRun(db, run(3, { state: "stale", lastActivityAt: HOURS_AGO(24) }));
    expect(listRevivableRuns(db, NOW)).toEqual([]);
  });

  it("a stale Run one millisecond inside the 24 h window is revivable", () => {
    const justInside = new Date(Date.parse(NOW) - 24 * 3_600_000 + 1).toISOString();
    upsertSessionRun(db, run(4, { state: "stale", lastActivityAt: justInside }));
    expect(listRevivableRuns(db, NOW).map((r) => r.runId)).toEqual([runId(4)]);
  });
});

describe("refused override (audit, 05-05)", () => {
  it("throws ProjectNotRegisteredError and leaves the store directory and table untouched", () => {
    const before = readdirSync(dir).sort();
    expect(() => setSessionOverride(db, "audit-session-9", "never-registered", NOW)).toThrow(
      ProjectNotRegisteredError,
    );
    const rows = db.prepare("SELECT COUNT(*) AS n FROM session_overrides").get() as { n: number };
    expect(rows.n).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});
