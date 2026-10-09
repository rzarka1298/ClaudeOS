// scripts/codex/codex.mjs — the only sanctioned way agents reach Codex CLI.
//
// Every case runs a copy of the real wrapper inside a throwaway repository
// with a FAKE `codex` first on PATH. The fake speaks just enough of the
// app-server JSON-RPC and the `codex exec --json` event stream to exercise the
// wrapper, records every argv it receives, and never touches the network or
// the owner's Codex account. No test spends plan allowance.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadBridgeCore } from "./codex-bridge-core.js";
import { type GateRepo, gateRepo, REPO_ROOT } from "./gate-repo.js";

const bridgeCore = loadBridgeCore();

const WRAPPER = "scripts/codex/codex.mjs";
const SCRIPTS = [
  WRAPPER,
  "scripts/codex/schemas/review-output.schema.json",
  "scripts/codex/schemas/worker-report.schema.json",
  "scripts/codex/antigravity-extension/bridge-core.js",
  "scripts/codex/antigravity-extension/package.json",
];

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const RESETS_AT = 1_790_000_000; // epoch seconds

// The fake Codex binary. Behaviour is scripted through FAKE_CODEX_* env vars.
const FAKE_CODEX = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const logFile = process.env.FAKE_CODEX_LOG;
function record(extra) {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ argv, cwd: process.cwd(), ...extra }) + "\n");
}
function emit(ev) { process.stdout.write(JSON.stringify(ev) + "\n"); }
function outFile() { const i = argv.indexOf("-o"); return i >= 0 ? argv[i + 1] : null; }

if (argv[0] === "app-server") {
  record({});
  let mode = process.env.FAKE_CODEX_USAGE || "";
  // Usage that changes while a run is in flight: the TUI fake writes this file.
  const usageFile = process.env.FAKE_CODEX_USAGE_FILE;
  if (usageFile && fs.existsSync(usageFile)) mode = fs.readFileSync(usageFile, "utf8");
  if (mode === "crash") process.exit(1);
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (process.env.FAKE_CODEX_RPC_LOG) fs.appendFileSync(process.env.FAKE_CODEX_RPC_LOG, line + "\n");
      if (msg.id === undefined) continue;
      if (msg.method === "initialize") { emit({ id: msg.id, result: { userAgent: "fake" } }); continue; }
      if (msg.method === "account/rateLimits/read") {
        if (mode === "hang") continue;
        if (usageFile && fs.existsSync(usageFile) && process.env.FAKE_CODEX_USAGE_DELAY_MS) {
          const out = { id: msg.id, result: JSON.parse(mode) };
          setTimeout(() => emit(out), Number(process.env.FAKE_CODEX_USAGE_DELAY_MS));
          continue;
        }
        if (mode === "error") { emit({ id: msg.id, error: { code: -32000, message: "not logged in" } }); continue; }
        emit({ id: msg.id, result: JSON.parse(mode) });
        continue;
      }
      emit({ id: msg.id, error: { code: -32601, message: "unknown method " + msg.method } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else if (argv[0] === "exec") {
  const stdinWanted = argv[argv.length - 1] === "-";
  const run = (stdin) => {
    record({ stdin });
    const mode = process.env.FAKE_CODEX_EXEC || "ok";
    if (mode === "early") process.exit(1);
    if (process.env.FAKE_CODEX_TUI_PIDFILE) {
      let up = false;
      try { process.kill(Number(fs.readFileSync(process.env.FAKE_CODEX_TUI_PIDFILE, "utf8")), 0); up = true; } catch {}
      record({ tuiAliveAtResume: up });
    }
    if (process.env.FAKE_CODEX_ORPHAN_PIDFILE) {
      let up = false;
      try { process.kill(Number(fs.readFileSync(process.env.FAKE_CODEX_ORPHAN_PIDFILE, "utf8")), 0); up = true; } catch {}
      record({ orphanAliveAtResume: up });
    }
    process.stderr.write("fake codex progress line\n");
    emit({ type: "thread.started", thread_id: "${SESSION_ID}" });
    emit({ type: "turn.started" });
    if (mode === "hang") {
      // A descendant that ignores SIGTERM: only a process-group SIGKILL stops it.
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
      fs.writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(child.pid));
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === "limit") {
      emit({ type: "turn.failed", error: { message: "You’ve hit your usage limit. Try again later." } });
      process.exit(1);
    }
    if (mode === "fail") {
      emit({ type: "error", message: "boom" });
      process.exit(1);
    }
    emit({ type: "item.started", item: { id: "i1", type: "command_execution", command: "pnpm test", status: "in_progress" } });
    emit({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "pnpm test", aggregated_output: "all green\n", exit_code: 0, status: "completed" } });
    emit({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" } });
    const finalMsg = process.env.FAKE_CODEX_FINAL || "done";
    emit({ type: "item.completed", item: { id: "i3", type: "agent_message", text: finalMsg } });
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    const o = outFile();
    if (o) fs.writeFileSync(o, finalMsg);
    process.exit(0);
  };
  if (stdinWanted) {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => run(s));
  } else run(null);
} else if (argv.at(-3) === "mcp" && argv.at(-2) === "list" && argv.at(-1) === "--json") {
  // The owner's MCP servers as Codex resolves them, after any -c overrides.
  record({ query: "mcp" });
  if (process.env.FAKE_CODEX_QUERY_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CODEX_QUERY_DELAY_MS));
  if (process.env.FAKE_CODEX_MCP === "fail") process.exit(1);
  const servers = JSON.parse(process.env.FAKE_CODEX_MCP || '[{"name":"pencil","enabled":true},{"name":"computer-use","enabled":false}]');
  // Like Codex: a project's own .codex/config.toml loads only once the project is trusted.
  const trusted = argv.some((a) => a.startsWith("projects=") && a.includes(JSON.stringify(process.cwd())));
  if (process.env.FAKE_CODEX_PROJECT_MCP && trusted) servers.push({ name: "proj_srv", enabled: true });
  const out = servers.map((sv) => {
    const off = argv.includes("mcp_servers." + sv.name + ".enabled=false");
    return { name: sv.name, enabled: sv.sticky ? sv.enabled : off ? false : sv.enabled, transport: { type: "stdio" } };
  });
  process.stdout.write(JSON.stringify(out));
} else if (argv.at(-2) === "features" && argv.at(-1) === "list") {
  record({ query: "features" });
  if (process.env.FAKE_CODEX_QUERY_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CODEX_QUERY_DELAY_MS));
  if (process.env.FAKE_CODEX_FEATURES) { process.stdout.write(process.env.FAKE_CODEX_FEATURES); process.exit(0); }
  const sticky = (process.env.FAKE_CODEX_STICKY_FEATURES || "").split(",");
  const line = (f, stage) => f + "  " + stage + "  " + (argv.includes("features." + f + "=false") && !sticky.includes(f) ? "false" : "true") + "\n";
  process.stdout.write(line("hooks", "stable") + line("plugins", "stable") + line("js_repl", "experimental") + "memories  stable  false\n");
} else if (argv.includes("--ask-for-approval")) {
  // The interactive TUI, as the Antigravity tab runs it: writes a rollout the
  // way Codex does (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
  const mode = process.env.FAKE_CODEX_TUI || "ok";
  record({ tui: true, codexHome: process.env.CODEX_HOME });
  // Verified on 0.159.2: the interactive CLI rejects --ignore-user-config (exec-only).
  if (argv.includes("--ignore-user-config")) {
    process.stderr.write("error: unexpected argument '--ignore-user-config' found\n");
    process.exit(2);
  }
  if (mode === "crash") {
    process.stderr.write("error: unexpected argument '--frobnicate' found\n");
    process.exit(2);
  }
  if (mode === "prompt") {
    // Stuck on an interactive prompt (e.g. "trust this folder?"): no session yet.
    if (process.env.FAKE_CODEX_PIDFILE) fs.writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  const prompt = argv[argv.length - 1];
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const dir = require("node:path").join(process.env.CODEX_HOME, "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = dir + "/rollout-" + d.toISOString().slice(0, 19).replace(/:/g, "-") + "-${SESSION_ID}.jsonl";
  const w = (o) => fs.appendFileSync(file, JSON.stringify(o) + "\n");
  const metaId = mode === "stall-nosid" ? "not-a-uuid" : "${SESSION_ID}";
  w({ type: "session_meta", payload: { id: metaId, cwd: process.cwd(), originator: "codex-tui", source: "cli" } });
  w({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } });
  w({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });
  if (process.env.FAKE_CODEX_PIDFILE) fs.writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(process.pid));
  if (mode === "silent") {
    // Session created and prompt recorded, but the TUI never starts a turn.
    setInterval(() => {}, 1000);
    return;
  }
  const firstTurnDelay = Number(process.env.FAKE_CODEX_FIRST_TURN_DELAY_MS || 0);
  const startTurn = () => {
  w({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } });
  if (mode === "stall" || mode === "stall-nosid") {
    // A turn started and produced activity, then the machine slept / the network dropped.
    w({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}" } });
    if (process.env.FAKE_CODEX_USAGE_FILE) fs.writeFileSync(process.env.FAKE_CODEX_USAGE_FILE, process.env.FAKE_CODEX_USAGE_AFTER || "");
    if (process.env.FAKE_CODEX_ORPHAN_PIDFILE) {
      // A subprocess spawned while handling SIGTERM: it outlives the TUI and any
      // tree snapshot taken before the stop.
      process.on("SIGTERM", () => {
        const c = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
        fs.writeFileSync(process.env.FAKE_CODEX_ORPHAN_PIDFILE, String(c.pid));
        process.exit(0);
      });
    }
    if (process.env.FAKE_CODEX_STUBBORN) {
      // Ignores SIGTERM and freezes the tab helper, so the stop marker is never honoured.
      process.on("SIGTERM", () => {});
      process.kill(process.ppid, "SIGSTOP");
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "hang") {
    if (process.env.FAKE_CODEX_CHILD_PIDFILE) {
      // A tool process Codex started that ignores SIGTERM.
      const c = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
      fs.writeFileSync(process.env.FAKE_CODEX_CHILD_PIDFILE, String(c.pid));
    }
    setInterval(() => {}, 1000);
    return;
  }
  setTimeout(() => {
    w({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}" } });
    if (mode === "limit") {
      w({ type: "event_msg", payload: { type: "error", message: "You've hit your usage limit. Try again later." } });
    } else {
      const finalMsg = process.env.FAKE_CODEX_FINAL || "done";
      w({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: finalMsg }] } });
      w({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: finalMsg } });
    }
    // The TUI stays open for the owner's chat; the fake lingers briefly.
    setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEX_TUI_LINGER_MS || 300));
  }, Number(process.env.FAKE_CODEX_MID_DELAY_MS || 200));
  };
  if (firstTurnDelay) setTimeout(startTurn, firstTurnDelay); else startTurn();
} else {
  record({});
  process.stdout.write("fake codex\n");
}
`;

function usageResult(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    accountId: "acct-SECRET-ID",
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      planType: "prolite",
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: RESETS_AT },
      secondary: null,
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    ...over,
  });
}

function usageAt(usedPercent: number, allowed: boolean | null = true) {
  return usageResult({
    ordinaryUsageAllowed: allowed,
    rateLimits: {
      limitId: "codex",
      planType: "prolite",
      primary: { usedPercent, windowDurationMins: 10080, resetsAt: RESETS_AT },
      secondary: null,
      rateLimitReachedType: null,
    },
  });
}

const REVIEW_JSON = JSON.stringify({
  verdict: "needs-attention",
  summary: "One real problem.",
  findings: [
    {
      severity: "high",
      title: "Off-by-one",
      body: "Loop skips the last item.",
      file: "src/a.ts",
      line_start: 3,
      line_end: 4,
      confidence: 0.9,
      recommendation: "Use <= instead of <.",
    },
  ],
  next_steps: ["Fix the loop."],
});

// A fake `antigravity-ide` CLI: records its argv. With FAKE_AG_MODE=claim it
// also plays the Codex Bridge extension of the window it "opens": it claims the
// request with the real bridge-core and runs the tab's command without a shell.
const FAKE_ANTIGRAVITY = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AG_LOG, JSON.stringify(args) + "\n");
if (process.env.FAKE_AG_MODE === "claim") {
  const core = require(process.env.FAKE_AG_CORE);
  const home = process.env.HOME;
  const stateDir = core.bridgeStateDir(process.env, home);
  const started = Date.now();
  const tick = () => {
    const got = core.scanRequests({ stateDir, folders: [args[0]], containDelayMs: 0 });
    for (const req of got) {
      const t = core.terminalOptions(req, core.bridgeCommand(home));
      // The IDE's environment, not the wrapper's: it may have another CODEX_HOME.
      const env = { ...process.env };
      if (process.env.FAKE_AG_CODEX_HOME) env.CODEX_HOME = process.env.FAKE_AG_CODEX_HOME;
      Object.assign(env, JSON.parse(process.env.FAKE_AG_EXTRA_ENV || "{}"));
      // An extension from before TUI mode always ran "follow".
      const argv = process.env.FAKE_AG_LEGACY ? ["follow", req.runId] : t.shellArgs;
      const child = spawn(t.shellPath, argv, { cwd: t.cwd, detached: true, stdio: "ignore", env });
      child.unref();
    }
    if (!got.length && Date.now() - started < 5000) setTimeout(tick, 50);
  };
  tick();
}
`;

