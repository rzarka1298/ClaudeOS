import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRef } from "@ccc/domain";
import { formatBridgeRunId, projectDirName } from "@ccc/launchers";
import type { RunRecordFs } from "../codex/run-records.js";

/**
 * Test-only builders for the wrapper's own run records (plan 05.1-26): temporary projects with
 * both candidate state directories, record, pending-resume and live-log writers, every hostile
 * variant, a recording filesystem and a held headless review run driven through the real wrapper
 * with a fake Codex. Everything lives under one fresh temporary directory that `cleanup` removes;
 * the owner's bridge state, project `.planning/codex` directories and Codex home are never touched.
 *
 * Paths in this file are placeholders or runtime temp paths only. The decoys carry obviously fake
 * markers that must never appear in any view, event, log line or response.
 */

export const SESSION_A = "11111111-2222-3333-4444-555555555555";
export const SESSION_B = "66666666-7777-8888-9999-aaaaaaaaaaaa";

/** Planted in keys the allowlisted parse must drop; none may reach any output. */
export const DECOY_WORKTREE = "DECOY-WORKTREE-NAME-NOT-REAL";
export const DECOY_REPORT_TEXT = "DECOY-REPORT-TEXT-NOT-REAL";
export const DECOY_FALLBACK = "DECOY-FALLBACK-REASON-NOT-REAL";
export const DECOY_LOG_CONTENT = "DECOY-LIVE-LOG-CONTENT-NOT-REAL";
export const RUN_DECOYS: readonly string[] = [
  DECOY_WORKTREE,
  DECOY_REPORT_TEXT,
  DECOY_FALLBACK,
  DECOY_LOG_CONTENT,
];

/** The first run id the world mints; later ids are one millisecond apart. */
const BASE_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
let counter = 0;

/** A fresh, strictly increasing wrapper run id (`YYYYMMDDTHHMMSSmmmZ`). */
export function nextRunId(): string {
  counter += 1;
  return formatBridgeRunId(BASE_MS + counter);
}

/** The run id for an explicit instant. */
export function runIdAt(ms: number): string {
  return formatBridgeRunId(ms);
}

export interface WorldProject extends ProjectRef {
  /** `<root>/.planning/codex`: the project-local candidate state directory. */
  readonly localState: string;
  /** `<bridge state>/projects/<name>-<hash>`: the user-level candidate state directory. */
  readonly userState: string;
}

export interface RunWorld {
  /** The realpath of the throwaway directory everything lives in. */
  readonly base: string;
  readonly home: string;
  /** `<home>/.local/state/codex-bridge`. */
  readonly bridgeState: string;
  addProject(name?: string): WorldProject;
  listProjects(): readonly ProjectRef[];
  cleanup(): void;
}

