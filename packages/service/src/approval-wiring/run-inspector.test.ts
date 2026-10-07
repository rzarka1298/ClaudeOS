import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newRunId, type SessionRun } from "@ccc/domain";
import {
  applyMigrations,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunInspector } from "./run-inspector.js";

let base: string;
let store: OperationalStore;

beforeEach(() => {
  const root = join(homedir(), ".ccc-test");
  mkdirSync(root, { recursive: true });
  base = mkdtempSync(join(root, "insp-"));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

function seedRun(patch: Partial<SessionRun>): SessionRun {
  const now = new Date().toISOString();
  const run: SessionRun = {
    runId: newRunId(),
    revision: 1,
    claudeSessionId: randomUUID(),
    pid: null,
    pidStartedAt: null,
    state: "running",
    activity: null,
    projectId: null,
    name: null,
    model: null,
    effort: null,
    launchSource: null,
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
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    promptSeenAt: null,
    ...patch,
  };
  upsertSessionRun(store.db, run);
  return run;
}

interface FakeFacts {
  readonly alive: Set<number>;
  readonly starts: Map<number, string>;
  readonly calls: string[];
  isAlive(pid: number): boolean;
  readStartTimes(pids: readonly number[]): Promise<Map<number, string>>;
}

function fakeFacts(): FakeFacts {
  const alive = new Set<number>();
  const starts = new Map<number, string>();
  const calls: string[] = [];
  return {
    alive,
    starts,
    calls,
    isAlive(pid) {
      calls.push("isAlive");
      return alive.has(pid);
    },
    async readStartTimes(pids) {
      calls.push("readStartTimes");
      const out = new Map<number, string>();
      for (const pid of pids) {
        const start = starts.get(pid);
        if (start !== undefined) out.set(pid, start);
      }
      return out;
    },
  };
}

describe("run inspector: readRun (Task 1, Test 6)", () => {
  it("answers null for a Run that does not exist", () => {
    const inspector = createRunInspector({ db: store.db, processFacts: fakeFacts() });
    expect(inspector.readRun(newRunId())).toBeNull();
  });

  it("reads state, pid, process start and the Run's own name", () => {
    const run = seedRun({
      name: "Refactor the parser",
      pid: 4242,
      pidStartedAt: "2026-10-06T10:00:00.000Z",
      state: "running",
    });
    const inspector = createRunInspector({ db: store.db, processFacts: fakeFacts() });
    expect(inspector.readRun(run.runId)).toEqual({
      runId: run.runId,
      state: "running",
      displayName: "Refactor the parser",
      pid: 4242,
      processStartedAt: "2026-10-06T10:00:00.000Z",
    });
  });

  it("names an unnamed Run by the start of its session id and caps a long name at 120 characters", () => {
    const unnamed = seedRun({
      name: null,
      claudeSessionId: "abcdef12-0000-4000-8000-000000000000",
    });
    const long = seedRun({ name: "x".repeat(400) });
    const inspector = createRunInspector({ db: store.db, processFacts: fakeFacts() });
    expect(inspector.readRun(unnamed.runId)?.displayName).toBe("Session abcdef12");
    expect(inspector.readRun(long.runId)?.displayName).toHaveLength(120);
  });

  it("reports a Run with no process facts as null pid and null start", () => {
    const run = seedRun({ pid: null, pidStartedAt: null });
    const inspector = createRunInspector({ db: store.db, processFacts: fakeFacts() });
    const facts = inspector.readRun(run.runId);
    expect(facts?.pid).toBeNull();
    expect(facts?.processStartedAt).toBeNull();
  });
});

describe("run inspector: processStatus (Task 1, Test 6)", () => {
  const STARTED = "2026-10-06T10:00:00.000Z";

  it("answers gone when the pid is not alive", async () => {
    const facts = fakeFacts();
    const inspector = createRunInspector({ db: store.db, processFacts: facts });
    expect(await inspector.processStatus(4242, STARTED)).toBe("gone");
  });

  it("answers same when the pid is alive with the expected start", async () => {
    const facts = fakeFacts();
    facts.alive.add(4242);
    facts.starts.set(4242, STARTED);
    const inspector = createRunInspector({ db: store.db, processFacts: facts });
    expect(await inspector.processStatus(4242, STARTED)).toBe("same");
  });

  it("answers different when the pid is alive with another start (a reused pid)", async () => {
    const facts = fakeFacts();
    facts.alive.add(4242);
    facts.starts.set(4242, "2026-10-06T11:30:00.000Z");
    const inspector = createRunInspector({ db: store.db, processFacts: facts });
    expect(await inspector.processStatus(4242, STARTED)).toBe("different");
  });

  it("refuses to guess when the pid is alive but its start cannot be read", async () => {
    const facts = fakeFacts();
    facts.alive.add(4242);
    const inspector = createRunInspector({ db: store.db, processFacts: facts });
    await expect(inspector.processStatus(4242, STARTED)).rejects.toThrow();
  });

  it("only reads: it uses the two read-only process facts and never names a signal", async () => {
    const facts = fakeFacts();
    facts.alive.add(4242);
    facts.starts.set(4242, STARTED);
    const inspector = createRunInspector({ db: store.db, processFacts: facts });
    await inspector.processStatus(4242, STARTED);
    expect(new Set(facts.calls)).toEqual(new Set(["isAlive", "readStartTimes"]));
    const source = readFileSync(join(import.meta.dirname, "run-inspector.ts"), "utf8");
    expect(source).not.toMatch(/process\.kill|\.kill\(|\.terminate\(/);
  });
});