interface Harness {
  repo: GateRepo;
  /** The repository root with symlinks resolved (macOS tmp is /private/var). */
  root: string;
  bin: string;
  log: string;
  /** A throwaway HOME: the bridge state dir lives under it. */
  home: string;
  /** <home>/.local/state/codex-bridge */
  bridgeState: string;
  /** Where the fake antigravity-ide records its calls. */
  agLog: string;
  run(
    args: string[],
    env?: Record<string, string>,
  ): { status: number | null; out: string; stdout: string };
  calls(): Array<{ argv: string[]; cwd: string; stdin?: string | null; query?: string }>;
  execCalls(): Array<{ argv: string[]; cwd: string; stdin?: string | null }>;
}

/** Polls until `pid` no longer exists (up to ~3 s). */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL"); // don't leak it past the test
  } catch {}
  return false;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// The fake executables are written ONCE per file and shared by every case:
// macOS may scan a freshly written executable on its first exec, and doing that
// for a new file in every case stalled whole runs. Per-case output goes to
// FAKE_CODEX_LOG / FAKE_AG_LOG in each harness's own directory.
let sharedBin: string | null = null;
function fakeBin(): string {
  if (sharedBin) return sharedBin;
  const dir = mkdtempSync(join(tmpdir(), "ccc-fake-bin-"));
  for (const [name, src] of [
    ["codex", FAKE_CODEX],
    ["antigravity-ide", FAKE_ANTIGRAVITY],
  ] as const) {
    writeFileSync(join(dir, name), `#!${process.execPath}\n${src}`);
    chmodSync(join(dir, name), 0o755);
  }
  sharedBin = dir;
  return dir;
}
afterAll(() => {
  if (sharedBin) rmSync(sharedBin, { recursive: true, force: true });
});

function harness(): Harness {
  // Runtime state and orchestrator worktrees are gitignored, as in the real repo,
  // so a run's own output never makes the checkout look dirty.
  const repo = gateRepo(SCRIPTS, {
    "src/a.ts": "export const a = 1;\n",
    ".gitignore": ".planning/codex/\n.claude/worktrees/\n",
  });
  repo.git("commit", "-q", "-m", "init");
  repo.write("src/a.ts", "export const a = 2;\n");
  repo.git("commit", "-q", "-am", "change");
  const bin = mkdtempSync(join(tmpdir(), "ccc-fake-codex-"));
  const log = join(bin, "calls.jsonl");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ccc-fake-home-")));
  // What the installer puts on PATH; the Antigravity tab runs it.
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(
    join(home, ".local", "bin", "codex-bridge"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(realpathSync(repo.root), WRAPPER)}' "$@"\n`,
    { mode: 0o755 },
  );
  cleanups.push(() => {
    repo.dispose();
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const readCalls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const agLog = join(bin, "antigravity.jsonl");
  return {
    repo,
    root: realpathSync(repo.root),
    bin,
    log,
    home,
    bridgeState: join(home, ".local", "state", "codex-bridge"),
    agLog,
    run(args, env = {}) {
      const r = spawnSync(process.execPath, [join(repo.root, WRAPPER), ...args], {
        cwd: repo.root,
        encoding: "utf8",
        timeout: 30_000,
        env: testEnv({
          PATH: `${fakeBin()}:${process.env.PATH ?? ""}`,
          HOME: home,
          FAKE_CODEX_LOG: log,
          FAKE_AG_LOG: agLog,
          FAKE_CODEX_USAGE: usageResult(),
          CCC_CODEX_KILL_GRACE_MS: "300",
          ...env,
        }),
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
    },
    calls: readCalls,
    execCalls: () => readCalls().filter((c) => c.argv[0] === "exec"),
  };
}

/**
 * The wrapper's environment: the real one minus anything that could point it
 * at the owner's own bridge state or Antigravity install.
 */
function testEnv(over: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CODEX_BRIDGE_")) delete env[k];
  delete env.XDG_STATE_HOME;
  delete env.CODEX_HOME;
  env.CODEX_BRIDGE_ANTIGRAVITY_APP = "/nonexistent/Antigravity IDE.app";
  env.CODEX_BRIDGE_CLAIM_TIMEOUT_MS = "300";
  env.FAKE_AG_CORE = join(REPO_ROOT, "scripts", "codex", "antigravity-extension", "bridge-core.js");
  if (over.HOME) env.CODEX_HOME = join(over.HOME, ".codex");
  return { ...env, ...over };
}

/**
 * Registers a cleanup that SIGKILLs every process recorded for the harness's TUI
 * runs (helper and Codex child, from the status records) and any pid files, even
 * when assertions fail, so a frozen fake never outlives its test.
 */
function reapAfter(h: Harness, pidfiles: string[] = []): void {
  // unshift: must run before the harness cleanup deletes the state files it reads.
  cleanups.unshift(() => {
    const pids: number[] = [];
    const tuiDir = join(h.bridgeState, "tui");
    if (existsSync(tuiDir)) {
      for (const f of readdirSync(tuiDir).filter((n) => n.endsWith(".json"))) {
        try {
          const st = JSON.parse(readFileSync(join(tuiDir, f), "utf8"));
          pids.push(Number(st.pid), Number(st.codexPid));
        } catch {}
      }
    }
    for (const f of pidfiles) {
      try {
        pids.push(Number(readFileSync(f, "utf8")));
      } catch {}
    }
    for (const p of pids)
      if (p > 1) {
        try {
          process.kill(p, "SIGKILL");
        } catch {}
      }
  });
}

function linkedWorktree(h: Harness): string {
  const wt = join(h.root, ".claude", "worktrees", "codex-t");
  mkdirSync(join(h.root, ".claude", "worktrees"), { recursive: true });
  h.repo.git("worktree", "add", "-q", "-b", "codex/t", wt);
  return wt;
}

function briefFile(h: Harness): string {
  const p = join(h.root, ".planning", "codex", "briefs", "t.md");
  mkdirSync(join(h.root, ".planning", "codex", "briefs"), { recursive: true });
  writeFileSync(p, "Do the thing.\n");
  return p;
}

const FORBIDDEN_TOKENS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--full-auto",
  "--approve-for-me",
  "danger-full-access",
];

describe("usage", () => {
  it("maps a healthy snapshot to status ok and discards the account id", () => {
    const h = harness();
    const r = h.run(["usage"]);
    expect(r.status).toBe(0);
    const u = JSON.parse(r.stdout);
    expect(u).toEqual({
      plan: "prolite",
      usedPercent: 12,
      resetsAt: new Date(RESETS_AT * 1000).toISOString(),
      allowed: true,
      status: "ok",
    });
    expect(r.out).not.toContain("acct-SECRET-ID");
  });

  it("uses the worst window across every bucket", () => {
    const h = harness();
    const r = h.run(["usage"], {
      FAKE_CODEX_USAGE: usageResult({
        rateLimitsByLimitId: {
          other: {
            limitId: "other",
            planType: "prolite",
            primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: RESETS_AT + 60 },
            secondary: null,
          },
        },
      }),
    });
    const u = JSON.parse(r.stdout);
    expect(u.usedPercent).toBe(85);
    expect(u.status).toBe("low");
    expect(u.resetsAt).toBe(new Date((RESETS_AT + 60) * 1000).toISOString());
  });

  it.each([
    ["79 %", usageAt(79), "ok"],
    ["80 %", usageAt(80), "low"],
    ["100 %", usageAt(100), "exhausted"],
    ["allowed=false", usageAt(5, false), "exhausted"],
    ["allowed=null", usageAt(5, null), "unavailable"],
    ["an RPC error", "error", "unavailable"],
    ["a crashed app-server", "crash", "unavailable"],
  ])("reports %s as %s", (_label, mode, status) => {
    const h = harness();
    const r = h.run(["usage"], { FAKE_CODEX_USAGE: mode });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe(status);
  });

  it("reports unavailable (never 0 %) when the app-server does not answer", () => {
    const h = harness();
    const r = h.run(["usage"], { FAKE_CODEX_USAGE: "hang", CCC_CODEX_USAGE_TIMEOUT_MS: "500" });
    const u = JSON.parse(r.stdout);
    expect(u.status).toBe("unavailable");
    expect(u.usedPercent).toBeNull();
  });

  it("only initializes and reads rate limits (never consumes a reset credit)", () => {
    const h = harness();
    const rpcLog = join(h.bin, "rpc.jsonl");
    h.run(["usage"], { FAKE_CODEX_RPC_LOG: rpcLog });
    const methods = readFileSync(rpcLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).method);
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });
});

describe("guard", () => {
  it.each([
    ["79 %", usageAt(79), 0],
    ["80 %", usageAt(80), 10],
    ["95 %", usageAt(95), 10],
    ["allowed=false", usageAt(5, false), 11],
    ["unavailable", "error", 12],
  ])("at %s exits %i", (_label, mode, code) => {
    const h = harness();
    expect(h.run(["guard"], { FAKE_CODEX_USAGE: mode }).status).toBe(code);
  });

  it("refuses dispatch before any exec call when the reserve is reached", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_USAGE: usageAt(80) });
    expect(r.status).toBe(10);
    expect(r.out).toMatch(/reserve/i);
    expect(h.execCalls()).toHaveLength(0);
  });

  it("refuses dispatch when usage is unavailable", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const r = h.run(["task", wt, briefFile(h)], { FAKE_CODEX_USAGE: "error" });
    expect(r.status).toBe(12);
    expect(h.execCalls()).toHaveLength(0);
  });
});

