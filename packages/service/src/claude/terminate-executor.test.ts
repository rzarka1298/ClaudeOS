import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { type CapabilityToken, newRunId, type RunId, type SessionRun } from "@ccc/domain";
import {
  applyMigrations,
  getSessionRun,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import {
  type ClaudePipeline,
  createClaudePipeline,
  type SessionFactsProvider,
} from "./pipeline.js";
import { createProcessFacts, nodeExecFile, type ProcessFacts } from "./process-facts.js";
import {
  createTerminateExecutor,
  DEFAULT_TERMINATE_GRACE_MS,
  type TerminateSignal,
} from "./terminate-executor.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
/** Built from parts so no source line here names the interrupt signal outright. */
const INTERRUPT = ["SIG", "INT"].join("");

const NULL_FACTS: SessionFactsProvider = {
  factsFor: async () => ({
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  }),
};

/**
 * Tests only: the approval engine (Phase 6) is the one issuer of a real
 * token. A local cast here is the sanctioned test pattern (PATTERNS
 * correction 4); backstop rule 9 forbids it in non-test source.
 */
function tokenFor(
  subject: string,
  patch: { operation?: string; expiresAt?: string } = {},
): CapabilityToken<"session.force-terminate"> {
  return {
    proposalId: "proposal-test-1",
    operation: "session.force-terminate",
    subject,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...patch,
  } as unknown as CapabilityToken<"session.force-terminate">;
}

let base: string;
let store: OperationalStore;
let pipeline: ClaudePipeline;
const children: ChildProcess[] = [];
const logger = pino({ level: "silent" });

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
    ...patch,
  };
  upsertSessionRun(store.db, run);
  return run;
}

/** A throwaway node child that ignores the terminate signal; resolves once its handler is installed. */
async function stubbornChild(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("child has no pid");
  return child as ChildProcess & { pid: number };
}

function fakeFacts(options: { alive?: boolean; lstart?: string }): ProcessFacts {
  return {
    isAlive: () => options.alive ?? true,
    readStartTimes: async (pids) =>
      new Map(
        options.lstart === undefined ? [] : pids.map((pid) => [pid, options.lstart as string]),
      ),
    readTty: async () => null,
    readAncestry: async () => [],
  };
}

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  base = realpathSync(mkdtempSync(join(TEST_BASE, "te-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  pipeline = createClaudePipeline({
    db: store.db,
    bus: createEventBus(),
    logger,
    now: () => new Date(),
    mintRunId: newRunId,
    facts: NULL_FACTS,
  });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await pipeline.stop();
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the capability-typed terminate executor on a real child (Task 3 Test 3, SESS-16, D-01, PR-02)", () => {
  it("sends terminate, escalates to kill after the grace period, and cancels only once the pid is gone", async () => {
    const child = await stubbornChild();
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once("exit", (_code, signal) => resolve(signal));
    });
    const processFacts = createProcessFacts({
      execFile: nodeExecFile,
      kill: (pid, signal) => {
        process.kill(pid, signal);
      },
      logger,
    });
    const lstart = (await processFacts.readStartTimes([child.pid])).get(child.pid);
    expect(lstart).toBeDefined();
    const sessionId = randomUUID();
    const run = seedRun({
      pid: child.pid,
      pidStartedAt: lstart as string,
      claudeSessionId: sessionId,
    });

    const signals: TerminateSignal[] = [];
    let stateAfterSessionEnd: SessionRun | null = null;
    let sessionEndApplied: Promise<void> = Promise.resolve();
    const executor = createTerminateExecutor({
      db: store.db,
      pipeline,
      processFacts,
      kill: (pid, signal) => {
        // Tests only ever signal the process they spawned.
        if (pid !== child.pid)
          throw new Error("refusing to signal a process this test did not spawn");
        signals.push(signal);
        process.kill(pid, signal);
        if (signal === "SIGTERM") {
          // SIGTERM runs SessionEnd(other): it must not finalize the Run (PR-02).
          sessionEndApplied = pipeline
            .ingest(
              {
                eventId: randomUUID(),
                observedAt: new Date().toISOString(),
                hook_event_name: "SessionEnd",
                session_id: sessionId,
                reason: "other",
                env: { CLAUDE_PID: String(child.pid) },
              },
              "socket",
            )
            .then(() => {
              stateAfterSessionEnd = getSessionRun(store.db, run.runId);
            });
        }
      },
      graceMs: 300,
      pollMs: 25,
      now: () => new Date(),
      logger,
    });

    const result = await executor.terminate(tokenFor(run.runId), run.runId);
    await sessionEndApplied;

    expect(result).toEqual({ ok: true });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await exited).toBe("SIGKILL");
    expect(stateAfterSessionEnd).toMatchObject({ state: "running" });
    expect((stateAfterSessionEnd as SessionRun | null)?.endObservedAt).not.toBeNull();
    const final = getSessionRun(store.db, run.runId);
    expect(final?.state).toBe("cancelled");
    expect(final?.terminateRequestedAt).not.toBeNull();
    expect(final?.endedAt).not.toBeNull();
    expect(DEFAULT_TERMINATE_GRACE_MS).toBe(10_000);
  });
});