export function createRunWorld(): RunWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-run-world-")));
  const home = join(base, "home");
  const bridgeState = join(home, ".local", "state", "codex-bridge");
  mkdirSync(bridgeState, { recursive: true });
  const projects: WorldProject[] = [];
  return {
    base,
    home,
    bridgeState,
    addProject(name = `project-${projects.length + 1}`) {
      const root = join(base, name);
      mkdirSync(root, { recursive: true });
      const project: WorldProject = {
        projectId: `proj-${name}`,
        name,
        root,
        localState: join(root, ".planning", "codex"),
        userState: join(bridgeState, "projects", projectDirName(root)),
      };
      projects.push(project);
      return project;
    },
    listProjects: () => projects.map(({ projectId, name, root }) => ({ projectId, name, root })),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export interface RunRecordInput {
  readonly runId?: string;
  readonly kind?: string;
  readonly role?: string | null;
  readonly sessionId?: string | null;
  readonly mode?: string | null;
  readonly status?: string;
  readonly resetsAt?: string | null;
  readonly startedAt?: string;
  readonly finishedAt?: string | null;
  /** Keys to leave out entirely (for example `schemaVersion`). */
  readonly omit?: readonly string[];
  /** Extra or overriding raw keys, written as given. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Plants the decoy worktree, fallback and report-text keys. */
  readonly decoys?: boolean;
  /** The mtime to stamp on the file. */
  readonly mtimeMs?: number;
}

export interface WrittenRecord {
  readonly runId: string;
  readonly path: string;
}

/** `<stateDir>/sessions`. */
export function sessionsDir(stateDir: string): string {
  return join(stateDir, "sessions");
}

/** `<stateDir>/live/<runId>-<kind>.log`. */
export function liveLogPath(stateDir: string, runId: string, kind: string): string {
  return join(stateDir, "live", `${runId}-${kind}.log`);
}

function stamp(path: string, mtimeMs: number | undefined): void {
  if (mtimeMs === undefined) return;
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

/** Writes `sessions/<runId>.json` shaped like the wrapper's schemaVersion 1 tracking record. */
export function writeRunRecord(stateDir: string, input: RunRecordInput = {}): WrittenRecord {
  const runId = input.runId ?? nextRunId();
  const startedAtMs = Date.parse(
    `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(9, 11)}:${runId.slice(11, 13)}:${runId.slice(13, 15)}.${runId.slice(15, 18)}Z`,
  );
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    runId,
    kind: input.kind ?? "review",
    role: input.role === undefined ? "review" : input.role,
    sessionId: input.sessionId === undefined ? SESSION_A : input.sessionId,
    worktree: ".",
    model: "gpt-synthetic",
    effort: "high",
    startedAt: input.startedAt ?? new Date(startedAtMs).toISOString(),
    mode: input.mode === undefined ? "headless" : input.mode,
    status: input.status ?? "running",
  };
  if (input.resetsAt !== undefined) record.resetsAt = input.resetsAt;
  if (input.finishedAt !== undefined) record.finishedAt = input.finishedAt;
  if (input.decoys === true) {
    record.worktree = DECOY_WORKTREE;
    record.fallback = { reason: DECOY_FALLBACK };
    record.reportText = DECOY_REPORT_TEXT;
  }
  Object.assign(record, input.extra ?? {});
  for (const key of input.omit ?? []) delete record[key];
  const dir = sessionsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  stamp(path, input.mtimeMs);
  return { runId, path };
}

export interface PendingInput {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly kind?: string;
  readonly role?: string | null;
  readonly resetsAt?: string | null;
  readonly recordedAt?: string;
  readonly omit?: readonly string[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Writes `<stateDir>/pending-resume.json` shaped like the wrapper's schemaVersion 1 record. */
export function writePendingResume(stateDir: string, input: PendingInput = {}): string {
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    sessionId: input.sessionId ?? SESSION_A,
    runId: input.runId ?? nextRunId(),
    kind: input.kind ?? "task",
    role: input.role === undefined ? "task" : input.role,
    worktree: ".",
    resetsAt: input.resetsAt === undefined ? null : input.resetsAt,
    recordedAt: input.recordedAt ?? new Date(BASE_MS).toISOString(),
  };
  Object.assign(record, input.extra ?? {});
  for (const key of input.omit ?? []) delete record[key];
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "pending-resume.json");
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** Writes a live log whose content is a decoy the service must never read. */
export function writeLiveLog(
  stateDir: string,
  runId: string,
  kind: string,
  options: { readonly mtimeMs?: number } = {},
): string {
  const path = liveLogPath(stateDir, runId, kind);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${DECOY_LOG_CONTENT}\n`);
  stamp(path, options.mtimeMs);
  return path;
}

/** Writes `reports/<runId>-<kind>.json` full of decoys: the service must never open it. */
export function writeReportDecoy(stateDir: string, runId: string, kind = "review"): string {
  const dir = join(stateDir, "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}-${kind}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ runId, verdict: "approve", report: { summary: DECOY_REPORT_TEXT } })}\n`,
  );
  return path;
}

/** Writes a raw file into `sessions/` under an arbitrary name (hostile variants). */
export function writeRawSessionFile(stateDir: string, name: string, text: string): string {
  const dir = sessionsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** A symlink named like a record, pointing at `target`. */
export function writeSymlinkRecord(stateDir: string, runId: string, target: string): string {
  const dir = sessionsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  symlinkSync(target, path);
  return path;
}

/** Replaces `<stateDir>/sessions` with a symlink to `target` (a directory outside its root). */
export function symlinkSessionsDir(stateDir: string, target: string): void {
  mkdirSync(stateDir, { recursive: true });
  symlinkSync(target, sessionsDir(stateDir));
}

export interface RecordedRunFsCall {
  readonly op: string;
  readonly path: string;
}

/** Wraps a run-record filesystem and logs every operation with its path argument. */
export function recordingRunFs(inner: RunRecordFs): {
  readonly fs: RunRecordFs;
  readonly calls: RecordedRunFsCall[];
} {
  const calls: RecordedRunFsCall[] = [];
  const fs: RunRecordFs = {
    lstat: (path) => {
      calls.push({ op: "lstat", path });
      return inner.lstat(path);
    },
    realpath: (path) => {
      calls.push({ op: "realpath", path });
      return inner.realpath(path);
    },
    readdir: (path) => {
      calls.push({ op: "readdir", path });
      return inner.readdir(path);
    },
    readFile: (path, maxBytes) => {
      calls.push({ op: "readFile", path });
      return inner.readFile(path, maxBytes);
    },
  };
  return { fs, calls };
}

/** One rollout line carrying the limit-hit fact (a usage-limit error event). */
export function rolloutLimitLine(atMs: number): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: new Date(atMs).toISOString(),
    payload: { type: "error", message: "You hit a usage limit" },
  });
}