describe("hard refusals", () => {
  it.each([
    ["--dangerously-bypass-approvals-and-sandbox"],
    ["--dangerously-bypass-hook-trust"],
    ["--yolo"],
    ["--full-auto"],
    ["--approve-for-me"],
    ["-s", "danger-full-access"],
    ["--sandbox=danger-full-access"],
    ["-s", "workspace-write"],
    ["-c", 'sandbox_mode="danger-full-access"'],
    ["-c", "sandbox_mode=workspace-write"],
    ["--config", "approval_policy=on-request"],
    ["--config=approval_policy=never"],
    ["-c", "sandbox_workspace_write.network_access=true"],
    ["-csandbox_workspace_write.network_access=true"],
    ["-c", "network_access=true"],
    ["-c", "sandbox_workspace_write.writable_roots=['/']"],
    ["-p", "yolo"],
    ["--profile=anything"],
    ["--add-dir", "/tmp"],
    ["-C", "/tmp"],
    ["--ephemeral"],
    ["--enable", "network_proxy"],
  ])("refuses extra args %j before calling codex", (...extra) => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1", "--", ...extra]);
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/refus/i);
    expect(h.calls()).toHaveLength(0);
  });

  it("passes a harmless extra arg through", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1", "--", "--title", "wave 2"], {
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(h.execCalls()[0]?.argv).toEqual(expect.arrayContaining(["--title", "wave 2"]));
  });

  it("never passes a bypass flag itself, for any subcommand", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    h.run(["task", wt, briefFile(h)]);
    h.run(["resume", SESSION_ID]);
    const execs = h.execCalls();
    expect(execs).toHaveLength(3);
    for (const call of execs) {
      const joined = call.argv.join(" ");
      for (const bad of FORBIDDEN_TOKENS) expect(joined).not.toContain(bad);
      expect(joined).not.toMatch(/network_access=true/);
      expect(call.argv).toEqual(expect.arrayContaining(["-c", 'approval_policy="never"']));
    }
  });
});

describe("dirty checkout refusal", () => {
  it("review refuses a modified tracked file, names it, and calls nothing", () => {
    const h = harness();
    h.repo.write("src/a.ts", "export const a = 3;\n");
    const r = h.run(["review", h.root, "HEAD~1"]);
    expect(r.status).toBe(4);
    expect(r.out).toContain("src/a.ts");
    expect(h.calls()).toHaveLength(0);
  });

  it("review refuses an untracked file", () => {
    const h = harness();
    h.repo.write("notes/private.json", "{}\n");
    const r = h.run(["review", h.root, "HEAD~1"]);
    expect(r.status).toBe(4);
    expect(r.out).toContain("notes/private.json");
    expect(h.calls()).toHaveLength(0);
  });

  it("review ignores gitignored files", () => {
    const h = harness();
    h.repo.write(".planning/codex/live/old.log", "x\n");
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
  });

  it("review has no --allow-dirty escape", () => {
    const h = harness();
    h.repo.write("src/a.ts", "export const a = 3;\n");
    const r = h.run(["review", h.root, "HEAD~1", "--allow-dirty"]);
    expect(r.status).toBe(2);
    expect(h.calls()).toHaveLength(0);
  });

  it("task refuses a dirty worktree unless --allow-dirty is given", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    writeFileSync(join(wt, "scratch.txt"), "wip\n");
    const refused = h.run(["task", wt, briefFile(h)]);
    expect(refused.status).toBe(4);
    expect(refused.out).toContain("scratch.txt");
    expect(h.calls()).toHaveLength(0);
    const allowed = h.run(["task", wt, briefFile(h), "--allow-dirty"]);
    expect(allowed.status).toBe(0);
    expect(h.execCalls()).toHaveLength(1);
  });
});

describe("review", () => {
  it("runs exec review read-only in the worktree and writes json + md reports", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
    const [call] = h.execCalls();
    expect(call?.argv.slice(0, 2)).toEqual(["exec", "review"]);
    expect(call?.argv).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="read-only"']));
    expect(call?.argv).toEqual(expect.arrayContaining(["-m", "gpt-6.1-sol"]));
    expect(call?.argv).toEqual(
      expect.arrayContaining(["-c", 'model_reasoning_effort="high"', "--json"]),
    );
    expect(call?.argv).toContain("--base");
    // Saved to Codex's own history so the owner can open it with `codex resume`.
    expect(call?.argv).not.toContain("--ephemeral");
    expect(call?.cwd).toBe(h.root);

    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    expect(out.status).toBe("ok");
    expect(out.report).toMatch(/^\.planning\/codex\/reports\/.+-review\.json$/);
    const report = JSON.parse(readFileSync(join(h.root, out.report), "utf8"));
    expect(report.verdict).toBe("needs-attention");
    expect(report.advisory).toBe(true);
    expect(report).toHaveProperty("sessionId");
    expect(report.review.findings).toHaveLength(1);
    const md = readFileSync(join(h.root, out.report.replace(/\.json$/, ".md")), "utf8");
    expect(md).toContain("Off-by-one");
    expect(md).toContain("BLOCKER candidate");
  });

  it("parses Codex's native review text when the output schema is not honoured", () => {
    const h = harness();
    const native = [
      "The interruption path can leave descendants running.",
      "",
      "Review comment:",
      "",
      `- [P2] Complete cleanup before resolving — ${h.root}/src/a.ts:3-4`,
      "  When SIGINT arrives the group is not killed.",
      "  Track interruption state.",
      "- [P1] Second issue — src/a.ts:1",
      "  Body two.",
    ].join("\n");
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: native });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    const report = JSON.parse(readFileSync(join(h.root, out.report), "utf8"));
    expect(report.status).toBe("ok");
    expect(report.format).toBe("native-text");
    expect(report.verdict).toBe("needs-attention");
    expect(report.review.findings).toEqual([
      expect.objectContaining({
        severity: "medium",
        title: "Complete cleanup before resolving",
        file: "src/a.ts",
        line_start: 3,
        line_end: 4,
        body: "When SIGINT arrives the group is not killed.\nTrack interruption state.",
      }),
      expect.objectContaining({ severity: "high", file: "src/a.ts", line_start: 1, line_end: 1 }),
    ]);
    expect(report.text).toBe(native);
  });

  it("keeps unstructured review text instead of dropping it", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: "Looks fine to me." });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    const report = JSON.parse(readFileSync(join(h.root, out.report), "utf8"));
    expect(report.status).toBe("unstructured");
    expect(report.text).toBe("Looks fine to me.");
  });

  it("rejects a base ref that does not resolve", () => {
    const h = harness();
    const r = h.run(["review", h.root, "no-such-ref"]);
    expect(r.status).toBe(2);
    expect(h.execCalls()).toHaveLength(0);
  });

  it("rejects a directory that is not a git worktree", () => {
    const h = harness();
    const other = mkdtempSync(join(tmpdir(), "ccc-not-a-repo-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    const r = h.run(["review", other, "HEAD~1"]);
    expect(r.status).toBe(2);
  });

  it("writes an unavailable report and exits 22 when codex fails", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_EXEC: "fail" });
    expect(r.status).toBe(22);
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    const report = JSON.parse(readFileSync(join(h.root, out.report), "utf8"));
    expect(report.status).toBe("unavailable");
  });
});

