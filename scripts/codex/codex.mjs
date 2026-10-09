#!/usr/bin/env node
// The only sanctioned way agents reach OpenAI Codex CLI, in this repository and
// (installed as `codex-bridge` by scripts/codex/install-user-kit.mjs) in any other.
//
//   codex.mjs usage
//   codex.mjs guard
//   codex.mjs review <worktree> <base-ref> [--timeout-sec N] [-- <extra>]
//   codex.mjs task <worktree> <brief-file> [--role task|chore|plan]
//                                    [--timeout-sec N] [-- <extra>]
//   codex.mjs resume <session-id> [--timeout-sec N] [-- <extra>]   (from inside the project)
//   codex.mjs watch [--once] [--idle-exit-sec N]                   (from inside the project)
//   codex.mjs follow <run-id>        (run by the Antigravity tab; see below)
//
// Why a wrapper: a blanket `Bash(codex:*)` allow let an agent launder the
// git-push deny through `--dangerously-bypass-approvals-and-sandbox` or
// `-s danger-full-access`. This script pins the sandbox and approval policy,
// never passes a bypass flag, and refuses caller-supplied extras that would
// loosen either. Extras are allowlisted, not denylisted.
//
// Usage is read through `codex app-server` JSON-RPC `account/rateLimits/read`
// (costs no model usage). The Codex auth file is never opened and the account
// id in the response is discarded. Dispatch is refused at >= 80 % of any
// window (the owner's 20 % reserve), when ordinary usage is not allowed, and
// when usage is unavailable — unavailable is never treated as 0 %.
//
// The project is the MAIN checkout of the target worktree (review/task) or of
// the current directory (resume/watch). Its runtime state lives in
// <main>/.planning/codex/ when git ignores that path there (this repository),
// and otherwise in <bridge state>/projects/<name>-<hash>/ (bridge state =
// $XDG_STATE_HOME/codex-bridge or ~/.local/state/codex-bridge), so no project
// is ever dirtied by a run:
//   reports/<run>-review.json|md   review results (advisory until Phase 6)
//   reports/<run>-<role>.json      worker final reports
//   sessions/<run>.json            session id per task run (for resume)
//   pending-resume.json            set on a mid-run usage-limit hit
//   live/<run>-<kind>.log|jsonl    readable + raw event stream; live/current.log
//                                  is a symlink to the newest run
//
// Antigravity tab (codex-bridge): when Codex announces the session, the
// wrapper queues <bridge state>/requests/<run>.json; the Codex Bridge extension
// in the Antigravity IDE window that has the project open claims it and opens
// a terminal running `codex-bridge follow <run>` (live log, then `codex resume
// <session>`). If no window has the project open, `antigravity-ide <project>`
// opens one. CODEX_BRIDGE_TAB=0 turns this off; without Antigravity it is a
// no-op, and it never fails a run.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = join(HERE, "schemas");
const bridge = createRequire(import.meta.url)("./antigravity-extension/bridge-core.js");
// How the owner invokes this script: `codex-bridge` once installed user-level.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: set by the installed launcher
const SELF = process.env.CODEX_BRIDGE_CMD || "node scripts/codex/codex.mjs";
// Resolved from PATH (the standalone installer's ~/.local/bin/codex); tests put a fake first.
const CODEX = "codex";

export const EXIT = {
  OK: 0,
  USAGE: 2,
  REFUSED: 3,
  DIRTY: 4,
  RESERVE: 10,
  NOT_ALLOWED: 11,
  UNAVAILABLE: 12,
  PENDING_RESUME: 13,
  LIMIT_HIT: 20,
  TIMEOUT: 21,
  CODEX_FAILED: 22,
};

const RESERVE_PERCENT = 80;

// Model IDs verified against `codex debug models` on CLI 0.159.2 (2026-09-29).
const ROLES = {
  review: { model: "gpt-6.1-sol", effort: "high", sandbox: "read-only" },
  plan: { model: "gpt-6.1-sol", effort: "high", sandbox: "read-only" },
  task: { model: "gpt-6.1-sol", effort: "medium", sandbox: "workspace-write" },
  chore: { model: "gpt-6-luna", effort: "low", sandbox: "workspace-write" },
};

const DEFAULT_TIMEOUT_SEC = { review: 15 * 60, task: 30 * 60, resume: 30 * 60 };
// Test knobs only; never read by turbo tasks, so not declared in turbo.json.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only tuning knob
const KILL_GRACE_MS = Number(process.env.CCC_CODEX_KILL_GRACE_MS) || 10_000;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only tuning knob
const USAGE_TIMEOUT_MS = Number(process.env.CCC_CODEX_USAGE_TIMEOUT_MS) || 20_000;

// Settings every run pins, in addition to the sandbox. Network stays off in
// workspace-write, so nothing Codex runs can push or fetch.
const PINNED_CONFIG = [
  "-c",
  'approval_policy="never"',
  "-c",
  "sandbox_workspace_write.network_access=false",
  "-c",
  'shell_environment_policy.inherit="core"',
  "--ignore-user-config",
];

// ---------------------------------------------------------------------------
// output helpers

function say(msg) {
  process.stderr.write(`codex-wrapper: ${msg}\n`);
}

function fail(code, msg) {
  say(msg);
  process.exit(code);
}

function printResult(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const USAGE_TEXT = `usage:
  codex.mjs usage
  codex.mjs guard
  codex.mjs review <worktree> <base-ref> [--timeout-sec N] [-- <extra codex args>]
  codex.mjs task <worktree> <brief-file> [--role task|chore|plan] [--allow-dirty]
                                         [--timeout-sec N] [-- <extra>]
  codex.mjs resume <session-id> [--timeout-sec N] [-- <extra>]
  codex.mjs watch [--once] [--idle-exit-sec N]
  codex.mjs follow <run-id>
  codex.mjs tui <run-id>`;

// ---------------------------------------------------------------------------
// argument parsing

function parseArgs(argv) {
  const dd = argv.indexOf("--");
  const head = dd < 0 ? argv : argv.slice(0, dd);
  const extras = dd < 0 ? [] : argv.slice(dd + 1);
  const positional = [];
  const opts = {};
  const valued = {
    "--role": "role",
    "--timeout-sec": "timeoutSec",
    "--idle-exit-sec": "idleExitSec",
  };
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--once") opts.once = true;
    else if (a === "--allow-dirty") opts.allowDirty = true;
    else if (a in valued) {
      if (i + 1 >= head.length) fail(EXIT.USAGE, `${a} needs a value\n${USAGE_TEXT}`);
      opts[valued[a]] = head[++i];
    } else if (a.startsWith("-")) {
      fail(EXIT.USAGE, `unknown option ${a} (codex flags go after --)\n${USAGE_TEXT}`);
    } else positional.push(a);
  }
  return { positional, opts, extras };
}

function positiveSeconds(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(EXIT.USAGE, `${name} must be a positive number`);
  return n;
}

// ---------------------------------------------------------------------------
// hard refusals

// Never passed by this wrapper, and refused anywhere in caller extras.
const BANNED = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--full-auto",
  "--approve-for-me",
  "danger-full-access",
];

// Extras a caller may add. Everything else is refused: the wrapper owns the
// sandbox, approval policy, working root, model, profile and persistence.
const ALLOWED_EXTRA_FLAGS = {
  "--title": { value: true, kinds: ["review"] },
  "-i": { value: true, kinds: ["task"] },
  "--image": { value: true, kinds: ["task"] },
};
const ALLOWED_CONFIG_KEYS = new Set([
  "model_reasoning_summary",
  "model_verbosity",
  "hide_agent_reasoning",
]);

export function refusalReason(extras, kind) {
  for (const token of extras) {
    for (const bad of BANNED) {
      if (token.toLowerCase().includes(bad)) return `${bad} is a sandbox/approval bypass`;
    }
    if (/network_access/i.test(token)) return "network access overrides are not allowed";
  }
  for (let i = 0; i < extras.length; i++) {
    const a = extras[i];
    let configPair = null;
    if (a === "-c" || a === "--config") configPair = extras[++i] ?? "";
    else if (a.startsWith("--config=")) configPair = a.slice("--config=".length);
    else if (a.startsWith("-c") && a.length > 2 && !a.startsWith("--")) configPair = a.slice(2);
    if (configPair !== null) {
      const key = configPair.split("=")[0].trim();
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        return `config override "${key}" is not allowed (the wrapper pins sandbox, approval and model settings)`;
      }
      continue;
    }
    const flag = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const rule = ALLOWED_EXTRA_FLAGS[flag];
    if (!rule) return `extra argument "${flag}" is not allowed`;
    if (!rule.kinds.includes(kind)) return `extra argument "${flag}" is not allowed for ${kind}`;
    if (rule.value && !a.includes("=")) i++;
  }
  return null;
}

function enforceExtras(extras, kind) {
  const reason = refusalReason(extras, kind);
  if (reason) fail(EXIT.REFUSED, `refused: ${reason}. Nothing was sent to Codex.`);
}