// ---------------------------------------------------------------------------
// A held headless review driven through the REAL wrapper with a fake Codex.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const WRAPPER = join(REPO_ROOT, "scripts", "codex", "codex.mjs");

/** The Codex session id the fake announces for every headless run. */
export const WRAPPER_FAKE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

const REVIEW_JSON = JSON.stringify({
  verdict: "approve",
  summary: "Nothing to report.",
  findings: [],
  next_steps: [],
});

/** The usage answer of the fake app-server: plenty of room. */
const USAGE_RESULT = JSON.stringify({
  accountId: "acct-SECRET-ID",
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    planType: "prolite",
    primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1_790_000_000 },
    secondary: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
});

// A trimmed fake `codex`: the usage app-server, the config queries and a headless `exec` that
// announces its session, then waits for a gate file before finishing (so a test can observe the
// running state between "session announced" and "ended").
const FAKE_CODEX = String.raw`
const fs = require("node:fs");
const argv = process.argv.slice(2);
function emit(ev) { process.stdout.write(JSON.stringify(ev) + "\n"); }
function outFile() { const i = argv.indexOf("-o"); return i >= 0 ? argv[i + 1] : null; }
if (argv[0] === "app-server") {
  const mode = process.env.FAKE_CODEX_USAGE || "";
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id === undefined) continue;
      if (msg.method === "initialize") { emit({ id: msg.id, result: { userAgent: "fake" } }); continue; }
      if (msg.method === "account/rateLimits/read") { emit({ id: msg.id, result: JSON.parse(mode) }); continue; }
      emit({ id: msg.id, error: { code: -32601, message: "unknown method " + msg.method } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else if (argv[0] === "exec") {
  const stdinWanted = argv[argv.length - 1] === "-";
  const run = () => {
    emit({ type: "thread.started", thread_id: process.env.FAKE_CODEX_SESSION });
    emit({ type: "turn.started" });
    const finish = () => {
      const finalMsg = process.env.FAKE_CODEX_FINAL || "done";
      emit({ type: "item.completed", item: { id: "i3", type: "agent_message", text: finalMsg } });
      emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
      const o = outFile();
      if (o) fs.writeFileSync(o, finalMsg);
      process.exit(0);
    };
    const gate = process.env.FAKE_CODEX_GATE;
    if (!gate) return finish();
    const timer = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); finish(); } }, 25);
  };
  if (stdinWanted) {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", run);
  } else run();
} else if (argv.at(-3) === "mcp" && argv.at(-2) === "list" && argv.at(-1) === "--json") {
  process.stdout.write("[]");
} else if (argv.at(-2) === "features" && argv.at(-1) === "list") {
  process.stdout.write("hooks  stable  true\nplugins  stable  true\nmemories  stable  false\n");
} else {
  process.stdout.write("fake codex\n");
}
`;