describe("task", () => {
  it("runs workspace-write in the worktree, not ephemeral, brief on stdin, and records the session", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const r = h.run(["task", wt, briefFile(h)]);
    expect(r.status).toBe(0);
    const [call] = h.execCalls();
    expect(call?.argv[0]).toBe("exec");
    expect(call?.argv).toEqual(expect.arrayContaining(["-s", "workspace-write", "-C", wt]));
    expect(call?.argv).toEqual(
      expect.arrayContaining(["-c", "sandbox_workspace_write.network_access=false"]),
    );
    expect(call?.argv).toEqual(expect.arrayContaining(["-m", "gpt-6.1-sol"]));
    expect(call?.argv).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="medium"']));
    expect(call?.argv).not.toContain("--ephemeral");
    expect(call?.argv[call.argv.length - 1]).toBe("-");
    expect(call?.stdin).toBe("Do the thing.\n");

    const sessions = join(h.root, ".planning", "codex", "sessions");
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    expect(out.sessionId).toBe(SESSION_ID);
    const rec = JSON.parse(readFileSync(join(sessions, `${out.runId}.json`), "utf8"));
    expect(rec.sessionId).toBe(SESSION_ID);
    expect(rec.worktree).toBe(".claude/worktrees/codex-t");
  });

  it.each([
    ["chore", "gpt-6-luna", "low"],
    ["plan", "gpt-6.1-sol", "high"],
  ])("role %s uses %s at %s effort", (role, model, effort) => {
    const h = harness();
    const wt = linkedWorktree(h);
    expect(h.run(["task", wt, briefFile(h), "--role", role]).status).toBe(0);
    const [call] = h.execCalls();
    expect(call?.argv).toEqual(expect.arrayContaining(["-m", model]));
    expect(call?.argv).toEqual(
      expect.arrayContaining(["-c", `model_reasoning_effort="${effort}"`]),
    );
    if (role === "plan") expect(call?.argv).toEqual(expect.arrayContaining(["-s", "read-only"]));
  });

  it("refuses to write in the main checkout", () => {
    const h = harness();
    const r = h.run(["task", h.root, briefFile(h)]);
    expect(r.status).toBe(2);
    expect(h.execCalls()).toHaveLength(0);
  });

  it("on a usage-limit hit records a pending resume and exits 20", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const r = h.run(["task", wt, briefFile(h)], { FAKE_CODEX_EXEC: "limit" });
    expect(r.status).toBe(20);
    const pending = JSON.parse(
      readFileSync(join(h.root, ".planning", "codex", "pending-resume.json"), "utf8"),
    );
    expect(pending.sessionId).toBe(SESSION_ID);
    expect(pending.resetsAt).toBe(new Date(RESETS_AT * 1000).toISOString());
    expect(pending.worktree).toBe(".claude/worktrees/codex-t");

    // While a resume is pending, no new task is handed out.
    const again = h.run(["task", wt, briefFile(h)]);
    expect(again.status).toBe(13);
    expect(h.execCalls()).toHaveLength(1);
  });

  it("resume continues in the recorded worktree with -c sandbox pinning and clears the pending file", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    h.run(["task", wt, briefFile(h)], { FAKE_CODEX_EXEC: "limit" });
    const r = h.run(["resume", SESSION_ID]);
    expect(r.status).toBe(0);
    const call = h.execCalls()[1];
    expect(call?.argv.slice(0, 3)).toEqual(["exec", "resume", SESSION_ID]);
    expect(call?.argv).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="workspace-write"']));
    expect(call?.argv).not.toContain("-s");
    expect(call?.argv).not.toContain("--ephemeral");
    expect(call?.cwd).toBe(wt);
    expect(existsSync(join(h.root, ".planning", "codex", "pending-resume.json"))).toBe(false);
  });

  it("resume refuses a malformed session id", () => {
    const h = harness();
    expect(h.run(["resume", "../../etc; rm -rf"]).status).toBe(2);
    expect(h.execCalls()).toHaveLength(0);
  });

  it("the watchdog kills the whole process group and exits 21", async () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const pidfile = join(h.bin, "child.pid");
    const r = h.run(["task", wt, briefFile(h), "--timeout-sec", "1"], {
      FAKE_CODEX_EXEC: "hang",
      FAKE_CODEX_PIDFILE: pidfile,
    });
    expect(r.status).toBe(21);
    expect(r.out).toMatch(/timeout/i);
    const child = Number(readFileSync(pidfile, "utf8"));
    expect(await gone(child)).toBe(true);
  });
});

describe("interruption", () => {
  it("SIGTERM to the wrapper kills the whole Codex process group before exiting 130", async () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const pidfile = join(h.bin, "child.pid");
    const wrapper = spawn(process.execPath, [join(h.root, WRAPPER), "task", wt, briefFile(h)], {
      cwd: h.root,
      stdio: "ignore",
      env: testEnv({
        PATH: `${fakeBin()}:${process.env.PATH ?? ""}`,
        HOME: h.home,
        FAKE_CODEX_LOG: h.log,
        FAKE_AG_LOG: h.agLog,
        FAKE_CODEX_USAGE: usageResult(),
        FAKE_CODEX_EXEC: "hang",
        FAKE_CODEX_PIDFILE: pidfile,
        CCC_CODEX_KILL_GRACE_MS: "5000",
      }),
    });
    const exited = new Promise<number | null>((res) => wrapper.on("exit", (code) => res(code)));
    for (let i = 0; i < 100 && !existsSync(pidfile); i++)
      await new Promise((r) => setTimeout(r, 100));
    wrapper.kill("SIGTERM");
    expect(await exited).toBe(130);
    const child = Number(readFileSync(pidfile, "utf8"));
    expect(await gone(child)).toBe(true);
    const log = readFileSync(join(h.root, ".planning", "codex", "live", "current.log"), "utf8");
    expect(log).toMatch(/\[end\] interrupted by SIGTERM/);
  });
});

