/** Wave-5 audit (05-14): hostile tty and host-app facts never reach osascript or open. */
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFocusService,
  type FocusExecFile,
  ITERM_FOCUS_SCRIPT,
  TERMINAL_FOCUS_SCRIPT,
} from "./focus.js";
import type { AncestorEntry, ProcessFacts } from "./process-facts.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const PID = 51234;
const LSTART = "2026-09-30T01:02:03.000Z";
const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

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
  base = realpathSync(mkdtempSync(join(TEST_BASE, "foa-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  logLines = [];
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("audit 05-14: hostile process facts never reach an exec argv", () => {
  for (const tty of ["-e", 'ttys001; do shell script "id"', "../ttys001", "ttys1", "??", ""]) {
    it(`a tty of ${JSON.stringify(tty)} spawns nothing`, async () => {
      const run = seedRun();
      const spy = fakeExec({ osascript: { stdout: "focused" } });
      const outcome = await service(facts({ tty }), spy.execFile).focus(run.runId);
      expect(outcome).toEqual({ ok: false, reason: "terminal-unsupported" });
      expect(spy.calls).toEqual([]);
    });
  }

  for (const comm of [
    "relative/Evil.app/Contents/MacOS/evil",
    "/Applications/../tmp/Evil.app/Contents/MacOS/evil",
    "/Applications/Ev\nil.app/Contents/MacOS/evil",
  ]) {
    it(`a host app path ${JSON.stringify(comm)} spawns nothing`, async () => {
      const run = seedRun();
      const spy = fakeExec({ open: { stdout: "" } });
      const outcome = await service(facts({ hostComm: comm }), spy.execFile).focus(run.runId);
      expect(outcome.ok).toBe(false);
      expect(spy.calls).toEqual([]);
    });
  }

  it("the focus script receives no interrupt: only osascript or open is ever executed", async () => {
    const run = seedRun();
    const spy = fakeExec({ osascript: { stdout: "not-found" }, open: { stdout: "" } });
    await service(facts({}), spy.execFile).focus(run.runId);
    expect(spy.calls.map((c) => c.file)).toEqual(["/usr/bin/osascript", "/usr/bin/open"]);
    expect(TERMINAL_FOCUS_SCRIPT).not.toMatch(/keystroke|key code|SIGINT|kill/i);
    expect(ITERM_FOCUS_SCRIPT).not.toMatch(/keystroke|key code|SIGINT|kill|write text/i);
  });
});
