#!/usr/bin/env node
// The only sanctioned way agents reach OpenAI Codex CLI in this repository.
//
//   node scripts/codex/codex.mjs usage
//   node scripts/codex/codex.mjs guard
//   node scripts/codex/codex.mjs review <worktree> <base-ref> [--timeout-sec N] [-- <extra>]
//   node scripts/codex/codex.mjs task <worktree> <brief-file> [--role task|chore|plan]
//                                    [--timeout-sec N] [-- <extra>]
//   node scripts/codex/codex.mjs resume <session-id> [--timeout-sec N] [-- <extra>]
//   node scripts/codex/codex.mjs watch [--once] [--idle-exit-sec N]
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
// Runtime state lives under .planning/codex/ in the MAIN checkout (gitignored):
//   reports/<run>-review.json|md   review results (advisory until Phase 6)
//   reports/<run>-<role>.json      worker final reports
//   sessions/<run>.json            session id per task run (for resume)
//   pending-resume.json            set on a mid-run usage-limit hit
//   live/<run>-<kind>.log|jsonl    readable + raw event stream; live/current.log
//                                  is a symlink to the newest run

import { spawn, spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = join(HERE, "schemas");
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
  codex.mjs watch [--once] [--idle-exit-sec N]`;

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

function mainCheckout() {
  const common = git(HERE, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) fail(EXIT.USAGE, "the wrapper must live inside a git checkout");
  return realpathSync(dirname(common));
}

const MAIN = mainCheckout();
const STATE = join(MAIN, ".planning", "codex");
const REPORTS = join(STATE, "reports");
const SESSIONS = join(STATE, "sessions");
const LIVE = join(STATE, "live");
const PENDING = join(STATE, "pending-resume.json");

function rel(p) {
  const r = relative(MAIN, p);
  return r === "" ? "." : r.startsWith("..") || isAbsolute(r) ? p : r;
}

function validateWorktree(dir) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(EXIT.USAGE, `worktree ${dir} is not a directory`);
  }
  const top = git(dir, "rev-parse", "--show-toplevel");
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!top || !common) fail(EXIT.USAGE, `${dir} is not a git worktree`);
  const topReal = realpathSync(top);
  if (realpathSync(dir) !== topReal) fail(EXIT.USAGE, `${dir} is not the root of its worktree`);
  if (realpathSync(dirname(common)) !== MAIN) {
    fail(EXIT.USAGE, `${dir} is not a worktree of this repository`);
  }
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
  say(`live log: tail -F ${join(LIVE, "current.log")}   (or: node scripts/codex/codex.mjs watch)`);
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
      (sessionId ? ` After reset: node scripts/codex/codex.mjs resume ${sessionId}` : ""),
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
  const res = await runCodex({ args, cwd: worktree, stdinText: null, timeoutSec, live });

  let text = existsSync(lastMessage) ? readFileSync(lastMessage, "utf8").trim() : "";
  if (!text && res.lastMessage) text = res.lastMessage.trim();
  rmSync(tmp, { recursive: true, force: true });
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}

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
  try {
    return JSON.parse(text);
  } catch {
    return text ? { unstructured: text } : null;
  }
}

async function runWorker({ kind, id, role, worktree, args, stdinText, timeoutSec, sessionHint }) {
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
  const onSession = (sid) => writeJson(sessionPath, { ...session, sessionId: sid });
  const res = await runCodex({ args, cwd: worktree, stdinText, timeoutSec, live, onSession });
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
  const out = await runWorker({ kind: "task", id, role, worktree, args, stdinText, timeoutSec });
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
  const record = findSession(sessionId);
  if (!record)
    fail(EXIT.USAGE, `no recorded task session ${sessionId} under .planning/codex/sessions`);
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
  // `exec resume` has no -s/-C: sandbox comes from -c, the root from cwd.
  const args = [
    "exec",
    "resume",
    sessionId,
    "--json",
    "--output-schema",
    join(SCHEMAS, "worker-report.schema.json"),
    "-o",
    lastMessage,
    ...roleArgs(role, { withSandboxFlag: false }),
    ...extras,
    "-",
  ];
  const stdinText =
    "Continue the interrupted task from where you stopped. Re-run the relevant tests, " +
    "then give the final report in the required shape.\n";
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
    default:
      fail(EXIT.USAGE, USAGE_TEXT);
  }
}

await main();