describe("live log", () => {
  it("writes jsonl + readable log, points current.log at the run and prints the tail hint", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const r = h.run(["task", wt, briefFile(h)]);
    expect(r.status).toBe(0);
    const live = join(h.root, ".planning", "codex", "live");
    expect(r.out).toContain(`tail -F ${join(live, "current.log")}`);
    const target = readlinkSync(join(live, "current.log"));
    expect(target).toMatch(/^[^/]+-task\.log$/);
    const log = readFileSync(join(live, target), "utf8");
    expect(log).toContain(`[session] ${SESSION_ID}`);
    expect(log).toContain("$ pnpm test");
    expect(log).toContain("[edit] update src/a.ts");
    expect(log).toContain("[message] done");
    expect(log).toMatch(/\[end\] status=ok/);
    const jsonl = readFileSync(join(live, target.replace(/\.log$/, ".jsonl")), "utf8");
    expect(jsonl.split("\n")[0]).toContain("thread.started");
  });

  it("moves current.log to the newest run", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    h.run(["task", wt, briefFile(h)]);
    const live = join(h.root, ".planning", "codex", "live");
    const first = readlinkSync(join(live, "current.log"));
    h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    const second = readlinkSync(join(live, "current.log"));
    expect(second).not.toBe(first);
    expect(second).toMatch(/-review\.log$/);
  });

  it("watch --once prints the current run and exits at its end marker", () => {
    const h = harness();
    const live = join(h.root, ".planning", "codex", "live");
    mkdirSync(live, { recursive: true });
    writeFileSync(
      join(live, "r1-task.log"),
      "12:00:00 [turn] started\n12:00:01 [end] status=ok exit=0\n",
    );
    symlinkSync("r1-task.log", join(live, "current.log"));
    const r = h.run(["watch", "--once"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[turn] started");
    expect(r.stdout).toContain("[end] status=ok");
  });

  it("watch --once gives up cleanly when there is no run", () => {
    const h = harness();
    const r = h.run(["watch", "--once", "--idle-exit-sec", "1"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/no codex run/i);
  });
});

describe("argument handling", () => {
  it("prints usage and exits 2 on an unknown subcommand", () => {
    const h = harness();
    const r = h.run(["frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/usage/i);
  });
});

// ---------------------------------------------------------------------------
// codex-bridge: project-agnostic state + the Antigravity tab

function lastJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
}

function requestFiles(h: Harness): string[] {
  const dir = join(h.bridgeState, "requests");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

function readRequest(h: Harness): Record<string, unknown> {
  const [f] = requestFiles(h);
  if (!f) throw new Error("no bridge request written");
  return JSON.parse(readFileSync(join(h.bridgeState, "requests", f), "utf8"));
}

/** Waits for the detached fake antigravity-ide to record its argv (up to ~3 s). */
async function antigravityCalls(h: Harness, expectSome = true): Promise<string[][]> {
  for (let i = 0; i < 30; i++) {
    if (existsSync(h.agLog)) break;
    if (!expectSome && i >= 5) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return existsSync(h.agLog)
    ? readFileSync(h.agLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
}

describe("project and state location", () => {
  it("keeps state in .planning/codex/ where git ignores it (this repository)", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
    expect(lastJson(r.stdout).report).toMatch(/^\.planning\/codex\/reports\//);
  });

  it("uses the user-level bridge state for a project that does not ignore .planning/codex", () => {
    const h = harness();
    h.repo.write(".gitignore", ".claude/worktrees/\n");
    h.repo.git("commit", "-q", "-am", "no codex ignore");
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
    const report = String(lastJson(r.stdout).report);
    const projects = join(h.bridgeState, "projects");
    expect(report.startsWith(`${projects}/`)).toBe(true);
    expect(report).toMatch(/\/projects\/ccc-gate-[^/]+-[0-9a-f]{10}\/reports\/.+-review\.json$/);
    expect(existsSync(report)).toBe(true);
    // The project checkout stays clean, so the next run is not refused as dirty.
    expect(h.repo.git("status", "--porcelain").trim()).toBe("");
    expect(existsSync(join(h.root, ".planning", "codex"))).toBe(false);
  });

  it("honours XDG_STATE_HOME for the bridge state", () => {
    const h = harness();
    h.repo.write(".gitignore", "");
    h.repo.git("commit", "-q", "-am", "no ignores");
    const xdg = join(h.home, "xdg");
    const r = h.run(["review", h.root, "HEAD~1"], {
      FAKE_CODEX_FINAL: REVIEW_JSON,
      XDG_STATE_HOME: xdg,
    });
    expect(r.status).toBe(0);
    expect(
      String(lastJson(r.stdout).report).startsWith(join(xdg, "codex-bridge", "projects")),
    ).toBe(true);
  });

  it("runs from an installed copy outside any git checkout, against any repository", () => {
    const h = harness();
    const install = mkdtempSync(join(tmpdir(), "ccc-codex-install-"));
    cleanups.push(() => rmSync(install, { recursive: true, force: true }));
    for (const f of SCRIPTS) {
      const to = join(install, f.replace(/^scripts\/codex\//, ""));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(h.root, f)));
    }
    const r = spawnSync(
      process.execPath,
      [join(install, "codex.mjs"), "review", h.root, "HEAD~1"],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: testEnv({
          PATH: `${fakeBin()}:${process.env.PATH ?? ""}`,
          HOME: h.home,
          FAKE_CODEX_LOG: h.log,
          FAKE_AG_LOG: h.agLog,
          FAKE_CODEX_USAGE: usageResult(),
          FAKE_CODEX_FINAL: REVIEW_JSON,
          CODEX_BRIDGE_TAB: "0",
        }),
      },
    );
    expect(r.status).toBe(0);
    expect(lastJson(r.stdout).report).toMatch(/^\.planning\/codex\/reports\//);
  });

  it("resume and watch resolve the project from the current directory", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    h.run(["task", wt, briefFile(h)]);
    const elsewhere = mkdtempSync(join(tmpdir(), "ccc-not-a-repo-"));
    cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
    const r = spawnSync(process.execPath, [join(h.root, WRAPPER), "resume", SESSION_ID], {
      cwd: elsewhere,
      encoding: "utf8",
      env: testEnv({ PATH: `${fakeBin()}:${process.env.PATH ?? ""}`, HOME: h.home }),
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/inside the project/);
  });
});

describe("antigravity tab", () => {
  it("queues a validated tab request when the review session starts and opens the project", async () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/antigravity tab requested: Codex · review · \d{6}/);
    const req = readRequest(h);
    const out = lastJson(r.stdout);
    expect(req).toMatchObject({
      runId: out.runId,
      kind: "review",
      projectRoot: h.root,
      cwd: h.root,
      sessionId: SESSION_ID,
      liveLog: join(h.root, String(out.liveLog)),
    });
    expect(bridgeCore.validateRequest(req, { stateDir: h.bridgeState }).ok).toBe(true);
    // No Antigravity window heartbeat covers the project, so the CLI opens it.
    expect(await antigravityCalls(h)).toEqual([[h.root]]);
  });

  it("does not launch Antigravity when a live window already has the project open", async () => {
    const h = harness();
    bridgeCore.ensureDirs(h.bridgeState);
    bridgeCore.writeHeartbeat(h.bridgeState, "4242", [h.root]);
    expect(h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON }).status).toBe(0);
    expect(requestFiles(h)).toHaveLength(1);
    expect(await antigravityCalls(h, false)).toEqual([]);
  });

  it("queues task runs with the worktree as the tab's directory", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    expect(h.run(["task", wt, briefFile(h)]).status).toBe(0);
    const req = readRequest(h);
    expect(req).toMatchObject({ kind: "task", projectRoot: h.root, cwd: wt });
  });

  it("CODEX_BRIDGE_TAB=0 opts out entirely", async () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      FAKE_CODEX_FINAL: REVIEW_JSON,
      CODEX_BRIDGE_TAB: "0",
    });
    expect(r.status).toBe(0);
    expect(requestFiles(h)).toEqual([]);
    expect(await antigravityCalls(h, false)).toEqual([]);
  });

  it("is a no-op when Antigravity is not installed", () => {
    const h = harness();
    const bare = mkdtempSync(join(tmpdir(), "ccc-bin-"));
    cleanups.push(() => rmSync(bare, { recursive: true, force: true }));
    symlinkSync(join(fakeBin(), "codex"), join(bare, "codex"));
    const r = h.run(["review", h.root, "HEAD~1"], {
      FAKE_CODEX_FINAL: REVIEW_JSON,
      PATH: `${bare}:${process.env.PATH ?? ""}`,
    });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/antigravity tab/);
    expect(requestFiles(h)).toEqual([]);
  });

  it("never fails the Codex run when the tab request cannot be written", () => {
    const h = harness();
    mkdirSync(h.bridgeState, { recursive: true });
    writeFileSync(join(h.bridgeState, "requests"), "not a directory\n");
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/antigravity tab skipped/);
    expect(lastJson(r.stdout).status).toBe("ok");
  });
});