export interface HeldReview {
  /** The temporary repository the wrapper reviewed. */
  readonly repoRoot: string;
  /** `<repoRoot>/.planning/codex`: where the wrapper keeps this repository's run records. */
  readonly stateDir: string;
  readonly home: string;
  /** Resolves with the run's sessions record once it names a Codex session id. */
  waitForSession(timeoutMs?: number): Promise<{ readonly runId: string; readonly path: string }>;
  /** Lets the fake Codex finish and resolves with the wrapper's exit code. */
  release(): Promise<number | null>;
  cleanup(): void;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Runs the REAL `codex.mjs review` headless in a throwaway repository with the fake Codex held
 * after it announces its session. The first run record exists before Codex starts and is updated
 * when the session is announced, exactly as plan 05.1-10 produces them.
 */
export function startHeldReview(): HeldReview {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-held-review-")));
  const repoRoot = join(base, "repo");
  const home = join(base, "home");
  const bin = join(base, "bin");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  };
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "core.fsmonitor", "false");
  writeFileSync(join(repoRoot, ".gitignore"), ".planning/codex/\n");
  writeFileSync(join(repoRoot, "a.txt"), "one\n");
  git("add", "--", ".gitignore", "a.txt");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repoRoot, "a.txt"), "two\n");
  git("commit", "-q", "-am", "change");

  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!${process.execPath}\n${FAKE_CODEX}`);
  chmodSync(fakeCodex, 0o755);
  const gate = join(base, "gate");

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CODEX_BRIDGE_")) delete env[key];
  delete env.XDG_STATE_HOME;
  Object.assign(env, {
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CODEX_BRIDGE_TAB: "0",
    CCC_CODEX_KILL_GRACE_MS: "300",
    FAKE_CODEX_USAGE: USAGE_RESULT,
    FAKE_CODEX_SESSION: WRAPPER_FAKE_SESSION_ID,
    FAKE_CODEX_FINAL: REVIEW_JSON,
    FAKE_CODEX_GATE: gate,
  });
  const child: ChildProcess = spawn(
    process.execPath,
    [WRAPPER, "review", repoRoot, "HEAD~1", "--", "--title", "fixture"],
    { cwd: repoRoot, env, stdio: "ignore" },
  );
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
    child.once("error", () => resolveExit(null));
  });
  const stateDir = join(repoRoot, ".planning", "codex");

  return {
    repoRoot,
    stateDir,
    home,
    async waitForSession(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const dir = sessionsDir(stateDir);
        if (existsSync(dir)) {
          for (const name of readdirSync(dir)) {
            if (!name.endsWith(".json")) continue;
            try {
              const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
                runId?: string;
                sessionId?: string | null;
              };
              if (typeof record.sessionId === "string" && typeof record.runId === "string") {
                return { runId: record.runId, path: join(dir, name) };
              }
            } catch {
              // Mid-write; the next look sees the whole file.
            }
          }
        }
        await sleep(25);
      }
      throw new Error("the held review never announced a session");
    },
    async release() {
      writeFileSync(gate, "go\n");
      return exited;
    },
    cleanup() {
      child.kill("SIGKILL");
      rmSync(base, { recursive: true, force: true });
    },
  };
}
