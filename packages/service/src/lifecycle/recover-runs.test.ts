import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId, RunState } from "@ccc/domain";
import { applyMigrations, getRun, insertRun } from "@ccc/operational-store";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logging.js";
import { recoverInterruptedRuns } from "./recover-runs.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../../../operational-store/migrations");

let dir: string;
let db: Database.Database;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-recover-runs-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
  logPath = join(dir, "service.log");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(id: string, state: RunState): void {
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

function readLogLines(): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("recoverInterruptedRuns", () => {
  it("moves a Run persisted as running to stale, never completed or failed", () => {
    seedRun("run-running", "running");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-running" as RunId)?.state).toBe("stale");
  });

  it("moves a Run persisted as waiting-for-approval to stale", () => {
    seedRun("run-waiting", "waiting-for-approval");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-waiting" as RunId)?.state).toBe("stale");
  });

  it("leaves a Run persisted as completed, failed, or cancelled exactly as it was", () => {
    seedRun("run-completed", "completed");
    seedRun("run-failed", "failed");
    seedRun("run-cancelled", "cancelled");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-completed" as RunId)?.state).toBe("completed");
    expect(getRun(db, "run-failed" as RunId)?.state).toBe("failed");
    expect(getRun(db, "run-cancelled" as RunId)?.state).toBe("cancelled");
  });

  it("leaves endedAt null on every Run it touches, because it never observed an ending", () => {
    seedRun("run-queued", "queued");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-queued" as RunId)?.endedAt).toBeNull();
  });

  it("is idempotent: running it twice produces the same rows as running it once", () => {
    seedRun("run-starting", "starting");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    const afterFirst = getRun(db, "run-starting" as RunId);
    recoverInterruptedRuns(db, logger);
    const afterSecond = getRun(db, "run-starting" as RunId);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("logs the count of Runs reconciled at info level", () => {
    seedRun("run-a", "running");
    seedRun("run-b", "queued");
    seedRun("run-c", "completed");
    const logger = createLogger(logPath);
    const count = recoverInterruptedRuns(db, logger);
    expect(count).toBe(2);
    const lines = readLogLines();
    const infoLine = lines.find((l) => l.count === 2);
    expect(infoLine).toBeDefined();
    expect(infoLine?.level).toBe(30); // pino info level
  });
});