describe("follow", () => {
  function claimedRun(h: Harness, over: Record<string, unknown> = {}): string {
    const live = join(h.root, ".planning", "codex", "live");
    mkdirSync(live, { recursive: true });
    const runId = "20260930T120000000Z";
    writeFileSync(
      join(live, `${runId}-review.log`),
      `12:00:00 [session] ${SESSION_ID}\n12:00:01 [message] looks fine\n12:00:02 [end] status=ok exit=0\n`,
    );
    bridgeCore.ensureDirs(h.bridgeState);
    writeFileSync(
      join(h.bridgeState, "claimed", `${runId}.json`),
      JSON.stringify({
        runId,
        kind: "review",
        projectRoot: h.root,
        cwd: h.root,
        sessionId: SESSION_ID,
        liveLog: join(live, `${runId}-review.log`),
        pid: null,
        createdAt: new Date().toISOString(),
        ...over,
      }),
    );
    return runId;
  }

  it("prints the live log to its end marker, then runs codex resume <session> in the project", () => {
    const h = harness();
    const runId = claimedRun(h);
    const r = h.run(["follow", runId], { CODEX_BRIDGE_FOLLOW_SHELL: "0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[message] looks fine");
    expect(r.stdout).toContain(`codex resume ${SESSION_ID}`);
    const calls = h.calls().filter((c) => c.argv[0] === "resume");
    expect(calls).toEqual([expect.objectContaining({ argv: ["resume", SESSION_ID], cwd: h.root })]);
  });

  it("takes the session id from the log when the request had none", () => {
    const h = harness();
    const runId = claimedRun(h, { sessionId: null });
    expect(h.run(["follow", runId], { CODEX_BRIDGE_FOLLOW_SHELL: "0" }).status).toBe(0);
    expect(h.calls().filter((c) => c.argv[0] === "resume")[0]?.argv).toEqual([
      "resume",
      SESSION_ID,
    ]);
  });

  it.each([
    ["a malformed run id", "../../etc/passwd"],
    ["an unclaimed run id", "20260930T235959999Z"],
  ])("refuses %s and runs nothing", (_label, runId) => {
    const h = harness();
    claimedRun(h);
    const r = h.run(["follow", runId], { CODEX_BRIDGE_FOLLOW_SHELL: "0" });
    expect(r.status).toBe(2);
    expect(h.calls()).toHaveLength(0);
  });

  it("refuses a claimed request whose live log is outside the allowed dirs", () => {
    const h = harness();
    const stray = join(h.home, "stray.log");
    writeFileSync(stray, "[end] x\n");
    const runId = claimedRun(h, { liveLog: stray });
    const r = h.run(["follow", runId], { CODEX_BRIDGE_FOLLOW_SHELL: "0" });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/liveLog/);
    expect(h.calls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TUI mode: the interactive Codex in the Antigravity tab is the worker

describe("tui in the antigravity tab", () => {
  const CLAIM = { FAKE_AG_MODE: "claim", CODEX_BRIDGE_CLAIM_TIMEOUT_MS: "8000" };
  const tuiCalls = (h: Harness) => h.calls().filter((c) => c.argv.includes("--ask-for-approval"));

  it("runs the review in the TUI with pinned flags, finds the session by marker, and reports", () => {
    const h = harness();
    const fenced = `Summary first.\n\n\`\`\`json\n${REVIEW_JSON}\n\`\`\`\n`;
    const r = h.run(["review", h.root, "HEAD~1"], { ...CLAIM, FAKE_CODEX_FINAL: fenced });
    expect(r.status).toBe(0);
    expect(h.execCalls()).toHaveLength(0);
    const [call] = tuiCalls(h);
    expect(call?.argv).toEqual(
      expect.arrayContaining(["--ask-for-approval", "never", "-s", "read-only", "-C", h.root]),
    );
    expect(call?.argv).toEqual(expect.arrayContaining(["-m", "gpt-6.1-sol"]));
    expect(call?.argv).toEqual(expect.arrayContaining(["-c", 'approval_policy="never"']));
    const joined = call?.argv.join(" ") ?? "";
    for (const bad of FORBIDDEN_TOKENS) expect(joined).not.toContain(bad);
    const out = lastJson(r.stdout);
    const prompt = call?.argv.at(-1) ?? "";
    expect(prompt).toContain(`codex-bridge run ${out.runId}`);
    expect(prompt).toMatch(/git diff [0-9a-f]{40}\.\.\.HEAD/);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report).toMatchObject({
      status: "ok",
      verdict: "needs-attention",
      sessionId: SESSION_ID,
    });
    expect(report.mode).toBe("tui");
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain(`[session] ${SESSION_ID}`);
    expect(log).toMatch(/\[end\] status=ok/);
  });

  it("runs a task in the TUI with the brief and workspace-write, recording the session", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const r = h.run(["task", wt, briefFile(h)], CLAIM);
    expect(r.status).toBe(0);
    const [call] = tuiCalls(h);
    expect(call?.argv).toEqual(expect.arrayContaining(["-s", "workspace-write", "-C", wt]));
    expect(call?.argv.at(-1)).toContain("Do the thing.");
    expect(call?.cwd).toBe(wt);
    const out = lastJson(r.stdout);
    expect(out.sessionId).toBe(SESSION_ID);
    const rec = JSON.parse(
      readFileSync(join(h.root, ".planning", "codex", "sessions", `${out.runId}.json`), "utf8"),
    );
    expect(rec).toMatchObject({ sessionId: SESSION_ID, status: "ok" });
  });

  it("ignores a rollout whose prompt lacks this run's marker", () => {
    const h = harness();
    // A foreign session started at the same time must not be picked up.
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const dir = join(
      h.home,
      ".codex",
      "sessions",
      `${d.getFullYear()}`,
      p2(d.getMonth() + 1),
      p2(d.getDate()),
    );
    mkdirSync(dir, { recursive: true });
    const other = "99999999-8888-7777-6666-555555555555";
    writeFileSync(
      join(dir, `rollout-other-${other}.jsonl`),
      [
        { type: "session_meta", payload: { id: other } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "codex-bridge run 20000101T000000000Z" }],
          },
        },
        { type: "event_msg", payload: { type: "task_complete", last_agent_message: "wrong" } },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n"),
    );
    const r = h.run(["review", h.root, "HEAD~1"], { ...CLAIM, FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
    expect(lastJson(r.stdout).verdict).toBe("needs-attention");
    const out = lastJson(r.stdout);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report.sessionId).toBe(SESSION_ID);
  });

  it("falls back to headless exec when no window claims the tab in time", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], { FAKE_CODEX_FINAL: REVIEW_JSON });
    expect(r.status).toBe(0);
    expect(tuiCalls(h)).toHaveLength(0);
    expect(h.execCalls()).toHaveLength(1);
    expect(r.out).toMatch(/no Antigravity window claimed the tab/);
  });

  it("falls back to headless exec when the TUI fails to start", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      FAKE_CODEX_TUI: "crash",
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(tuiCalls(h)).toHaveLength(1);
    expect(h.execCalls()).toHaveLength(1);
    const log = readFileSync(join(h.root, String(lastJson(r.stdout).liveLog)), "utf8");
    expect(log).toContain("[tui] codex exited with code 2: error: unexpected argument");
  });

  it.each([
    ["CODEX_BRIDGE_TAB=0", { CODEX_BRIDGE_TAB: "0" }],
    ["CODEX_BRIDGE_TUI=0", { CODEX_BRIDGE_TUI: "0" }],
  ])("%s keeps the headless path", (_l, env) => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      ...env,
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(tuiCalls(h)).toHaveLength(0);
    expect(h.execCalls()).toHaveLength(1);
  });

  it("refuses bypass extras before any tab or codex call", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1", "--", "--yolo"], CLAIM);
    expect(r.status).toBe(3);
    expect(h.calls()).toHaveLength(0);
    expect(requestFiles(h)).toEqual([]);
  });

  it("a usage-limit hit in the TUI records a pending resume and exits 20", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const r = h.run(["task", wt, briefFile(h)], { ...CLAIM, FAKE_CODEX_TUI: "limit" });
    expect(r.status).toBe(20);
    const pending = JSON.parse(
      readFileSync(join(h.root, ".planning", "codex", "pending-resume.json"), "utf8"),
    );
    expect(pending.sessionId).toBe(SESSION_ID);
  });

  it("the watchdog stops a TUI run that never completes and exits 21", async () => {
    const h = harness();
    const pidfile = join(h.bin, "tui.pid");
    const r = h.run(["review", h.root, "HEAD~1", "--timeout-sec", "2"], {
      ...CLAIM,
      FAKE_CODEX_TUI: "hang",
      FAKE_CODEX_PIDFILE: pidfile,
    });
    expect(r.status).toBe(21);
    const pid = Number(readFileSync(pidfile, "utf8"));
    expect(await gone(pid)).toBe(true);
  });
});