// ---------------------------------------------------------------------------
// git + paths

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The main checkout (not a linked worktree) of the repository holding `dir`.
// The main checkout of the repository holding `dir`. Never derived from the
// git dir's location alone: that is wrong for --separate-git-dir checkouts and
// absorbed submodules. From inside the main worktree it is simply the
// toplevel; from a linked worktree, each candidate is accepted only if Git
// confirms it is the working tree that owns the common git dir.
function mainCheckoutOf(dir) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const gitDir = git(dir, "rev-parse", "--path-format=absolute", "--git-dir");
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!gitDir || !common || !top) return null;
  const commonReal = real(common);
  if (real(gitDir) === commonReal) return real(top);
  const candidates = [];
  const list = git(dir, "worktree", "list", "--porcelain");
  const first = list?.split("\n")[0];
  if (first?.startsWith("worktree ")) candidates.push(first.slice("worktree ".length));
  const coreWt = spawnSync("git", ["--git-dir", common, "config", "--get", "core.worktree"], {
    encoding: "utf8",
  });
  if (coreWt.status === 0 && coreWt.stdout.trim())
    candidates.push(resolvePath(common, coreWt.stdout.trim()));
  candidates.push(dirname(common));
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const cGit = git(c, "rev-parse", "--path-format=absolute", "--git-dir");
    const cTop = git(c, "rev-parse", "--show-toplevel");
    if (cGit && cTop && real(cGit) === commonReal) return real(cTop);
  }
  return null;
}

const BRIDGE_STATE = bridge.bridgeStateDir(process.env, homedir());

// In-repo state only where git ignores it, so a run never dirties a checkout.
// Every kind of file a run writes under <main>/.planning/codex/.
const STATE_PROBES = [
  "reports/x-review.json",
  "reports/x-review.md",
  "reports/x-task.json",
  "sessions/x.json",
  "live/x-task.log",
  "live/x-task.jsonl",
  "live/current.log",
  "live/.current.1.tmp",
  "pending-resume.json",
  "x.json.1.tmp",
].map((p) => `.planning/codex/${p}`);

export function stateDirFor(main) {
  const r = spawnSync("git", ["-C", main, "check-ignore", "--", ...STATE_PROBES], {
    encoding: "utf8",
  });
  const ignored = new Set((r.stdout ?? "").split("\n").filter(Boolean));
  if (STATE_PROBES.every((p) => ignored.has(p))) return join(main, ".planning", "codex");
  const name =
    basename(main)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 40) || "project";
  const hash = createHash("sha256").update(main).digest("hex").slice(0, 10);
  return join(BRIDGE_STATE, "projects", `${name}-${hash}`);
}

let MAIN = null;
let STATE = null;
let REPORTS = null;
let SESSIONS = null;
let LIVE = null;
let PENDING = null;

function useProject(main) {
  MAIN = main;
  STATE = stateDirFor(main);
  REPORTS = join(STATE, "reports");
  SESSIONS = join(STATE, "sessions");
  LIVE = join(STATE, "live");
  PENDING = join(STATE, "pending-resume.json");
}

function useCwdProject() {
  const main = mainCheckoutOf(process.cwd());
  if (!main) fail(EXIT.USAGE, "run this from inside the project's git checkout");
  useProject(main);
}

function rel(p) {
  const r = relative(MAIN, p);
  return r === "" ? "." : r.startsWith("..") || isAbsolute(r) ? p : r;
}

// Accepts the root of any git worktree; its main checkout becomes the project.
function validateWorktree(dir) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(EXIT.USAGE, `worktree ${dir} is not a directory`);
  }
  const top = git(dir, "rev-parse", "--show-toplevel");
  const main = mainCheckoutOf(dir);
  if (!top || !main) fail(EXIT.USAGE, `${dir} is not a git worktree`);
  const topReal = realpathSync(top);
  if (realpathSync(dir) !== topReal) fail(EXIT.USAGE, `${dir} is not the root of its worktree`);
  if (MAIN && main !== MAIN) fail(EXIT.USAGE, `${dir} is not a worktree of ${MAIN}`);
  if (!MAIN) useProject(main);
  return topReal;
}

// Codex sends what it reads to OpenAI, and `exec review --base` diffs against
// the working tree. A checkout with uncommitted or untracked (non-ignored)
// files is refused, so local-only files never leave the machine by accident.
function refuseIfDirty(worktree) {
  const r = spawnSync(
    "git",
    ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) fail(EXIT.DIRTY, `refused: could not read git status of ${worktree}`);
  const paths = r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3));
  if (!paths.length) return;
  const shown = paths.slice(0, 20).map((p) => `  ${p}`);
  if (paths.length > 20) shown.push(`  … and ${paths.length - 20} more`);
  fail(
    EXIT.DIRTY,
    `refused: ${rel(worktree)} has uncommitted or untracked changes; commit, stash or gitignore them first:\n${shown.join("\n")}`,
  );
}

function runId() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// usage

function readRateLimits() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CODEX, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), USAGE_TIMEOUT_MS);
    const send = (msg) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        finish(null);
      }
    };
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return finish(null);
          send({ method: "initialized" });
          // Read-only call. account/rateLimitResetCredit/consume is never sent.
          send({
            id: 2,
            method: "account/rateLimits/read",
            params: { excludeResetCreditDetails: true, supportsLunaReserve: false },
          });
        } else if (msg.id === 2) {
          finish(msg.error ? null : (msg.result ?? null));
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "ccc_codex_wrapper", title: null, version: "1.0.0" } },
    });
  });
}

function iso(epochSeconds) {
  return typeof epochSeconds === "number" ? new Date(epochSeconds * 1000).toISOString() : null;
}

// Reduces the RPC result to what the guard needs. accountId and every other
// field are dropped here and never leave this function.
export function summarizeUsage(result) {
  const unavailable = {
    plan: null,
    usedPercent: null,
    resetsAt: null,
    allowed: null,
    status: "unavailable",
  };
  if (!result || typeof result !== "object" || !result.rateLimits) return unavailable;
  const snapshots = [result.rateLimits, ...Object.values(result.rateLimitsByLimitId ?? {})].filter(
    (s) => s && typeof s === "object",
  );
  let worst = null;
  for (const s of snapshots) {
    for (const w of [s.primary, s.secondary]) {
      if (w && typeof w.usedPercent === "number" && (!worst || w.usedPercent > worst.usedPercent)) {
        worst = w;
      }
    }
  }
  const plan = typeof result.rateLimits.planType === "string" ? result.rateLimits.planType : null;
  let allowed =
    typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null;
  if (allowed === true && snapshots.some((s) => s.rateLimitReachedType)) allowed = false;
  const usedPercent = worst ? worst.usedPercent : null;
  const resetsAt = worst ? iso(worst.resetsAt) : null;
  if (allowed === null || usedPercent === null) {
    return { plan, usedPercent, resetsAt, allowed, status: "unavailable" };
  }
  const status =
    !allowed || usedPercent >= 100 ? "exhausted" : usedPercent >= RESERVE_PERCENT ? "low" : "ok";
  return { plan, usedPercent, resetsAt, allowed, status };
}

export function guardCode(usage) {
  if (usage.status === "unavailable") return EXIT.UNAVAILABLE;
  if (usage.allowed === false) return EXIT.NOT_ALLOWED;
  if (usage.usedPercent >= RESERVE_PERCENT) return EXIT.RESERVE;
  return EXIT.OK;
}

async function currentUsage() {
  return summarizeUsage(await readRateLimits());
}

function guardMessage(usage, code) {
  switch (code) {
    case EXIT.UNAVAILABLE:
      return "refused: Codex usage is unavailable (app-server did not answer); Claude does the work instead";
    case EXIT.NOT_ALLOWED:
      return `refused: Codex reports ordinary usage is not allowed (resets ${usage.resetsAt ?? "unknown"})`;
    case EXIT.RESERVE:
      return `refused: Codex usage at ${usage.usedPercent}% — the ${100 - RESERVE_PERCENT}% reserve starts at ${RESERVE_PERCENT}% (resets ${usage.resetsAt ?? "unknown"})`;
    default:
      return `usage ok: ${usage.usedPercent}% used (plan ${usage.plan ?? "unknown"})`;
  }
}

async function guardOrExit() {
  const usage = await currentUsage();
  const code = guardCode(usage);
  if (code !== EXIT.OK) fail(code, guardMessage(usage, code));
  say(guardMessage(usage, code));
  return usage;
}

// ---------------------------------------------------------------------------
// live log

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

function indent(text, max = 20) {
  const lines = String(text ?? "")
    .replace(/\s+$/, "")
    .split("\n");
  const shown = lines.length > max ? ["…", ...lines.slice(-max)] : lines;
  return lines[0] === "" && lines.length === 1 ? [] : shown.map((l) => `    | ${l}`);
}

export function describeEvent(ev) {
  switch (ev?.type) {
    case "thread.started":
      return [`[session] ${ev.thread_id}`];
    case "turn.started":
      return ["[turn] started"];
    case "turn.completed": {
      const u = ev.usage;
      return [
        `[turn] completed${u ? ` (tokens in ${u.input_tokens ?? "?"}, out ${u.output_tokens ?? "?"})` : ""}`,
      ];
    }
    case "turn.failed":
      return [`[error] ${ev.error?.message ?? "turn failed"}`];
    case "error":
      return [`[error] ${ev.message ?? JSON.stringify(ev)}`];
    case "item.started":
    case "item.updated":
    case "item.completed":
      return describeItem(ev.type.slice(5), ev.item ?? {});
    default:
      return [`[event] ${ev?.type ?? "unknown"}`];
  }
}