describe("the executor refuses before any signal (Task 3 Test 4, T-05-59)", () => {
  function executorWith(processFacts: ProcessFacts, signals: TerminateSignal[]) {
    return createTerminateExecutor({
      db: store.db,
      pipeline,
      processFacts,
      kill: (_pid, signal) => {
        signals.push(signal);
      },
      graceMs: 50,
      pollMs: 10,
      now: () => new Date(),
      logger,
    });
  }

  it("gives identity-mismatch for a reused pid, and records nothing", async () => {
    const run = seedRun({ pid: 4242, pidStartedAt: "2026-09-30T01:00:00.000Z" });
    const signals: TerminateSignal[] = [];
    const result = await executorWith(
      fakeFacts({ lstart: "2026-09-30T02:00:00.000Z" }),
      signals,
    ).terminate(tokenFor(run.runId), run.runId);
    expect(result).toEqual({ ok: false, reason: "identity-mismatch" });
    expect(signals).toEqual([]);
    expect(getSessionRun(store.db, run.runId)?.terminateRequestedAt).toBeNull();
  });

  it("gives identity-mismatch when the stored start is unknown", async () => {
    const run = seedRun({ pid: 4242, pidStartedAt: null });
    const signals: TerminateSignal[] = [];
    expect(
      await executorWith(fakeFacts({ lstart: "2026-09-30T01:00:00.000Z" }), signals).terminate(
        tokenFor(run.runId),
        run.runId,
      ),
    ).toEqual({ ok: false, reason: "identity-mismatch" });
    expect(signals).toEqual([]);
  });

  it("gives run-not-found for a terminal or unknown Run and process-ended for a dead pid", async () => {
    const signals: TerminateSignal[] = [];
    const ended = seedRun({
      pid: 4242,
      pidStartedAt: "2026-09-30T01:00:00.000Z",
      state: "completed",
      endedAt: new Date().toISOString(),
    });
    const facts = fakeFacts({ lstart: "2026-09-30T01:00:00.000Z" });
    expect(
      await executorWith(facts, signals).terminate(tokenFor(ended.runId), ended.runId),
    ).toEqual({
      ok: false,
      reason: "run-not-found",
    });
    const unknown = newRunId() as RunId;
    expect(await executorWith(facts, signals).terminate(tokenFor(unknown), unknown)).toEqual({
      ok: false,
      reason: "run-not-found",
    });
    const gone = seedRun({ pid: 4242, pidStartedAt: "2026-09-30T01:00:00.000Z" });
    expect(
      await executorWith(fakeFacts({ alive: false }), signals).terminate(
        tokenFor(gone.runId),
        gone.runId,
      ),
    ).toEqual({ ok: false, reason: "process-ended" });
    expect(signals).toEqual([]);
  });
});

describe("the executor checks the capability itself (wave 5 review, ADR-0012)", () => {
  function executorWith(processFacts: ProcessFacts, signals: TerminateSignal[]) {
    return createTerminateExecutor({
      db: store.db,
      pipeline,
      processFacts,
      kill: (_pid, signal) => {
        signals.push(signal);
      },
      graceMs: 20,
      pollMs: 5,
      now: () => new Date("2026-09-30T12:00:00.000Z"),
      logger,
    });
  }
  const LSTART = "2026-09-30T01:00:00.000Z";

  it("refuses a token for another Run, an expired token and a token for another operation", async () => {
    const run = seedRun({ pid: 4242, pidStartedAt: LSTART });
    const other = seedRun({ pid: 4243, pidStartedAt: LSTART });
    const signals: TerminateSignal[] = [];
    const executor = executorWith(fakeFacts({ lstart: LSTART }), signals);
    for (const token of [
      tokenFor(other.runId),
      tokenFor(run.runId, { expiresAt: "2026-09-30T11:59:59.999Z" }),
      tokenFor(run.runId, { expiresAt: "not a time" }),
      tokenFor(run.runId, { operation: "vault.write" }),
    ]) {
      expect(await executor.terminate(token, run.runId)).toEqual({
        ok: false,
        reason: "capability-refused",
      });
    }
    expect(signals).toEqual([]);
    expect(getSessionRun(store.db, run.runId)?.terminateRequestedAt).toBeNull();
  });

  it("re-checks identity after recording the request, immediately before the terminate signal", async () => {
    const run = seedRun({ pid: 4242, pidStartedAt: LSTART });
    let reads = 0;
    const facts: ProcessFacts = {
      ...fakeFacts({}),
      // The Run's process at the first check; another process reusing the pid by the second.
      readStartTimes: async (pids) => {
        reads += 1;
        return new Map(pids.map((pid) => [pid, reads === 1 ? LSTART : "2026-09-30T02:00:00.000Z"]));
      },
    };
    const signals: TerminateSignal[] = [];
    const result = await executorWith(facts, signals).terminate(tokenFor(run.runId), run.runId);
    expect(result).toEqual({ ok: false, reason: "identity-mismatch" });
    expect(signals).toEqual([]);
    // The request is withdrawn: no signal was sent, so nothing may later read as cancelled.
    const after = getSessionRun(store.db, run.runId);
    expect(after?.terminateRequestedAt).toBeNull();
    expect(after?.state).toBe("running");
  });
});