describe("tui: trust, withdrawal and cleanup", () => {
  const CLAIM = { FAKE_AG_MODE: "claim", CODEX_BRIDGE_CLAIM_TIMEOUT_MS: "8000" };
  const tuiCalls = (h: Harness) => h.calls().filter((c) => c.argv.includes("--ask-for-approval"));

  it("trusts exactly the run's worktree and project for this run, with sandbox and approvals still pinned", () => {
    const h = harness();
    expect(
      h.run(["review", h.root, "HEAD~1"], { ...CLAIM, FAKE_CODEX_FINAL: REVIEW_JSON }).status,
    ).toBe(0);
    const argv = tuiCalls(h)[0]?.argv ?? [];
    const i = argv.findIndex((a) => a.startsWith("projects="));
    expect(argv[i - 1]).toBe("-c");
    expect(argv[i]).toBe(`projects={${JSON.stringify(h.root)}={trust_level="trusted"}}`);
    expect(argv).toEqual(
      expect.arrayContaining(["-s", "read-only", "--ask-for-approval", "never"]),
    );
    // The owner's MCP servers, plugins, hooks and notify stay out of the worker.
    expect(argv).toEqual(
      expect.arrayContaining(["-c", "mcp_servers.pencil.enabled=false", "-c", "notify=[]"]),
    );
    expect(argv).toEqual(expect.arrayContaining(["-c", "mcp_servers.computer-use.enabled=false"]));
    expect(argv).toEqual(
      expect.arrayContaining(["-c", "features.plugins=false", "-c", "features.hooks=false"]),
    );
    expect(argv).not.toContain("--ignore-user-config");
  });

  it("stops a TUI that shows no session in time (e.g. a trust prompt) and falls back headless", async () => {
    const h = harness();
    const pidfile = join(h.bin, "prompt.pid");
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_SESSION_WAIT_MS: "1500",
      FAKE_CODEX_TUI: "prompt",
      FAKE_CODEX_PIDFILE: pidfile,
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(h.execCalls()).toHaveLength(1);
    // The waiting TUI is gone, so a late answer cannot start a duplicate run.
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
  });

  it("falls back headless when the TUI creates a session but never starts a turn", async () => {
    const h = harness();
    const pidfile = join(h.bin, "silent.pid");
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_FIRST_ACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "silent",
      FAKE_CODEX_PIDFILE: pidfile,
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(h.execCalls()).toHaveLength(1);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    const out = lastJson(r.stdout);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain("[tui] no activity within 1.5s — falling back to headless");
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report.status).toBe("ok");
    expect(report.mode).toBe("headless");
    expect(report.fallback).toMatchObject({
      from: "tui",
      to: "headless",
      reason: "no-first-activity",
    });
  });

  it("does not fall back when the first turn starts just inside the window", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_FIRST_ACTIVITY_MS: "4000",
      FAKE_CODEX_FIRST_TURN_DELAY_MS: "1500",
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(h.execCalls()).toHaveLength(0);
    const out = lastJson(r.stdout);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report.mode).toBe("tui");
    expect(report.fallback).toBeUndefined();
  });

  it("resumes the TUI session headless when a running turn goes silent (task)", async () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const pidfile = join(h.bin, "stall.pid");
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_PIDFILE: pidfile,
    });
    expect(r.status).toBe(0);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    // The known session is resumed, not restarted, still with pinned flags.
    const [exec] = h.execCalls();
    expect(h.execCalls()).toHaveLength(1);
    expect(exec?.argv.slice(0, 3)).toEqual(["exec", "resume", SESSION_ID]);
    expect(exec?.argv).toEqual(expect.arrayContaining(["-c", 'approval_policy="never"']));
    const joined = exec?.argv.join(" ") ?? "";
    for (const bad of FORBIDDEN_TOKENS) expect(joined).not.toContain(bad);
    const out = lastJson(r.stdout);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain(
      `[tui] no activity for 1.5s mid-run — resuming session ${SESSION_ID} headless`,
    );
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report).toMatchObject({ status: "ok", mode: "headless", sessionId: SESSION_ID });
    expect(report.fallback).toMatchObject({
      from: "tui",
      to: "headless",
      reason: "mid-run-inactivity",
      tuiSessionId: SESSION_ID,
      windowSec: 1.5,
    });
  });

  it("resumes a stalled review read-only and still reports it", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    const [exec] = h.execCalls();
    expect(exec?.argv.slice(0, 3)).toEqual(["exec", "resume", SESSION_ID]);
    expect(exec?.argv).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="read-only"']));
    expect(exec?.argv.join(" ")).not.toContain("workspace-write");
    const out = lastJson(r.stdout);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report).toMatchObject({ status: "ok", mode: "headless", verdict: "needs-attention" });
    expect(report.fallback).toMatchObject({ reason: "mid-run-inactivity" });
  });

  it("does not fall back while a running turn keeps inside the inactivity window", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "6000",
      FAKE_CODEX_MID_DELAY_MS: "1500",
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(h.execCalls()).toHaveLength(0);
    const out = lastJson(r.stdout);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report.mode).toBe("tui");
    expect(report.fallback).toBeUndefined();
  });

  it("fails with the failed exit code and a clear message when the stalled session cannot be resumed", async () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const pidfile = join(h.bin, "nosid.pid");
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall-nosid",
      FAKE_CODEX_PIDFILE: pidfile,
    });
    expect(r.status).toBe(22);
    expect(h.execCalls()).toHaveLength(0);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    const out = lastJson(r.stdout);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain("no session id to resume");
    expect(out.status).toBe("failed");
  });

  it("keeps one run deadline: the resumed headless run only gets the remaining budget", () => {
    const h = harness();
    const t0 = Date.now();
    const r = h.run(["review", h.root, "HEAD~1", "--timeout-sec", "5"], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_EXEC: "hang",
      FAKE_CODEX_PIDFILE: join(h.bin, "hang.pid"),
    });
    const elapsed = (Date.now() - t0) / 1000;
    expect(r.status).toBe(21);
    const out = lastJson(r.stdout);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    const m = log.match(/\[watchdog\] timeout after ([0-9.]+)s — killing the Codex process group/);
    // 5 s budget minus the ~1.5 s already spent before the stall was detected.
    expect(Number(m?.[1])).toBeLessThan(4);
    expect(Number(m?.[1])).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5 + 1.5);
  });

  it("rechecks the usage reserve before an automatic resume and keeps the session id", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const usageFile = join(h.bin, "usage.json");
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_USAGE_FILE: usageFile,
      FAKE_CODEX_USAGE_AFTER: usageAt(85),
    });
    expect(r.status).toBe(10);
    expect(h.execCalls()).toHaveLength(0);
    const out = lastJson(r.stdout);
    expect(out.sessionId).toBe(SESSION_ID);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain(`not resuming session ${SESSION_ID}`);
    expect(log).toContain(`codex-bridge resume ${SESSION_ID}`);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report).toMatchObject({ status: "refused", sessionId: SESSION_ID });
  });

  it("rechecks the usage reserve before a review resume too", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_USAGE_FILE: join(h.bin, "usage.json"),
      FAKE_CODEX_USAGE_AFTER: usageAt(85),
    });
    expect(r.status).toBe(10);
    expect(h.execCalls()).toHaveLength(0);
    const out = lastJson(r.stdout);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report).toMatchObject({ status: "refused", sessionId: SESSION_ID });
  });

  it("bounds the usage recheck by the run deadline: a slow check cannot push the resume past it", () => {
    const h = harness();
    const t0 = Date.now();
    const r = h.run(["review", h.root, "HEAD~1", "--timeout-sec", "4"], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_USAGE_FILE: join(h.bin, "usage.json"),
      FAKE_CODEX_USAGE_AFTER: usageResult(),
      FAKE_CODEX_USAGE_DELAY_MS: "6000",
    });
    expect(r.status).toBe(21);
    expect(h.execCalls()).toHaveLength(0);
    expect((Date.now() - t0) / 1000).toBeLessThan(4 + 1.5);
    const out = lastJson(r.stdout);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain(`nothing left to resume session ${SESSION_ID}`);
  });

  it("keeps the saved session id when the resumed child dies before announcing a thread", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_EXEC: "early",
    });
    expect(r.status).toBe(22);
    const out = lastJson(r.stdout);
    expect(out.sessionId).toBe(SESSION_ID);
    const rec = JSON.parse(
      readFileSync(join(h.root, ".planning", "codex", "sessions", `${out.runId}.json`), "utf8"),
    );
    expect(rec).toMatchObject({ sessionId: SESSION_ID, status: "failed" });
  });

  it("a refused review tells the owner how to recover, not a task-only resume command", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_USAGE_FILE: join(h.bin, "usage.json"),
      FAKE_CODEX_USAGE_AFTER: usageAt(85),
    });
    const out = lastJson(r.stdout);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain("codex-bridge review");
    expect(log).toContain(`codex resume ${SESSION_ID}`);
    expect(log).not.toContain(`codex-bridge resume ${SESSION_ID}`);
  });

  it("keeps a stalled review's session id in the report when the resumed child dies early", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_EXEC: "early",
    });
    expect(r.status).toBe(22);
    const out = lastJson(r.stdout);
    const report = JSON.parse(readFileSync(join(h.root, String(out.report)), "utf8"));
    expect(report.sessionId).toBe(SESSION_ID);
    const md = readFileSync(join(h.root, String(out.markdown)), "utf8");
    expect(md).toContain(`codex resume ${SESSION_ID}`);
  });

  it("never resumes while the old TUI tree is alive: it escalates, verifies, then resumes", async () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const pidfile = join(h.bin, "stubborn.pid");
    reapAfter(h, [pidfile]);
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_STUBBORN: "1",
      FAKE_CODEX_PIDFILE: pidfile,
      FAKE_CODEX_TUI_PIDFILE: pidfile,
    });
    expect(r.status).toBe(0);
    const calls = h.execCalls() as Array<{ argv: string[]; tuiAliveAtResume?: boolean }>;
    const seen = calls.filter((c) => c.tuiAliveAtResume !== undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tuiAliveAtResume).toBe(false);
    expect(calls[0]?.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
  }, 60_000);

  it("fails with exit 22 and no exec when the old TUI tree cannot be confirmed gone", async () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const pidfile = join(h.bin, "stubborn2.pid");
    reapAfter(h, [pidfile]);
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_STUBBORN: "1",
      FAKE_CODEX_PIDFILE: pidfile,
      CODEX_BRIDGE_TEST_NO_ESCALATE: "1",
    });
    expect(r.status).toBe(22);
    expect(h.execCalls()).toHaveLength(0);
    const out = lastJson(r.stdout);
    expect(out.sessionId).toBe(SESSION_ID);
    const log = readFileSync(join(h.root, String(out.liveLog)), "utf8");
    expect(log).toContain(`not resuming session ${SESSION_ID}`);
  }, 60_000);

  it("kills a subprocess spawned during SIGTERM handling before resuming", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const orphan = join(h.bin, "orphan.pid");
    reapAfter(h, [orphan]);
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_ORPHAN_PIDFILE: orphan,
    });
    expect(r.status).toBe(0);
    const calls = h.execCalls() as Array<{ orphanAliveAtResume?: boolean }>;
    const seen = calls.filter((c) => c.orphanAliveAtResume !== undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.orphanAliveAtResume).toBe(false);
  }, 60_000);

  it("exits 22 without resuming when a SIGTERM-spawned subprocess survives and escalation is off", () => {
    const h = harness();
    const wt = linkedWorktree(h);
    const orphan = join(h.bin, "orphan2.pid");
    reapAfter(h, [orphan]);
    const r = h.run(["task", wt, briefFile(h)], {
      ...CLAIM,
      CODEX_BRIDGE_INACTIVITY_MS: "1500",
      FAKE_CODEX_TUI: "stall",
      FAKE_CODEX_ORPHAN_PIDFILE: orphan,
      CODEX_BRIDGE_TEST_NO_ESCALATE: "1",
    });
    expect(r.status).toBe(22);
    expect(h.execCalls()).toHaveLength(0);
    expect(lastJson(r.stdout).sessionId).toBe(SESSION_ID);
  }, 60_000);

  it("withdraws the queued request when interrupted during the claim wait (finding 1)", async () => {
    const h = harness();
    const wrapper = spawn(process.execPath, [join(h.root, WRAPPER), "review", h.root, "HEAD~1"], {
      cwd: h.root,
      stdio: "ignore",
      env: testEnv({
        PATH: `${fakeBin()}:${process.env.PATH ?? ""}`,
        HOME: h.home,
        FAKE_CODEX_LOG: h.log,
        FAKE_AG_LOG: h.agLog,
        FAKE_CODEX_USAGE: usageResult(),
        CODEX_BRIDGE_CLAIM_TIMEOUT_MS: "20000",
      }),
    });
    const exited = new Promise<number | null>((res) => wrapper.on("exit", (code) => res(code)));
    for (let i = 0; i < 100 && requestFiles(h).length === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(requestFiles(h)).toHaveLength(1);
    wrapper.kill("SIGTERM");
    expect(await exited).toBe(130);
    expect(requestFiles(h)).toEqual([]);
    expect(readdirSync(join(h.bridgeState, "prompts"))).toEqual([]);
    expect(h.calls().filter((c) => c.argv[0] !== "app-server" && !c.query)).toHaveLength(0);
  });

  it("the watchdog kills the whole TUI worker tree before reporting (finding 2)", async () => {
    const h = harness();
    const pidfile = join(h.bin, "tui.pid");
    const childPidfile = join(h.bin, "tool.pid");
    const r = h.run(["review", h.root, "HEAD~1", "--timeout-sec", "2"], {
      ...CLAIM,
      FAKE_CODEX_TUI: "hang",
      FAKE_CODEX_PIDFILE: pidfile,
      FAKE_CODEX_CHILD_PIDFILE: childPidfile,
    });
    expect(r.status).toBe(21);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    expect(await gone(Number(readFileSync(childPidfile, "utf8")))).toBe(true);
  });

  it("runs the TUI with the wrapper's CODEX_HOME even if the IDE has another (finding 3)", () => {
    const h = harness();
    const ideHome = join(h.home, "ide-codex-home");
    mkdirSync(ideHome);
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      FAKE_AG_CODEX_HOME: ideHome,
      FAKE_CODEX_FINAL: REVIEW_JSON,
      CODEX_BRIDGE_SESSION_WAIT_MS: "4000",
    });
    expect(r.status).toBe(0);
    const [call] = tuiCalls(h) as Array<{ codexHome?: string }>;
    expect(call?.codexHome).toBe(join(h.home, ".codex"));
    expect(h.execCalls()).toHaveLength(0);
  });
});