function describeItem(phase, item) {
  switch (item.type) {
    case "command_execution":
      if (phase === "started") return [`[exec] $ ${item.command}`];
      if (phase === "completed") {
        return [
          `[exec] exit=${item.exit_code ?? "?"} $ ${item.command}`,
          ...indent(item.aggregated_output),
        ];
      }
      return [];
    case "file_change":
      return phase === "completed"
        ? (item.changes ?? []).map((c) => `[edit] ${c.kind ?? "change"} ${c.path}`)
        : [];
    case "agent_message": {
      if (phase !== "completed") return [];
      const [first, ...rest] = String(item.text ?? "").split("\n");
      return [`[message] ${first}`, ...rest.map((l) => `    ${l}`)];
    }
    case "reasoning":
      return phase === "completed"
        ? [
            `[thinking] ${String(item.text ?? "")
              .split("\n")[0]
              .slice(0, 200)}`,
          ]
        : [];
    case "todo_list":
      return [
        `[plan] ${(item.items ?? []).map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("; ")}`,
      ];
    case "mcp_tool_call":
      return phase === "started" ? [`[tool] ${item.server}.${item.tool}`] : [];
    case "web_search":
      return phase === "completed" ? [`[search] ${item.query}`] : [];
    case "error":
      return [`[error] ${item.message}`];
    default:
      return phase === "completed" ? [`[item] ${item.type}`] : [];
  }
}

function openLiveLog(id, kind) {
  mkdirSync(LIVE, { recursive: true });
  const name = `${id}-${kind}`;
  const log = join(LIVE, `${name}.log`);
  const jsonl = join(LIVE, `${name}.jsonl`);
  writeFileSync(log, "");
  writeFileSync(jsonl, "");
  // Atomic pointer swap: a new symlink under a temp name renamed over the old.
  const tmp = join(LIVE, `.current.${process.pid}.tmp`);
  try {
    unlinkSync(tmp);
  } catch {}
  symlinkSync(`${name}.log`, tmp);
  renameSync(tmp, join(LIVE, "current.log"));
  say(`live log: tail -F ${join(LIVE, "current.log")}   (or: ${SELF} watch)`);
  return {
    log,
    write(lines) {
      if (lines.length) appendFileSync(log, lines.map((l) => `${clock()} ${l}\n`).join(""));
    },
    raw(line) {
      appendFileSync(jsonl, `${line}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Antigravity tab (codex-bridge)

let ideLaunched = false;

// Opens (or focuses) an Antigravity window on the project, at most once per run,
// unless a live window already has it; that window's extension claims requests.
function ensureWindow(cli) {
  if (ideLaunched) return;
  ideLaunched = true;
  if (bridge.windowCovers(BRIDGE_STATE, MAIN)) return;
  const child = spawn(cli, [MAIN], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

// Queues a follow-tab request (headless runs) for the IDE extension. Best effort: never throws.
function openBridgeTab({ id, kind, cwd, sessionId, liveLog }) {
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: owner opt-out
    if (process.env.CODEX_BRIDGE_TAB === "0") return;
    const cli = bridge.antigravityCli(process.env);
    if (!cli) return;
    bridge.ensureDirs(BRIDGE_STATE);
    const written = bridge.writeRequest(BRIDGE_STATE, {
      runId: id,
      kind,
      projectRoot: MAIN,
      cwd,
      sessionId: bridge.UUID_RE.test(sessionId ?? "") ? sessionId : null,
      liveLog,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      codexHome: existsSync(codexHome()) ? realpathSync(codexHome()) : null,
    });
    if (!written) return;
    ensureWindow(cli);
    say(`antigravity tab requested: Codex · ${kind} · ${id.slice(9, 15)}`);
  } catch (err) {
    say(`antigravity tab skipped: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// TUI mode: the interactive Codex TUI in the Antigravity tab is the worker.
//
// The wrapper queues a `tui` request (role + prompt file, never a command);
// the window's extension runs `codex-bridge tui <run>`, which rebuilds the
// pinned argv itself (tuiArgs) and runs Codex interactively. The wrapper finds
// the session by the run marker in the prompt, follows its rollout
// (~/.codex/sessions/**/rollout-*.jsonl) to task_complete, and writes the same
// reports and exit codes as a headless run. The TUI stays open for the owner.
// If no window claims the request in time, or the TUI fails to start, the run
// falls back to headless `codex exec`.

// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only tuning knob
const CLAIM_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_CLAIM_TIMEOUT_MS) || 20_000;
// How long a started TUI may sit without a session (e.g. an owner prompt)
// before it is stopped and the run goes headless.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tuning knob
const SESSION_WAIT_MS = Number(process.env.CODEX_BRIDGE_SESSION_WAIT_MS) || 180_000;
// Once the session exists, how long the TUI may go without any turn or agent
// activity (an update notice, a question, unsubmitted input) before it is
// stopped and the run goes headless.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tuning knob
const FIRST_ACTIVITY_MS = Number(process.env.CODEX_BRIDGE_FIRST_ACTIVITY_MS) || 120_000;
// Once a turn is running, how long the session file may stay completely quiet
// (Mac sleep, network drop) before the TUI is stopped and the same session is
// resumed headless. Far longer than the first-activity window: a long tool call
// or a model thinking legitimately produces nothing for minutes.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tuning knob
const MID_RUN_INACTIVITY_MS = Number(process.env.CODEX_BRIDGE_INACTIVITY_MS) || 600_000;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only tuning knob
const HELPER_START_MS = Number(process.env.CODEX_BRIDGE_HELPER_START_MS) || 15_000;
const ROLLOUT_SCAN_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function marker(id) {
  return `codex-bridge run ${id}`;
}

// Every run uses a fresh worktree, which the owner never trusted, so the TUI
// would stop at "trust this folder?". Trust exactly
// this run's directories, for this run only, as one inline table: a dotted
// `projects."<path>".trust_level` key would break on paths containing dots.
// Sandbox and approvals stay pinned explicitly, so trust loosens neither.
export function trustOverride(paths) {
  const entries = [...new Set(paths)].map((p) => `${JSON.stringify(p)}={trust_level="trusted"}`);
  return `projects={${entries.join(",")}}`;
}

// ---- TUI isolation ---------------------------------------------------------
// The interactive CLI rejects --ignore-user-config (exec-only; verified on
// 0.159.2), so the TUI loads the owner's config, including MCP servers,
// plugins (browser, computer use), hooks, notify and js_repl, which act
// outside the shell sandbox. A table override like mcp_servers={} MERGES and
// clears nothing (verified), so every resolved server is disabled by name and
// the result is verified with Codex's own listings before each launch. Any
// doubt fails closed: the run goes headless (isolated by --ignore-user-config).

const ISOLATION_PINS = [
  "-c",
  "notify=[]",
  "-c",
  "features.hooks=false",
  "-c",
  "features.js_repl=false",
  "-c",
  "features.plugins=false",
];
// Dotted -c keys cannot express names containing dots or quotes.
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MUST_BE_OFF = ["hooks", "plugins", "js_repl"];
const MUST_BE_LISTED = ["hooks", "plugins"];

export function parseMcpList(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const arr = Array.isArray(j)
    ? j
    : Array.isArray(j?.servers)
      ? j.servers
      : Array.isArray(j?.mcp_servers)
        ? j.mcp_servers
        : null;
  if (!arr) return null;
  const out = [];
  for (const s of arr) {
    if (!s || typeof s.name !== "string" || typeof s.enabled !== "boolean") return null;
    out.push({ name: s.name, enabled: s.enabled });
  }
  return out;
}

// `codex features list`: one feature per line, its state as the last token.
export function parseFeatures(text) {
  if (typeof text !== "string") return null;
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t.length < 2) continue;
    const last = t.at(-1).toLowerCase();
    if (["true", "on", "enabled"].includes(last)) out[t[0]] = true;
    else if (["false", "off", "disabled"].includes(last)) out[t[0]] = false;
  }
  return Object.keys(out).length ? out : null;
}

function codexQuery(args, { cwd, env }) {
  const r = spawnSync(CODEX, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Resolves the overrides that keep the TUI isolated, and proves them with
 * Codex's own listings. Returns { ok, args, mcp, reason }.
 */
export function tuiIsolation({ cwd, env = process.env, trusted = [cwd] }) {
  const no = (reason) => ({ ok: false, reason, args: null, mcp: null });
  // Queried with exactly the trust the launch grants: a trusted project also
  // loads its own .codex/config.toml, which may add servers.
  const pins = [...ISOLATION_PINS, "-c", trustOverride(trusted)];
  const before = parseMcpList(codexQuery([...pins, "mcp", "list", "--json"], { cwd, env }));
  if (!before) return no("could not list MCP servers");
  const odd = before.filter((s) => !MCP_NAME_RE.test(s.name));
  if (odd.length) return no(`MCP server name(s) cannot be disabled by override: ${odd.length}`);
  const args = [
    ...ISOLATION_PINS,
    ...before.flatMap((s) => ["-c", `mcp_servers.${s.name}.enabled=false`]),
  ];
  const queryArgs = [...args, "-c", trustOverride(trusted)];
  const after = parseMcpList(codexQuery([...queryArgs, "mcp", "list", "--json"], { cwd, env }));
  if (!after) return no("could not re-list MCP servers with the overrides");
  const still = after.filter((s) => s.enabled).map((s) => s.name);
  if (still.length) return no(`MCP servers still enabled: ${still.join(", ")}`);
  const features = parseFeatures(codexQuery([...queryArgs, "features", "list"], { cwd, env }));
  if (!features) return no("could not list features");
  const on = MUST_BE_OFF.filter((f) => features[f] === true);
  if (on.length) return no(`features still enabled: ${on.join(", ")}`);
  const unknown = MUST_BE_LISTED.filter((f) => !(f in features));
  if (unknown.length) return no(`cannot verify features: ${unknown.join(", ")}`);
  return { ok: true, args, mcp: after, reason: null };
}

// Everything that matters is pinned on the command line, which outranks the
// owner's config: model, effort, sandbox, approvals, network, env inheritance,
// and the verified isolation overrides.
export function tuiArgs(role, cwd, prompt, trusted = [cwd], isolation = ISOLATION_PINS) {
  return [
    ...roleArgs(role, { withSandboxFlag: true }).filter((a) => a !== "--ignore-user-config"),
    ...isolation,
    "--ask-for-approval",
    "never",
    "-c",
    trustOverride(trusted),
    "-C",
    cwd,
    prompt,
  ];
}

function schemaInstruction(file) {
  return [
    "End your final message with exactly one fenced ```json block holding a single JSON object",
    "that matches this JSON Schema:",
    "",
    readFileSync(join(SCHEMAS, file), "utf8").trim(),
  ].join("\n");
}

function reviewPrompt(base, head, id) {
  return [
    `Review the changes on this branch: run \`git diff ${base}...HEAD\` (HEAD is ${head}) and review only that diff, reading surrounding code where needed.`,
    "Do not modify any files. Report real bugs, security problems and regressions with file and line numbers; skip style nits.",
    schemaInstruction("review-output.schema.json"),
    `(${marker(id)})`,
  ].join("\n\n");
}

function taskPrompt(brief, id) {
  return [
    brief.trimEnd(),
    "---",
    schemaInstruction("worker-report.schema.json"),
    `(${marker(id)})`,
  ].join("\n\n");
}

// A final message may be bare JSON or prose ending in a fenced ```json block.
export function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const blocks = [...text.matchAll(/```json[ \t]*\n([\s\S]*?)```/g)];
  for (const m of blocks.reverse()) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  return null;
}

function codexHome() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Codex's own home override
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function dateDirs(times) {
  const out = new Set();
  const p2 = (n) => String(n).padStart(2, "0");
  for (const t of times) {
    const d = new Date(t);
    out.add(join(`${d.getFullYear()}`, p2(d.getMonth() + 1), p2(d.getDate())));
    out.add(join(`${d.getUTCFullYear()}`, p2(d.getUTCMonth() + 1), p2(d.getUTCDate())));
  }
  return [...out];
}

function userTexts(o) {
  const p = o?.payload;
  if (!p || typeof p !== "object") return [];
  if (o.type === "event_msg" && p.type === "user_message" && typeof p.message === "string")
    return [p.message];
  if (o.type === "response_item" && p.type === "message" && p.role === "user")
    return (p.content ?? []).map((c) => c?.text).filter((t) => typeof t === "string");
  return [];
}

// The rollout of the session whose prompt carries this run's marker. Reads at
// most the head of each recent rollout; never logs its content.
function findRollout(id, since) {
  const sessions = join(codexHome(), "sessions");
  const want = marker(id);
  for (const rel_ of dateDirs([since, Date.now()])) {
    const dir = join(sessions, rel_);
    let names;
    try {
      names = readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < since - 2000) continue;
        const fd = openSync(file, "r");
        const buf = Buffer.alloc(Math.min(fstatSync(fd).size, ROLLOUT_SCAN_BYTES));
        readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        for (const line of buf.toString("utf8").split("\n")) {
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (userTexts(o).some((t) => t.includes(want))) return file;
          if (o.type === "event_msg" && o.payload?.type === "task_complete") break;
        }
      } catch {}
    }
  }
  return null;
}

