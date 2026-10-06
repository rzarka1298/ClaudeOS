import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newRunId, type SessionRun } from "@ccc/domain";
import {
  applyMigrations,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFocusService,
  FOCUS_TIMEOUT_MS,
  type FocusExecFile,
  ITERM_FOCUS_SCRIPT,
  TERMINAL_FOCUS_SCRIPT,
} from "./focus.js";
import type { AncestorEntry, ProcessFacts } from "./process-facts.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const PID = 51234;
const LSTART = "2026-09-30T01:02:03.000Z";
const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
const ITERM = "/Applications/iTerm.app/Contents/MacOS/iTerm2";
const GHOSTTY = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const CLAUDE_CODE_APP = "/Applications/ClaudeCode.app/Contents/MacOS/claude";

let base: string;
let store: OperationalStore;
let logLines: string[];

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

/** A fake process table for one Claude pid. */
function facts(options: {
  alive?: boolean;
  lstart?: string | null;
  tty?: string | null;
  hostComm?: string | null;
}): ProcessFacts & { readonly ttyReads: number[] } {
  const ttyReads: number[] = [];
  const ancestry: AncestorEntry[] = [
    { pid: PID, ppid: 700, comm: "/Users/USERNAME/.local/bin/claude" },
    { pid: 700, ppid: 600, comm: "-zsh" },
    { pid: 600, ppid: 500, comm: "login" },
  ];
  if (options.hostComm !== null) {
    ancestry.push({ pid: 500, ppid: 1, comm: options.hostComm ?? TERMINAL });
  }
  return {
    ttyReads,
    isAlive: (pid) => pid === PID && (options.alive ?? true),
    readStartTimes: async (pids) => {
      const lstart = options.lstart === undefined ? LSTART : options.lstart;
      return new Map(lstart === null ? [] : pids.filter((p) => p === PID).map((p) => [p, lstart]));
    },
    readTty: async (pid) => {
      ttyReads.push(pid);
      return options.tty === undefined ? "ttys021" : options.tty;
    },
    readAncestry: async () => ancestry,
  };
}

/** A fake execFile answering by binary; `hang` never settles. */
function fakeExec(answer: {
  osascript?: { stdout: string } | { stderr: string } | "hang";
  open?: { stdout: string } | { stderr: string };
}): { calls: ExecCall[]; execFile: FocusExecFile } {
  const calls: ExecCall[] = [];
  const execFile: FocusExecFile = (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    const reply = file === "/usr/bin/osascript" ? answer.osascript : answer.open;
    if (reply === "hang") return new Promise(() => {});
    if (reply !== undefined && "stderr" in reply) {
      return Promise.reject(
        Object.assign(new Error("Command failed"), { code: 1, stderr: reply.stderr }),
      );
    }
    return Promise.resolve({ stdout: reply?.stdout ?? "" });
  };
  return { calls, execFile };
}