describe("project resolution edge cases", () => {
  it("finds the main checkout of a repo with a separate git dir (finding 4)", () => {
    const h = harness();
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "ccc-sepwt-")));
    const gd = realpathSync(mkdtempSync(join(tmpdir(), "ccc-sepgd-")));
    cleanups.push(() => {
      rmSync(wt, { recursive: true, force: true });
      rmSync(gd, { recursive: true, force: true });
    });
    const g = (...a: string[]) => {
      const r = spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    spawnSync("git", ["init", "-q", "--separate-git-dir", join(gd, "meta"), wt]);
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    g("config", "core.fsmonitor", "false");
    writeFileSync(join(wt, "a.txt"), "1\n");
    g("add", "a.txt");
    g("commit", "-q", "-m", "one");
    writeFileSync(join(wt, "a.txt"), "2\n");
    g("commit", "-q", "-am", "two");
    const r = h.run(["review", wt, "HEAD~1"], {
      FAKE_CODEX_FINAL: REVIEW_JSON,
      CODEX_BRIDGE_TAB: "0",
    });
    expect(r.status).toBe(0);
    const report = String(lastJson(r.stdout).report);
    expect(report).toMatch(/\/projects\/ccc-sepwt-[^/]+-[0-9a-f]{10}\/reports\//);
  });

  it("uses the external state dir unless every runtime artifact is ignored (finding 5)", () => {
    const h = harness();
    h.repo.write(".gitignore", ".planning/codex/reports/\n.claude/worktrees/\n");
    h.repo.git("commit", "-q", "-am", "ignore only reports");
    const r = h.run(["review", h.root, "HEAD~1"], {
      FAKE_CODEX_FINAL: REVIEW_JSON,
      CODEX_BRIDGE_TAB: "0",
    });
    expect(r.status).toBe(0);
    expect(String(lastJson(r.stdout).report).startsWith(join(h.bridgeState, "projects"))).toBe(
      true,
    );
    expect(h.repo.git("status", "--porcelain").trim()).toBe("");
  });
});

describe("tui with an older extension", () => {
  it("a window whose extension still runs `follow` gets the interactive Codex too", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      FAKE_AG_MODE: "claim",
      FAKE_AG_LEGACY: "1",
      CODEX_BRIDGE_CLAIM_TIMEOUT_MS: "8000",
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(h.calls().filter((c) => c.argv.includes("--ask-for-approval"))).toHaveLength(1);
    expect(h.execCalls()).toHaveLength(0);
  });
});

describe("tui isolation from the owner's Codex config", () => {
  const CLAIM = { FAKE_AG_MODE: "claim", CODEX_BRIDGE_CLAIM_TIMEOUT_MS: "8000" };
  const tuiCalls = (h: Harness) => h.calls().filter((c) => c.argv.includes("--ask-for-approval"));
  const liveLog = (h: Harness, stdout: string) =>
    readFileSync(join(h.root, String(lastJson(stdout).liveLog)), "utf8");

  it("disables every resolved MCP server by name, verifies it, and logs the check", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      FAKE_CODEX_FINAL: REVIEW_JSON,
      FAKE_CODEX_MCP: JSON.stringify([
        { name: "pencil", enabled: true },
        { name: "node_repl", enabled: true },
        { name: "computer-use", enabled: false },
      ]),
    });
    expect(r.status).toBe(0);
    const argv = tuiCalls(h)[0]?.argv ?? [];
    for (const n of ["pencil", "node_repl", "computer-use"])
      expect(argv).toEqual(expect.arrayContaining(["-c", `mcp_servers.${n}.enabled=false`]));
    expect(liveLog(h, r.stdout)).toContain("[tui] isolation ok: 3 MCP servers, 0 enabled");
    // The helper re-checks right before launching, so the listing ran twice per side.
    expect(h.calls().filter((c) => c.query === "mcp").length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    [
      "a server that ignores the disable",
      { FAKE_CODEX_MCP: '[{"name":"pencil","enabled":true,"sticky":true}]' },
      /MCP servers still enabled: pencil/,
    ],
    ["a failing MCP listing", { FAKE_CODEX_MCP: "fail" }, /could not list MCP servers/],
    [
      "a server name an override cannot address",
      { FAKE_CODEX_MCP: '[{"name":"a.b","enabled":true}]' },
      /cannot be disabled/,
    ],
    [
      "plugins that stay enabled",
      { FAKE_CODEX_STICKY_FEATURES: "plugins" },
      /features still enabled: plugins/,
    ],
    [
      "an unverifiable feature list",
      { FAKE_CODEX_FEATURES: "memories stable false\n" },
      /cannot verify features: hooks, plugins/,
    ],
  ])("fails closed to headless on %s", (_l, env, reason) => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      ...env,
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(tuiCalls(h)).toHaveLength(0);
    // Only the headless run's follow tab may be queued, never a TUI request.
    expect(requestFiles(h).length ? readRequest(h).mode : undefined).not.toBe("tui");
    const [exec] = h.execCalls();
    expect(exec?.argv).toContain("--ignore-user-config");
    expect(liveLog(h, r.stdout)).toMatch(reason);
  });

  it("the tab helper refuses to launch if isolation fails at launch time", () => {
    const h = harness();
    // The wrapper's check passes; the IDE side sees a server that ignores the disable.
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      FAKE_CODEX_FINAL: REVIEW_JSON,
      FAKE_AG_EXTRA_ENV: JSON.stringify({
        FAKE_CODEX_MCP: '[{"name":"pencil","enabled":true,"sticky":true}]',
      }),
    });
    expect(r.status).toBe(0);
    expect(tuiCalls(h)).toHaveLength(0);
    expect(h.execCalls()).toHaveLength(1);
    expect(liveLog(h, r.stdout)).toMatch(
      /isolation failed in the tab: MCP servers still enabled: pencil/,
    );
  });
});

describe("tui isolation: review of the isolation fix", () => {
  const CLAIM = { FAKE_AG_MODE: "claim", CODEX_BRIDGE_CLAIM_TIMEOUT_MS: "8000" };
  const tuiCalls = (h: Harness) => h.calls().filter((c) => c.argv.includes("--ask-for-approval"));

  it("checks isolation with the same trust the launch uses, so project MCP servers are disabled too", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      FAKE_CODEX_PROJECT_MCP: "1",
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    const argv = tuiCalls(h)[0]?.argv ?? [];
    expect(argv).toEqual(expect.arrayContaining(["-c", "mcp_servers.proj_srv.enabled=false"]));
    // Every query ran with the launch's trust override.
    for (const q of h.calls().filter((c) => c.query))
      expect(q.argv.some((a) => a.startsWith("projects="))).toBe(true);
  });

  it("a slow preflight in the tab counts as started, not as a tab that never started", () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_HELPER_START_MS: "500",
      FAKE_AG_EXTRA_ENV: JSON.stringify({ FAKE_CODEX_QUERY_DELAY_MS: "400" }),
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(tuiCalls(h)).toHaveLength(1);
    expect(h.execCalls()).toHaveLength(0);
  });

  it("a tab withdrawn during its preflight never launches Codex", async () => {
    const h = harness();
    const r = h.run(["review", h.root, "HEAD~1"], {
      ...CLAIM,
      CODEX_BRIDGE_SESSION_WAIT_MS: "300",
      FAKE_AG_EXTRA_ENV: JSON.stringify({ FAKE_CODEX_QUERY_DELAY_MS: "700" }),
      FAKE_CODEX_FINAL: REVIEW_JSON,
    });
    expect(r.status).toBe(0);
    expect(h.execCalls()).toHaveLength(1);
    // Give the tab helper time to finish its preflight: it must still not launch.
    await new Promise((res) => setTimeout(res, 3000));
    expect(tuiCalls(h)).toHaveLength(0);
  });
});