function firstLine(text) {
  return String(text ?? "")
    .split("\n")[0]
    .slice(0, 200);
}

// Writes the stop marker the tab helper polls: it then kills the TUI's whole
// process tree, and it refuses to start Codex at all if the marker came first.
function stopTui(id) {
  try {
    writeFileSync(
      join(bridge.dirs(BRIDGE_STATE).tui, `${id}.stop`),
      `${new Date().toISOString()}\n`,
    );
  } catch {}
}

function helperState(id) {
  const st = readJson(join(bridge.dirs(BRIDGE_STATE).tui, `${id}.json`));
  if (!st) return "none";
  return st.status === "exited" || (st.pid && !alive(st.pid)) ? "exited" : "running";
}

// After stopTui: wait until the helper reports its Codex tree is gone.
async function waitHelperExit(id) {
  const until = Date.now() + KILL_GRACE_MS + 5000;
  while (helperState(id) === "running" && Date.now() < until) await sleep(100);
}

async function runTui({ kind, id, role, cwd, prompt, timeoutSec, live, onSession, fallback }) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: owner opt-out
  if (process.env.CODEX_BRIDGE_TAB === "0" || process.env.CODEX_BRIDGE_TUI === "0") return null;
  const cli = bridge.antigravityCli(process.env);
  if (!cli) return null;
  const iso = tuiIsolation({
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome() },
    trusted: [cwd, MAIN],
  });
  if (!iso.ok) {
    live.write([`[tui] isolation check failed: ${iso.reason}; running headless`]);
    say(`TUI isolation check failed (${iso.reason}); running headless`);
    return null;
  }
  live.write([
    `[tui] isolation ok: ${iso.mcp.length} MCP servers, ${iso.mcp.filter((x) => x.enabled).length} enabled; plugins, hooks, js_repl, notify off`,
  ]);
  const d = bridge.dirs(BRIDGE_STATE);
  const promptFile = join(d.prompts, `${id}.md`);
  const reqFile = join(d.requests, `${id}.json`);
  const dropPrompt = () => rmSync(promptFile, { force: true });
  // Withdraw (never leave claimable) whatever happens before the watch starts.
  const withdraw = () => {
    stopTui(id);
    let withdrawn = false;
    try {
      unlinkSync(reqFile);
      withdrawn = true;
    } catch {}
    dropPrompt();
    return withdrawn;
  };
  const onSignal = (sig) => {
    withdraw();
    live.write([`[end] interrupted by ${sig}`]);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const unhook = () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  try {
    bridge.ensureDirs(BRIDGE_STATE);
    const home = codexHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(promptFile, prompt, { mode: 0o600 });
    const written = bridge.writeRequest(BRIDGE_STATE, {
      runId: id,
      kind,
      projectRoot: MAIN,
      cwd,
      sessionId: null,
      liveLog: live.log,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      mode: "tui",
      role,
      promptFile,
      codexHome: realpathSync(home),
    });
    if (!written) throw new Error("a request for this run already exists");
    ensureWindow(cli);
  } catch (err) {
    dropPrompt();
    unhook();
    say(`tui tab skipped: ${err?.message ?? err}`);
    return null;
  }
  const launchedAt = Date.now();
  const claimed = join(d.claimed, `${id}.json`);
  while (!existsSync(claimed) && Date.now() - launchedAt < CLAIM_TIMEOUT_MS) await sleep(100);
  if (!existsSync(claimed) && (withdraw() || !existsSync(claimed))) {
    unhook();
    say(
      `no Antigravity window claimed the tab within ${CLAIM_TIMEOUT_MS / 1000}s; running headless`,
    );
    live.write(["[tui] no Antigravity window claimed the tab; running headless"]);
    return null;
  }
  unhook();
  const tab = `Codex · ${kind} · ${id.slice(9, 15)}`;
  say(`codex is running interactively in the Antigravity tab "${tab}"`);
  live.write([`[tui] Codex opened in the Antigravity tab "${tab}"`]);
  const res = await watchTui({
    id,
    claimedAt: Date.now(),
    launchedAt,
    timeoutSec,
    live,
    onSession,
    fallback,
  });
  if (res === null && fallback?.reason === "no-first-activity") {
    withdraw();
    say("the TUI started no turn in time (stopped it); running headless");
  } else if (res === null && fallback?.reason === "mid-run-inactivity") {
    withdraw();
    say("the TUI went silent mid-run (stopped it); resuming the session headless");
  } else if (res === null) {
    live.write(["[tui] no Codex session started in the tab; it was stopped; running headless"]);
    say("no Codex session started in the tab (stopped it); running headless");
  }
  return res;
}

const fallbackRecord = (f) => ({
  from: "tui",
  to: "headless",
  reason: f.reason,
  tuiSessionId: f.sessionId ?? null,
  windowSec: f.windowSec,
});