/** Every TypeScript source file (tests included) under the given package source roots. */
function sourcesUnder(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(path);
      } else if (/\.tsx?$/.test(entry.name)) out.push(path);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

describe("no Phase 5 package ever sends the interrupt signal (Task 3 Test 6, PR-01, PR-27, T-05-63)", () => {
  const killWithInterrupt = new RegExp(
    `kill\\s*\\([^)]*${INTERRUPT}|kill\\s*\\([^)]*,\\s*2\\s*\\)`,
  );
  const receiveHandler = new RegExp(`process\\.on\\(\\s*["']${INTERRUPT}["']`);

  it("finds the scanner itself working on planted samples", () => {
    expect(killWithInterrupt.test(`process.kill(pid, "${INTERRUPT}")`)).toBe(true);
    expect(killWithInterrupt.test(`child.kill('${INTERRUPT}')`)).toBe(true);
    // Concatenated so this line itself never reads as a numeric-signal kill.
    expect(killWithInterrupt.test(`process.kill(pid, ${"2"})`)).toBe(true);
    expect(killWithInterrupt.test(`process.on("${INTERRUPT}", shutdown)`)).toBe(false);
  });

  it("no file under service, collectors or plugin source contains a kill naming it", () => {
    const sources = sourcesUnder(
      join(REPO_ROOT, "packages", "service", "src"),
      join(REPO_ROOT, "packages", "collectors", "src"),
      join(REPO_ROOT, "packages", "plugin", "src"),
    );
    expect(sources.length).toBeGreaterThan(50);
    const offenders = sources
      .filter((path) => killWithInterrupt.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO_ROOT, path));
    expect(offenders).toEqual([]);
    // The service's own shutdown receive handler is allowed and still present.
    const main = readFileSync(join(REPO_ROOT, "packages", "service", "src", "main.ts"), "utf8");
    expect(receiveHandler.test(main)).toBe(true);
  });
});

describe("backstop rules 8 and 9 (Task 3 Test 7)", () => {
  it("pass on the tree, reporting all rules clean", () => {
    const out = execFileSync("sh", ["scripts/check-boundaries.sh"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("0 rule(s) violated");
    const script = readFileSync(join(REPO_ROOT, "scripts", "check-boundaries.sh"), "utf8");
    expect(script).toMatch(/Rule 8:/);
    expect(script).toMatch(/Rule 9:/);
    expect(script).toMatch(/packages\/plugin/);
  }, 30_000);

  it("fail on a planted interrupt-signal kill and a non-test token cast, and spare a test-file cast", () => {
    const scratch = realpathSync(mkdtempSync(join(base, "backstop-")));
    mkdirSync(join(scratch, "scripts"));
    mkdirSync(join(scratch, "packages", "service", "src"), { recursive: true });
    mkdirSync(join(scratch, "packages", "plugin", "src"), { recursive: true });
    copyFileSync(
      join(REPO_ROOT, "scripts", "check-boundaries.sh"),
      join(scratch, "scripts", "check-boundaries.sh"),
    );
    writeFileSync(
      join(scratch, "packages", "service", "src", "scratch.ts"),
      `export function stop(pid: number): void {\n  process.kill(pid, "${INTERRUPT}");\n}\n`,
    );
    const castLine = `const token = {} as unknown as ${"Capability"}Token<"session.force-terminate">;\n`;
    writeFileSync(join(scratch, "packages", "plugin", "src", "cast.ts"), castLine);
    writeFileSync(join(scratch, "packages", "plugin", "src", "cast.test.ts"), castLine);
    execFileSync("git", ["init", "-q"], { cwd: scratch, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: scratch, stdio: "ignore" });

    const result = spawnSync("sh", ["scripts/check-boundaries.sh"], {
      cwd: scratch,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BOUNDARY VIOLATION: a file sends the interrupt signal");
    expect(result.stdout).toContain("packages/service/src/scratch.ts:2:");
    expect(result.stdout).toContain("BOUNDARY VIOLATION: a non-test file casts to CapabilityToken");
    expect(result.stdout).toContain("packages/plugin/src/cast.ts:1:");
    expect(result.stdout).not.toContain("cast.test.ts");
    expect(result.stdout).toContain("2 rule(s) violated");
  }, 30_000);
});