function seedRun(patch: Partial<SessionRun> = {}): SessionRun {
  const now = new Date().toISOString();
  const run: SessionRun = {
    runId: newRunId(),
    revision: 1,
    claudeSessionId: randomUUID(),
    pid: PID,
    pidStartedAt: LSTART,
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

function service(processFacts: ProcessFacts, execFile: FocusExecFile) {
  const logger = pino({ level: "info" }, { write: (line: string) => logLines.push(line) });
  return createFocusService({ processFacts, execFile, db: store.db, logger });
}

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  base = realpathSync(mkdtempSync(join(TEST_BASE, "fo-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  logLines = [];
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("focus by tty in Terminal.app (Task 3 Test 1, SESS-12, D-31, T-05-60)", () => {
  it("runs the constant Terminal script with the tty as argv only", async () => {
    const run = seedRun();
    const spy = fakeExec({ osascript: { stdout: "focused\n" } });
    const outcome = await service(facts({}), spy.execFile).focus(run.runId);

    expect(outcome).toEqual({ ok: true, response: { outcome: "focused" } });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.file).toBe("/usr/bin/osascript");
    expect(spy.calls[0]?.args).toEqual(["-e", TERMINAL_FOCUS_SCRIPT, "/dev/ttys021"]);
    expect(spy.calls[0]?.timeout).toBeLessThanOrEqual(FOCUS_TIMEOUT_MS);
    // The tty never enters the script text.
    expect(TERMINAL_FOCUS_SCRIPT).not.toContain("ttys");
    expect(ITERM_FOCUS_SCRIPT).not.toContain("ttys");
    expect(TERMINAL_FOCUS_SCRIPT).toContain("on run argv");
    expect(TERMINAL_FOCUS_SCRIPT).toContain('application id "com.apple.Terminal"');
  });

  it("falls back to bringing Terminal forward when no tab matches", async () => {
    const run = seedRun();
    const spy = fakeExec({ osascript: { stdout: "not-found\n" } });
    const outcome = await service(facts({}), spy.execFile).focus(run.runId);
    expect(outcome).toEqual({
      ok: true,
      response: { outcome: "activated", terminalApp: "Terminal" },
    });
    expect(spy.calls.at(-1)).toMatchObject({
      file: "/usr/bin/open",
      args: ["-a", "/System/Applications/Utilities/Terminal.app"],
    });
  });
});

describe("the other tiers and every specific failure (Task 3 Test 2, PR-06, Pitfall 15)", () => {
  it("uses the iTerm2 script, logged as unverified", async () => {
    const run = seedRun();
    const spy = fakeExec({ osascript: { stdout: "focused" } });
    const outcome = await service(facts({ hostComm: ITERM }), spy.execFile).focus(run.runId);
    expect(outcome).toEqual({ ok: true, response: { outcome: "focused" } });
    expect(spy.calls[0]?.args).toEqual(["-e", ITERM_FOCUS_SCRIPT, "/dev/ttys021"]);
    expect(logLines.join("\n")).toContain('"verified":false');
  });

  it("brings any other .app host forward with open -a on the validated path", async () => {
    const run = seedRun();
    const spy = fakeExec({ open: { stdout: "" } });
    const outcome = await service(facts({ hostComm: GHOSTTY }), spy.execFile).focus(run.runId);
    expect(outcome).toEqual({
      ok: true,
      response: { outcome: "activated", terminalApp: "Ghostty" },
    });
    expect(spy.calls).toEqual([
      {
        file: "/usr/bin/open",
        args: ["-a", "/Applications/Ghostty.app"],
        timeout: expect.any(Number),
      },
    ]);
  });

  it("answers background-session under Claude Code's own supervisor", async () => {
    const run = seedRun();
    const spy = fakeExec({});
    const outcome = await service(facts({ hostComm: CLAUDE_CODE_APP }), spy.execFile).focus(
      run.runId,
    );
    expect(outcome).toEqual({ ok: false, reason: "background-session" });
    expect(spy.calls).toEqual([]);
  });

  it("answers terminal-unsupported with no .app ancestor", async () => {
    const run = seedRun();
    const spy = fakeExec({});
    expect(await service(facts({ hostComm: null }), spy.execFile).focus(run.runId)).toEqual({
      ok: false,
      reason: "terminal-unsupported",
    });
    expect(spy.calls).toEqual([]);
  });

  it("maps osascript error -1743 to automation-denied", async () => {
    const run = seedRun();
    const spy = fakeExec({
      osascript: {
        stderr: "execution error: Not authorized to send Apple events to Terminal. (-1743)",
      },
    });
    expect(await service(facts({}), spy.execFile).focus(run.runId)).toEqual({
      ok: false,
      reason: "automation-denied",
    });
  });

  it.each([["tty5"], ["ttys01"], ["ttys021; rm"], [null]])(
    "answers terminal-unsupported for tty %j without spawning",
    async (tty) => {
      const run = seedRun();
      const spy = fakeExec({ osascript: { stdout: "focused" } });
      expect(await service(facts({ tty }), spy.execFile).focus(run.runId)).toEqual({
        ok: false,
        reason: "terminal-unsupported",
      });
      expect(spy.calls).toEqual([]);
    },
  );

  it("answers process-ended for a dead pid and for a live pid whose lstart differs", async () => {
    const run = seedRun();
    const spy = fakeExec({ osascript: { stdout: "focused" } });
    expect(await service(facts({ alive: false }), spy.execFile).focus(run.runId)).toEqual({
      ok: false,
      reason: "process-ended",
    });
    const reused = facts({ lstart: "2026-09-30T09:09:09.000Z" });
    expect(await service(reused, spy.execFile).focus(run.runId)).toEqual({
      ok: false,
      reason: "process-ended",
    });
    expect(reused.ttyReads).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it("answers process-ended for an ended Run and run-not-found for an unknown one", async () => {
    const ended = seedRun({ state: "completed", endedAt: new Date().toISOString() });
    const spy = fakeExec({});
    expect(await service(facts({}), spy.execFile).focus(ended.runId)).toEqual({
      ok: false,
      reason: "process-ended",
    });
    expect(await service(facts({}), spy.execFile).focus(newRunId())).toEqual({
      ok: false,
      reason: "run-not-found",
    });
  });

  it("answers timeout at 5 s when osascript hangs", async () => {
    vi.useFakeTimers();
    const run = seedRun();
    const spy = fakeExec({ osascript: "hang" });
    let settled: unknown;
    const pending = service(facts({}), spy.execFile)
      .focus(run.runId)
      .then((outcome) => {
        settled = outcome;
      });
    await vi.advanceTimersByTimeAsync(FOCUS_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(FOCUS_TIMEOUT_MS).toBe(5000);
    expect(settled).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("wave 5 review: host app, unverifiable identity and one budget", () => {
  const VSCODE = "/Applications/Visual Studio Code.app";
  const HELPER = `${VSCODE}/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`;

  it("resolves a Frameworks helper to its outermost .app, never the helper bundle", async () => {
    const run = seedRun();
    const spy = fakeExec({ open: { stdout: "" } });
    const outcome = await service(facts({ hostComm: HELPER }), spy.execFile).focus(run.runId);
    expect(outcome).toEqual({
      ok: true,
      response: { outcome: "activated", terminalApp: "Visual Studio Code" },
    });
    expect(spy.calls.map((call) => call.args)).toEqual([["-a", VSCODE]]);
  });

  it("skips the helper for the main app executable further up the ancestry", async () => {
    const run = seedRun();
    const base = facts({ hostComm: HELPER });
    const ancestry = await base.readAncestry(PID);
    const spy = fakeExec({ open: { stdout: "" } });
    const outcome = await service(
      {
        ...base,
        readAncestry: async () => [
          ...ancestry,
          { pid: 400, ppid: 1, comm: `${VSCODE}/Contents/MacOS/Electron` },
        ],
      },
      spy.execFile,
    ).focus(run.runId);
    expect(outcome).toMatchObject({ ok: true, response: { terminalApp: "Visual Studio Code" } });
    expect(spy.calls[0]?.args).toEqual(["-a", VSCODE]);
  });

  it("refuses a Run whose process start was never recorded, spawning nothing", async () => {
    const run = seedRun({ pidStartedAt: null });
    const spy = fakeExec({ osascript: { stdout: "focused\n" } });
    const processFacts = facts({});
    expect(await service(processFacts, spy.execFile).focus(run.runId)).toEqual({
      ok: false,
      reason: "terminal-unsupported",
    });
    expect(spy.calls).toEqual([]);
    expect(processFacts.ttyReads).toEqual([]);
  });

  it("gives each call only the remaining budget, and spawns nothing once it is spent", async () => {
    vi.useFakeTimers();
    const slow = (ms: number) => {
      const base = facts({});
      return {
        ...base,
        readAncestry: async (pid: number) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return base.readAncestry(pid);
        },
      };
    };
    const run = seedRun();
    const late = fakeExec({ osascript: { stdout: "focused\n" } });
    const pending = service(slow(4500), late.execFile).focus(run.runId);
    await vi.advanceTimersByTimeAsync(4500);
    expect(await pending).toEqual({ ok: true, response: { outcome: "focused" } });
    expect(late.calls[0]?.timeout).toBeLessThanOrEqual(500);

    const spent = fakeExec({ osascript: { stdout: "focused\n" } });
    let settled: unknown;
    const timedOut = service(slow(5200), spent.execFile)
      .focus(run.runId)
      .then((outcome) => {
        settled = outcome;
      });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toEqual({ ok: false, reason: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    // The late ancestry answer never reaches an osascript or open call.
    expect(spent.calls).toEqual([]);
  });
});