async function watchTui({ id, claimedAt, launchedAt, timeoutSec, live, onSession, fallback }) {
  const state = { sessionId: null, limitHit: false, timedOut: false, lastMessage: null, code: 1 };
  const onSignal = (sig) => {
    live.write([`[end] interrupted by ${sig}`]);
    stopTui(id);
    waitHelperExit(id).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const deadline = Date.now() + timeoutSec * 1000;
  let rollout = null;
  let pos = 0;
  let partial = "";
  let done = false;
  let fellBack = false;
  let sessionFoundAt = 0;
  let lastActivityAt = 0;
  let active = false;

  const handle = (o) => {
    const p = o?.payload ?? {};
    // Turn/agent activity: a started turn, any agent output or tool call.
    if (
      (o.type === "event_msg" && p.type !== "user_message") ||
      (o.type === "response_item" && !(p.type === "message" && p.role !== "assistant"))
    )
      active = true;
    if (o.type === "session_meta" && bridge.UUID_RE.test(p.id ?? "")) {
      state.sessionId = p.id;
      live.write([`[session] ${p.id}`]);
      onSession?.(p.id);
    } else if (o.type === "response_item") {
      if (p.type === "function_call" || p.type === "custom_tool_call")
        live.write([`[tool] ${p.name}`]);
      else if (p.type === "message" && p.role === "assistant") {
        const text = (p.content ?? []).map((c) => c?.text ?? "").join("");
        if (text) live.write([`[message] ${firstLine(text)}`]);
      }
    } else if (o.type === "event_msg") {
      if (p.type === "task_complete") {
        state.lastMessage = p.last_agent_message ?? null;
        state.code = 0;
        live.write(["[turn] completed"]);
        done = true;
      } else if (p.type === "error" || p.type === "stream_error") {
        const msg = String(p.message ?? "");
        live.write([`[error] ${firstLine(msg)}`]);
        if (LIMIT_RE.test(msg) || /usage_limit_reached/i.test(JSON.stringify(p))) {
          state.limitHit = true;
          done = true;
        }
      } else if (p.type === "turn_aborted") {
        live.write(["[turn] aborted"]);
        done = true;
      }
    }
  };

  for (;;) {
    if (!rollout) {
      rollout = findRollout(id, launchedAt);
      if (rollout) {
        sessionFoundAt = Date.now();
        lastActivityAt = sessionFoundAt;
        live.write(["[tui] following the Codex session"]);
      }
    }
    if (rollout) {
      try {
        const fd = openSync(rollout, "r");
        const size = fstatSync(fd).size;
        if (size > pos) {
          const buf = Buffer.alloc(size - pos);
          readSync(fd, buf, 0, buf.length, pos);
          pos = size;
          lastActivityAt = Date.now();
          const lines = (partial + buf.toString("utf8")).split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (done) break;
            try {
              handle(JSON.parse(line));
            } catch {}
          }
        }
        closeSync(fd);
      } catch {}
    }
    if (done) break;
    if (Date.now() > deadline) {
      state.timedOut = true;
      live.write([`[watchdog] timeout after ${timeoutSec}s — stopping the Codex TUI`]);
      stopTui(id);
      await waitHelperExit(id);
      break;
    }
    const helper = helperState(id);
    if (helper === "exited") {
      const st = readJson(join(bridge.dirs(BRIDGE_STATE).tui, `${id}.json`));
      if (st?.code) {
        const why = st.error?.startsWith("isolation failed")
          ? firstLine(st.error)
          : st.error
            ? firstLine(st.error.split("\n").at(-1))
            : "";
        live.write([`[tui] codex exited with code ${st.code}${why ? `: ${why}` : ""}`]);
      }
      if (!rollout) fellBack = true;
      else live.write(["[tui] the Codex TUI exited before finishing"]);
      break;
    }
    // No session yet: the tab never started, or Codex sits at a prompt. Stop
    // it for certain before going headless, so a late answer cannot start a
    // duplicate run.
    const waited = Date.now() - claimedAt;
    if (!rollout && (helper === "none" ? waited > HELPER_START_MS : waited > SESSION_WAIT_MS)) {
      stopTui(id);
      await waitHelperExit(id);
      fellBack = true;
      break;
    }
    // Session but no turn: the TUI sits at a prompt after creating it. Stop
    // the whole tree, then go headless (nothing ran, so a task is idempotent).
    if (rollout && !active && Date.now() - sessionFoundAt > FIRST_ACTIVITY_MS) {
      live.write([
        `[tui] no activity within ${FIRST_ACTIVITY_MS / 1000}s — falling back to headless`,
      ]);
      stopTui(id);
      await waitHelperExit(id);
      if (fallback) {
        fallback.reason = "no-first-activity";
        fallback.sessionId = state.sessionId;
        fallback.windowSec = FIRST_ACTIVITY_MS / 1000;
      }
      fellBack = true;
      break;
    }
    // A turn ran, then the session file went quiet (sleep, network drop). Stop
    // the whole tree; the same session is resumed headless by the caller. With
    // no session id there is nothing to resume: fail instead of guessing.
    if (rollout && active && Date.now() - lastActivityAt > MID_RUN_INACTIVITY_MS) {
      const win = MID_RUN_INACTIVITY_MS / 1000;
      stopTui(id);
      await waitHelperExit(id);
      if (state.sessionId) {
        live.write([
          `[tui] no activity for ${win}s mid-run — resuming session ${state.sessionId} headless`,
        ]);
        if (fallback) {
          fallback.reason = "mid-run-inactivity";
          fallback.sessionId = state.sessionId;
          fallback.windowSec = win;
        }
        fellBack = true;
      } else {
        live.write([
          `[tui] no activity for ${win}s mid-run and no session id to resume — stopped the TUI; failing the run`,
        ]);
        say(`the TUI went silent for ${win}s and has no session id to resume; failed`);
      }
      break;
    }
    await sleep(250);
  }
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  return fellBack ? null : state;
}

// ---------------------------------------------------------------------------
// running codex

const LIMIT_RE = /usage[ _-]?limit/i;

function runCodex({ args, cwd, stdinText, timeoutSec, live, onSession }) {
  return new Promise((resolve) => {
    const state = { sessionId: null, limitHit: false, timedOut: false, lastMessage: null };
    const child = spawn(CODEX, args, {
      cwd,
      detached: true, // own process group, so the watchdog can kill all of it
      stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    // Interrupted: ask the group to stop, and SIGKILL it for certain before
    // this process exits — whichever comes first, Codex closing or the grace.
    let interrupted = null;
    const onSignal = (sig) => {
      if (interrupted) return;
      interrupted = sig;
      live.write([`[end] interrupted by ${sig}`]);
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
        process.exit(130);
      }, KILL_GRACE_MS);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let hardKill = null;
    const watchdog = setTimeout(() => {
      state.timedOut = true;
      live.write([`[watchdog] timeout after ${timeoutSec}s — killing the Codex process group`]);
      killGroup("SIGTERM");
      hardKill = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }, timeoutSec * 1000);

    if (stdinText !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdinText);
    }

    const onStdoutLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        live.write([`[stdout] ${line}`]);
        return;
      }
      live.raw(line);
      if (ev.type === "thread.started" && ev.thread_id) {
        state.sessionId = ev.thread_id;
        onSession?.(ev.thread_id);
      }
      if ((ev.type === "turn.failed" || ev.type === "error") && LIMIT_RE.test(line)) {
        state.limitHit = true;
      }
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
        state.lastMessage = ev.item.text ?? null;
      }
      live.write(describeEvent(ev));
    };
    const onStderrLine = (line) => {
      if (!line.trim()) return;
      if (/hit your usage limit/i.test(line)) state.limitHit = true;
      live.write([`[stderr] ${line}`]);
    };
    const lineReader = (stream, fn) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (d) => {
        buf += d;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          fn(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      stream.on("end", () => {
        if (buf) fn(buf);
      });
    };
    lineReader(child.stdout, onStdoutLine);
    lineReader(child.stderr, onStderrLine);

    child.on("error", (err) => {
      live.write([`[error] could not start codex: ${err.message}`]);
    });
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      if (hardKill) clearTimeout(hardKill);
      // Descendants that ignored SIGTERM (or outlived the leader) die here.
      if (state.timedOut || interrupted) killGroup("SIGKILL");
      if (interrupted) process.exit(130);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve({ ...state, code, signal });
    });
  });
}

function roleArgs(role, { withSandboxFlag }) {
  const r = ROLES[role];
  const sandbox = withSandboxFlag ? ["-s", r.sandbox] : ["-c", `sandbox_mode="${r.sandbox}"`];
  return [
    "-m",
    r.model,
    "-c",
    `model_reasoning_effort="${r.effort}"`,
    ...sandbox,
    ...PINNED_CONFIG,
  ];
}

async function recordLimit({ sessionId, id, kind, role, worktree }) {
  const usage = await currentUsage();
  if (sessionId) {
    writeJson(PENDING, {
      sessionId,
      runId: id,
      kind,
      role,
      worktree: rel(worktree),
      resetsAt: usage.resetsAt,
      recordedAt: new Date().toISOString(),
    });
  }
  say(
    `Codex hit its usage limit mid-run. Stop handing Codex work; resets ${usage.resetsAt ?? "unknown"}.` +
      (sessionId ? ` After reset: ${SELF} resume ${sessionId}` : ""),
  );
  return usage.resetsAt;
}

// ---------------------------------------------------------------------------
// review

const SEVERITY_LABEL = {
  critical: "BLOCKER candidate",
  high: "BLOCKER candidate",
  medium: "MAJOR",
  low: "MINOR",
};

function isReview(v) {
  return (
    v &&
    typeof v === "object" &&
    (v.verdict === "approve" || v.verdict === "needs-attention") &&
    Array.isArray(v.findings)
  );
}

const NATIVE_SEVERITY = ["critical", "high", "medium", "low"];

// `codex exec review` does not honour --output-schema (observed on 0.159.2):
// its final message is prose followed by "- [P<n>] <title> — <file>:<a>-<b>"
// items with indented bodies. Parse that into the review shape.
export function parseNativeReview(text, worktree) {
  const head = /^\s*-\s*\[P([0-3])\]\s+(.+?)\s+(?:—|--|-)\s+(\S.*?):(\d+)(?:-(\d+))?\s*$/;
  const findings = [];
  let current = null;
  for (const line of text.split("\n")) {
    const m = line.match(head);
    if (m) {
      let file = m[3];
      if (worktree && isAbsolute(file)) {
        const r = relative(worktree, file);
        if (!r.startsWith("..")) file = r;
      }
      current = {
        severity: NATIVE_SEVERITY[Number(m[1])],
        title: m[2],
        body: "",
        file,
        line_start: Number(m[4]),
        line_end: Number(m[5] ?? m[4]),
        confidence: null,
        recommendation: "",
      };
      findings.push(current);
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.body += (current.body ? "\n" : "") + line.trim();
    } else if (line.trim()) {
      current = null;
    }
  }
  if (!findings.length) return null;
  const summary = text.split(/\n\s*Review comments?:/)[0].trim();
  return { verdict: "needs-attention", summary, findings, next_steps: [] };
}

function reviewMarkdown(report) {
  const out = [
    `# Codex review (advisory) — ${report.runId}`,
    "",
    `- Worktree: \`${report.worktree}\``,
    `- Range: \`${report.base.slice(0, 12)}..${(report.head ?? "").slice(0, 12)}\``,
    `- Model: ${report.model} (${report.effort})`,
    ...(report.sessionId
      ? [
          `- Codex session: \`${report.sessionId}\` (open with \`codex resume ${report.sessionId}\`)`,
        ]
      : []),
    `- Status: ${report.status}${report.verdict ? ` · Verdict: **${report.verdict}**` : ""}`,
    "",
  ];
  if (report.review) {
    out.push("## Summary", "", report.review.summary ?? "", "", "## Findings", "");
    if (!report.review.findings.length) out.push("None.", "");
    report.review.findings.forEach((f, n) => {
      const where = f.file
        ? `\`${f.file}${f.line_start ? `:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ""}` : ""}\``
        : "";
      out.push(
        `### ${n + 1}. [${f.severity} → ${SEVERITY_LABEL[f.severity] ?? "?"}] ${f.title}`,
        "",
        `${where}${where && f.confidence !== null ? " · " : ""}${f.confidence !== null ? `confidence ${f.confidence}` : ""}`,
        "",
        f.body ?? "",
        "",
        ...(f.recommendation ? [`**Recommendation:** ${f.recommendation}`, ""] : []),
      );
    });
    if (report.review.next_steps?.length) {
      out.push("## Next steps", "", ...report.review.next_steps.map((s) => `- ${s}`), "");
    }
  } else if (report.text) {
    out.push("## Review text (unstructured)", "", report.text, "");
  } else {
    out.push("No review output — treat as unavailable, never as a clean review.", "");
  }
  out.push("Severity is advisory: the Claude opus reviewer decides final severity.", "");
  return out.join("\n");
}

// Headless continuation of a known session (`exec resume` has no -s/-C: the
// sandbox comes from -c, the root from cwd). Shared by `resume` and by the
// mid-run inactivity fallback, so both keep the same pinned flags.
function resumeArgs(role, sessionId, lastMessage, schemaFile, extras = []) {
  return [
    "exec",
    "resume",
    sessionId,
    "--json",
    "--output-schema",
    join(SCHEMAS, schemaFile),
    "-o",
    lastMessage,
    ...roleArgs(role, { withSandboxFlag: false }),
    ...extras,
    "-",
  ];
}

// Budget for an automatic continuation of an interrupted TUI run: one deadline
// for the whole run, counted from its start. When it is spent, report the
// watchdog timeout instead of resuming.
function remainingBudget(startedMs, timeoutSec, sessionId, live) {
  const remaining = timeoutSec - (Date.now() - startedMs) / 1000;
  if (remaining > 0) return { remaining };
  live.write([
    `[watchdog] timeout after ${timeoutSec}s — nothing left to resume session ${sessionId}`,
  ]);
  return {
    res: { sessionId, limitHit: false, timedOut: true, lastMessage: null, code: 1 },
  };
}

const CONTINUE_TASK =
  "Continue the interrupted task from where you stopped. Re-run the relevant tests, " +
  "then give the final report in the required shape.\n";
const CONTINUE_REVIEW =
  "Continue the interrupted review from where you stopped, then give the final review " +
  "in the required JSON shape.\n";

async function cmdReview({ positional, opts, extras }) {
  if (positional.length !== 2) fail(EXIT.USAGE, USAGE_TEXT);
  const worktree = validateWorktree(positional[0]);
  const baseRef = positional[1];
  const base = git(worktree, "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`);
  if (!base) fail(EXIT.USAGE, `base ref ${baseRef} does not resolve to a commit in ${worktree}`);
  const head = git(worktree, "rev-parse", "HEAD");
  const timeoutSec = positiveSeconds(opts.timeoutSec, DEFAULT_TIMEOUT_SEC.review, "--timeout-sec");
  if (opts.allowDirty) fail(EXIT.USAGE, "--allow-dirty is not accepted for review");
  enforceExtras(extras, "review");
  refuseIfDirty(worktree);
  await guardOrExit();

  const id = runId();
  const role = ROLES.review;
  const tmp = mkdtempSync(join(tmpdir(), "ccc-codex-review-"));
  const lastMessage = join(tmp, "last-message.txt");
  const live = openLiveLog(id, "review");
  live.write([
    `[start] review ${rel(worktree)} ${base.slice(0, 12)}..${head.slice(0, 12)} model=${role.model} effort=${role.effort} sandbox=read-only`,
  ]);
  const args = [
    "exec",
    "review",
    "--base",
    base,
    "--json",
    "--output-schema",
    join(SCHEMAS, "review-output.schema.json"),
    "-o",
    lastMessage,
    "-c",
    `review_model="${role.model}"`,
    ...roleArgs("review", { withSandboxFlag: false }),
    ...extras,
  ];
  const onSession = (sid) =>
    openBridgeTab({ id, kind: "review", cwd: worktree, sessionId: sid, liveLog: live.log });
  const fallback = {};
  const startedMs = Date.now();
  let res = extras.length
    ? null
    : await runTui({
        fallback,
        kind: "review",
        id,
        role: "review",
        cwd: worktree,
        prompt: reviewPrompt(base, head, id),
        timeoutSec,
        live,
      });
  const mode = res ? "tui" : "headless";
  const fallbackInfo = fallback.reason ? fallbackRecord(fallback) : null;
  if (fallback.reason === "mid-run-inactivity") {
    const resumed = resumeArgs(
      "review",
      fallback.sessionId,
      lastMessage,
      "review-output.schema.json",
    );
    const budget = remainingBudget(startedMs, timeoutSec, fallback.sessionId, live);
    res ??=
      budget.res ??
      (await runCodex({
        args: resumed,
        cwd: worktree,
        stdinText: CONTINUE_REVIEW,
        timeoutSec: budget.remaining,
        live,
        onSession,
      }));
  }
  res ??= await runCodex({ args, cwd: worktree, stdinText: null, timeoutSec, live, onSession });

  let text = existsSync(lastMessage) ? readFileSync(lastMessage, "utf8").trim() : "";
  if (!text && res.lastMessage) text = res.lastMessage.trim();
  rmSync(tmp, { recursive: true, force: true });
  let parsed = extractJson(text);

  let status;
  let exit;
  let format = "schema";
  if (res.timedOut) [status, exit] = ["timeout", EXIT.TIMEOUT];
  else if (res.limitHit) [status, exit] = ["limit", EXIT.LIMIT_HIT];
  else if (res.code !== 0 || !text) [status, exit] = ["unavailable", EXIT.CODEX_FAILED];
  else if (isReview(parsed)) [status, exit] = ["ok", EXIT.OK];
  else {
    const native = parseNativeReview(text, worktree);
    if (native) [parsed, status, exit, format] = [native, "ok", EXIT.OK, "native-text"];
    else [status, exit] = ["unstructured", EXIT.OK];
  }

  const report = {
    runId: id,
    kind: "review",
    advisory: true,
    mode,
    ...(fallbackInfo ? { fallback: fallbackInfo } : {}),
    status,
    format: status === "ok" ? format : null,
    verdict: status === "ok" ? parsed.verdict : null,
    worktree: rel(worktree),
    base,
    head,
    model: role.model,
    effort: role.effort,
    // Codex keeps the review in its own history; open it with `codex resume <sessionId>`.
    sessionId: res.sessionId ?? null,
    review: status === "ok" ? parsed : null,
    text: status === "unstructured" || format === "native-text" ? text : null,
    finishedAt: new Date().toISOString(),
  };
  let resetsAt = null;
  if (status === "limit") {
    resetsAt = await recordLimit({ sessionId: null, id, kind: "review", role: "review", worktree });
    report.resetsAt = resetsAt;
  }
  const jsonPath = join(REPORTS, `${id}-review.json`);
  writeJson(jsonPath, report);
  writeFileSync(join(REPORTS, `${id}-review.md`), reviewMarkdown(report));
  live.write([
    `[end] status=${status} exit=${exit}${report.verdict ? ` verdict=${report.verdict}` : ""}`,
  ]);
  printResult({
    status,
    verdict: report.verdict,
    findings: report.review?.findings.length ?? null,
    report: rel(jsonPath),
    markdown: rel(join(REPORTS, `${id}-review.md`)),
    liveLog: rel(live.log),
    runId: id,
    resetsAt,
  });
  process.exit(exit);
}

// ---------------------------------------------------------------------------
// task + resume

function finalReport(text) {
  return extractJson(text) ?? (text ? { unstructured: text } : null);
}

async function runWorker({
  kind,
  id,
  role,
  worktree,
  args,
  stdinText,
  timeoutSec,
  sessionHint,
  tuiPrompt,
  resumeFor,
}) {
  const live = openLiveLog(id, kind);
  const r = ROLES[role];
  live.write([
    `[start] ${kind} role=${role} ${rel(worktree)} model=${r.model} effort=${r.effort} sandbox=${r.sandbox}`,
  ]);
  const sessionPath = join(SESSIONS, `${id}.json`);
  const session = {
    runId: id,
    kind,
    role,
    sessionId: sessionHint ?? null,
    worktree: rel(worktree),
    model: r.model,
    effort: r.effort,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  // Persist the session id the moment Codex announces it, so even a killed
  // wrapper leaves something to resume.
  const onSession = (sid) => {
    writeJson(sessionPath, { ...session, sessionId: sid });
    openBridgeTab({ id, kind, cwd: worktree, sessionId: sid, liveLog: live.log });
  };
  const tuiSession = (sid) => writeJson(sessionPath, { ...session, sessionId: sid, mode: "tui" });
  const fallback = {};
  const startedMs = Date.now();
  let res = tuiPrompt
    ? await runTui({
        fallback,
        kind,
        id,
        role,
        cwd: worktree,
        prompt: tuiPrompt,
        timeoutSec,
        live,
        onSession: tuiSession,
      })
    : null;
  session.mode = res ? "tui" : "headless";
  if (fallback.reason) session.fallback = fallbackRecord(fallback);
  if (fallback.reason === "mid-run-inactivity" && resumeFor) {
    const budget = remainingBudget(startedMs, timeoutSec, fallback.sessionId, live);
    res ??=
      budget.res ??
      (await runCodex({
        args: resumeFor(fallback.sessionId),
        cwd: worktree,
        stdinText: CONTINUE_TASK,
        timeoutSec: budget.remaining,
        live,
        onSession,
      }));
  }
  res ??= await runCodex({ args, cwd: worktree, stdinText, timeoutSec, live, onSession });
  session.sessionId = res.sessionId ?? session.sessionId;

  let status;
  let exit;
  if (res.timedOut) [status, exit] = ["timeout", EXIT.TIMEOUT];
  else if (res.limitHit) [status, exit] = ["limit", EXIT.LIMIT_HIT];
  else if (res.code !== 0) [status, exit] = ["failed", EXIT.CODEX_FAILED];
  else [status, exit] = ["ok", EXIT.OK];

  let resetsAt = null;
  if (status === "limit") {
    resetsAt = await recordLimit({ sessionId: session.sessionId, id, kind, role, worktree });
  } else if (
    status === "ok" &&
    existsSync(PENDING) &&
    readJson(PENDING)?.sessionId === session.sessionId
  ) {
    unlinkSync(PENDING);
  }
  writeJson(sessionPath, { ...session, status, resetsAt, finishedAt: new Date().toISOString() });
  return { live, res, status, exit, session, resetsAt };
}

async function cmdTask({ positional, opts, extras }) {
  if (positional.length !== 2) fail(EXIT.USAGE, USAGE_TEXT);
  const worktree = validateWorktree(positional[0]);
  if (worktree === MAIN) {
    fail(
      EXIT.USAGE,
      "refused: Codex writes only in its own linked worktree, never the main checkout",
    );
  }
  const brief = positional[1];
  if (!existsSync(brief) || !statSync(brief).isFile())
    fail(EXIT.USAGE, `brief ${brief} is not a file`);
  const role = opts.role ?? "task";
  if (!["task", "chore", "plan"].includes(role)) fail(EXIT.USAGE, `unknown role ${role}`);
  const timeoutSec = positiveSeconds(opts.timeoutSec, DEFAULT_TIMEOUT_SEC.task, "--timeout-sec");
  enforceExtras(extras, "task");
  if (!opts.allowDirty) refuseIfDirty(worktree);
  if (existsSync(PENDING)) {
    const p = readJson(PENDING);
    fail(
      EXIT.PENDING_RESUME,
      `refused: session ${p?.sessionId ?? "?"} is waiting to resume (resets ${p?.resetsAt ?? "unknown"}). Run resume first.`,
    );
  }
  await guardOrExit();

  const id = runId();
  const tmp = mkdtempSync(join(tmpdir(), "ccc-codex-task-"));
  const lastMessage = join(tmp, "last-message.txt");
  const args = [
    "exec",
    "--json",
    "-C",
    worktree,
    "--output-schema",
    join(SCHEMAS, "worker-report.schema.json"),
    "-o",
    lastMessage,
    ...roleArgs(role, { withSandboxFlag: true }),
    ...extras,
    "-",
  ];
  const stdinText = readFileSync(brief, "utf8");
  const tuiPrompt = extras.length ? null : taskPrompt(stdinText, id);
  const out = await runWorker({
    kind: "task",
    id,
    role,
    worktree,
    args,
    stdinText,
    timeoutSec,
    tuiPrompt,
    resumeFor: (sid) => resumeArgs(role, sid, lastMessage, "worker-report.schema.json"),
  });
  finishWorker(out, lastMessage, tmp, role);
}

function finishWorker({ live, res, status, exit, session, resetsAt }, lastMessage, tmp, role) {
  const text = existsSync(lastMessage)
    ? readFileSync(lastMessage, "utf8").trim()
    : (res.lastMessage ?? "");
  rmSync(tmp, { recursive: true, force: true });
  const reportPath = join(REPORTS, `${session.runId}-${role}.json`);
  writeJson(reportPath, {
    runId: session.runId,
    kind: session.kind,
    role,
    mode: session.mode ?? "headless",
    ...(session.fallback ? { fallback: session.fallback } : {}),
    status,
    sessionId: session.sessionId,
    worktree: session.worktree,
    model: session.model,
    effort: session.effort,
    resetsAt,
    report: finalReport(text),
    finishedAt: new Date().toISOString(),
  });
  live.write([`[end] status=${status} exit=${exit}`]);
  printResult({
    status,
    sessionId: session.sessionId,
    report: rel(reportPath),
    liveLog: rel(live.log),
    runId: session.runId,
    resetsAt,
  });
  process.exit(exit);
}

function findSession(sessionId) {
  if (!existsSync(SESSIONS)) return null;
  const hits = readdirSync(SESSIONS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson(join(SESSIONS, f)))
    .filter((s) => s?.sessionId === sessionId);
  return hits.at(-1) ?? null;
}

async function cmdResume({ positional, opts, extras }) {
  if (positional.length !== 1) fail(EXIT.USAGE, USAGE_TEXT);
  const sessionId = positional[0];
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) fail(EXIT.USAGE, "malformed session id");
  useCwdProject();
  const record = findSession(sessionId);
  if (!record) fail(EXIT.USAGE, `no recorded task session ${sessionId} under ${rel(SESSIONS)}`);
  const worktree = validateWorktree(
    isAbsolute(record.worktree) ? record.worktree : join(MAIN, record.worktree),
  );
  const role = ROLES[record.role] ? record.role : "task";
  const timeoutSec = positiveSeconds(opts.timeoutSec, DEFAULT_TIMEOUT_SEC.resume, "--timeout-sec");
  enforceExtras(extras, "resume");
  await guardOrExit();

  const id = runId();
  const tmp = mkdtempSync(join(tmpdir(), "ccc-codex-resume-"));
  const lastMessage = join(tmp, "last-message.txt");
  const args = resumeArgs(role, sessionId, lastMessage, "worker-report.schema.json", extras);
  const stdinText = CONTINUE_TASK;
  const out = await runWorker({
    kind: "resume",
    id,
    role,
    worktree,
    args,
    stdinText,
    timeoutSec,
    sessionHint: sessionId,
  });
  finishWorker(out, lastMessage, tmp, role);
}

// ---------------------------------------------------------------------------
// watch

async function cmdWatch({ opts }) {
  useCwdProject();
  const current = join(LIVE, "current.log");
  const idleExitSec = positiveSeconds(opts.idleExitSec, 60, "--idle-exit-sec");
  const started = Date.now();
  let target = null;
  let pos = 0;
  let waitingShown = false;
  let tail = "";
  for (;;) {
    let t = null;
    try {
      t = readlinkSync(current);
    } catch {}
    if (!t) {
      if (!waitingShown) {
        say(`no codex run yet; waiting for ${rel(current)}`);
        waitingShown = true;
      }
      if (opts.once && (Date.now() - started) / 1000 >= idleExitSec) {
        say("no codex run to watch");
        process.exit(EXIT.OK);
      }
    } else {
      if (t !== target) {
        target = t;
        pos = 0;
        tail = "";
        process.stdout.write(`--- following ${basename(t)} ---\n`);
      }
      try {
        const fd = openSync(join(LIVE, t), "r");
        const size = fstatSync(fd).size;
        if (size > pos) {
          const buf = Buffer.alloc(size - pos);
          readSync(fd, buf, 0, buf.length, pos);
          pos = size;
          const chunk = buf.toString("utf8");
          process.stdout.write(chunk);
          tail = (tail + chunk).slice(-4096);
        }
        closeSync(fd);
      } catch {}
      if (opts.once && /\[end\] /.test(tail)) process.exit(EXIT.OK);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------------------
// follow (run inside the Antigravity tab)

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function cmdFollow({ positional }) {
  if (positional.length !== 1) fail(EXIT.USAGE, USAGE_TEXT);
  const v = bridge.readClaimed(BRIDGE_STATE, positional[0]);
  if (!v.ok) fail(EXIT.USAGE, `cannot follow run ${positional[0]}: ${v.reason}`);
  const req = v.request;
  // An extension from before TUI mode runs `follow` for every request; a tui
  // request still gets the interactive Codex, never a log tail.
  if (req.mode === "tui") return cmdTui({ positional });
  process.stdout.write(`Codex ${req.kind} run ${req.runId}\nlive log: ${req.liveLog}\n\n`);
  let pos = 0;
  let tail = "";
  let sessionId = req.sessionId;
  let deadSince = null;
  for (;;) {
    try {
      const fd = openSync(req.liveLog, "r");
      const size = fstatSync(fd).size;
      if (size > pos) {
        const buf = Buffer.alloc(size - pos);
        readSync(fd, buf, 0, buf.length, pos);
        pos = size;
        const chunk = buf.toString("utf8");
        process.stdout.write(chunk);
        tail = (tail + chunk).slice(-8192);
        sessionId ??= chunk.match(/\[session\] ([0-9a-f-]{36})/i)?.[1] ?? null;
      }
      closeSync(fd);
    } catch {}
    if (/\[end\] /.test(tail)) break;
    // The wrapper died without an end marker: stop once it has been gone a while.
    if (req.pid && !alive(req.pid)) {
      deadSince ??= Date.now();
      if (Date.now() - deadSince > 3000) {
        process.stdout.write("\n[codex-bridge] the wrapper exited without an end marker\n");
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const env = {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}${delimiter}${join(homedir(), ".local", "bin")}`,
  };
  if (req.codexHome) env.CODEX_HOME = req.codexHome;
  if (sessionId && bridge.UUID_RE.test(sessionId)) {
    process.stdout.write(
      `\n[codex-bridge] opening the Codex session: codex resume ${sessionId}\n\n`,
    );
    spawnSync(CODEX, ["resume", sessionId], { stdio: "inherit", cwd: req.cwd, env });
  } else {
    process.stdout.write("\n[codex-bridge] no Codex session id was recorded for this run\n");
  }
  // Keep the tab usable: hand it to a login shell in the run's directory.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only knob
  if (process.env.CODEX_BRIDGE_FOLLOW_SHELL !== "0" && process.stdin.isTTY) {
    spawnSync(process.env.SHELL || "/bin/zsh", ["-l"], { stdio: "inherit", cwd: req.cwd, env });
  }
  process.exit(EXIT.OK);
}

// ---------------------------------------------------------------------------
// tui (run inside the Antigravity tab): the interactive Codex as the worker

async function cmdTui({ positional }) {
  if (positional.length !== 1) fail(EXIT.USAGE, USAGE_TEXT);
  const v = bridge.readClaimed(BRIDGE_STATE, positional[0]);
  if (!v.ok) fail(EXIT.USAGE, `cannot open run ${positional[0]}: ${v.reason}`);
  const req = v.request;
  if (req.mode !== "tui") fail(EXIT.USAGE, `run ${req.runId} is not a tui run`);
  const d = bridge.dirs(BRIDGE_STATE);
  const statusFile = join(d.tui, `${req.runId}.json`);
  const stopFile = join(d.tui, `${req.runId}.stop`);
  const status = (extra) =>
    writeJson(statusFile, { pid: process.pid, ...extra, at: new Date().toISOString() });
  if (existsSync(stopFile)) {
    status({ status: "exited", code: null });
    rmSync(req.promptFile, { force: true });
    fail(EXIT.USAGE, `run ${req.runId} was withdrawn`);
  }
  const prompt = readFileSync(req.promptFile, "utf8");
  rmSync(req.promptFile, { force: true });
  if (!prompt.includes(marker(req.runId))) {
    status({ status: "exited", code: null });
    fail(EXIT.REFUSED, "refused: the prompt does not carry this run's marker");
  }
  // argv is rebuilt here from the validated role and directories; nothing from
  // the request reaches a shell, and the pinned flags cannot be loosened.
  const env = {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}${delimiter}${join(homedir(), ".local", "bin")}`,
  };
  // The Codex home the wrapper checked usage against and watches for the session.
  if (req.codexHome) env.CODEX_HOME = req.codexHome;
  // Published before the (slow) preflight, so the wrapper counts the tab as started.
  status({ status: "starting" });
  // Re-verified here, in the environment Codex will actually run in.
  const trusted = [req.cwd, req.projectRoot];
  const iso = tuiIsolation({ cwd: req.cwd, env, trusted });
  if (!iso.ok) {
    status({ status: "exited", code: 3, error: `isolation failed in the tab: ${iso.reason}` });
    fail(EXIT.REFUSED, `refused: TUI isolation failed (${iso.reason}); the run goes headless`);
  }
  const args = tuiArgs(req.role, req.cwd, prompt, trusted, iso.args);
  const flags = args.slice(0, -1).join(" ").toLowerCase();
  if (BANNED.some((b) => flags.includes(b))) fail(EXIT.REFUSED, "refused: bypass flag");
  const r = ROLES[req.role];
  process.stdout.write(
    `codex-bridge: Codex ${req.kind} run ${req.runId} — ${r.model} (${r.effort}), sandbox ${r.sandbox}, approvals never\n`,
  );
  // Withdrawn while the preflight ran (the wrapper went headless): never launch.
  if (existsSync(stopFile)) {
    status({ status: "exited", code: null });
    fail(EXIT.USAGE, `run ${req.runId} was withdrawn`);
  }
  status({ status: "running" });
  // stderr is passed through and its tail kept: a TUI that refuses to start
  // (bad flag, config error) says why there, and the wrapper logs it.
  const child = spawn(CODEX, args, { stdio: ["inherit", "inherit", "pipe"], cwd: req.cwd, env });
  let errTail = "";
  child.stderr.on("data", (b) => {
    process.stderr.write(b);
    errTail = (errTail + b.toString("utf8")).slice(-2000);
  });
  let tree = new Set();
  const poll = setInterval(() => {
    if (!existsSync(stopFile)) return;
    clearInterval(poll);
    // The TUI keeps the terminal's process group, so its tree is walked
    // explicitly: everything Codex started is signalled, not just Codex.
    tree = new Set([child.pid, ...descendants(child.pid)]);
    signalAll(tree, "SIGTERM");
    setTimeout(() => signalAll(tree, "SIGKILL"), KILL_GRACE_MS).unref();
  }, 250);
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (c) => resolve(c ?? 1));
  });
  clearInterval(poll);
  if (tree.size) {
    // Stopped: make sure every process of the tree is gone before reporting.
    const until = Date.now() + KILL_GRACE_MS;
    while ([...tree].some(alive) && Date.now() < until) await sleep(100);
    signalAll(tree, "SIGKILL");
  }
  status({ status: "exited", code, error: code ? errTail.trim().slice(-500) : null });
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only knob
  if (process.env.CODEX_BRIDGE_FOLLOW_SHELL !== "0" && process.stdin.isTTY) {
    spawnSync(process.env.SHELL || "/bin/zsh", ["-l"], { stdio: "inherit", cwd: req.cwd, env });
  }
  process.exit(EXIT.OK);
}

// All descendants of `pid`, from one `ps` snapshot.
function descendants(pid) {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const kids = new Map();
  for (const line of (r.stdout ?? "").split("\n")) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!c || !p) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(c);
  }
  const out = [];
  const todo = [pid];
  while (todo.length) {
    for (const c of kids.get(todo.pop()) ?? []) {
      out.push(c);
      todo.push(c);
    }
  }
  return out;
}

function signalAll(pids, sig) {
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {}
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);
  switch (cmd) {
    case "usage": {
      printResult(await currentUsage());
      return;
    }
    case "guard": {
      const usage = await currentUsage();
      const code = guardCode(usage);
      printResult(usage);
      say(guardMessage(usage, code));
      process.exit(code);
      return;
    }
    case "review":
      return cmdReview(parsed);
    case "task":
      return cmdTask(parsed);
    case "resume":
      return cmdResume(parsed);
    case "watch":
      return cmdWatch(parsed);
    case "follow":
      return cmdFollow(parsed);
    case "tui":
      return cmdTui(parsed);
    case "tui-check": {
      // Diagnostics: what the TUI isolation check sees (names + enabled only).
      const env = { ...process.env };
      const cwd = realpathSync(process.cwd());
      const r = tuiIsolation({ cwd, env, trusted: [cwd, mainCheckoutOf(cwd) ?? cwd] });
      printResult({ ok: r.ok, reason: r.reason, mcp: r.mcp });
      process.exit(r.ok ? EXIT.OK : EXIT.REFUSED);
      return;
    }
    default:
      fail(EXIT.USAGE, USAGE_TEXT);
  }
}

await main();
