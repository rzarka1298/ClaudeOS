// scripts/codex/codex.mjs — the only sanctioned way agents reach Codex CLI.
//
// Every case runs a copy of the real wrapper inside a throwaway repository
// with a FAKE `codex` first on PATH. The fake speaks just enough of the
// app-server JSON-RPC and the `codex exec --json` event stream to exercise the
// wrapper, records every argv it receives, and never touches the network or
// the owner's Codex account. No test spends plan allowance.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo } from "./gate-repo.js";

const WRAPPER = "scripts/codex/codex.mjs";
const SCRIPTS = [
  WRAPPER,
  "scripts/codex/schemas/review-output.schema.json",
  "scripts/codex/schemas/worker-report.schema.json",
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
  const mode = process.env.FAKE_CODEX_USAGE || "";
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
    process.stderr.write("fake codex progress line\n");
    emit({ type: "thread.started", thread_id: "${SESSION_ID}" });
    emit({ type: "turn.started" });
    if (mode === "hang") {
      const child = spawn("sleep", ["60"], { stdio: "ignore" });
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

interface Harness {
  repo: GateRepo;
  /** The repository root with symlinks resolved (macOS tmp is /private/var). */
  root: string;
  bin: string;
  log: string;
  run(
    args: string[],
    env?: Record<string, string>,
  ): { status: number | null; out: string; stdout: string };
  calls(): Array<{ argv: string[]; cwd: string; stdin?: string | null }>;
  execCalls(): Array<{ argv: string[]; cwd: string; stdin?: string | null }>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function harness(): Harness {
  const repo = gateRepo(SCRIPTS, { "src/a.ts": "export const a = 1;\n" });
  repo.git("commit", "-q", "-m", "init");
  repo.write("src/a.ts", "export const a = 2;\n");
  repo.git("commit", "-q", "-am", "change");
  const bin = mkdtempSync(join(tmpdir(), "ccc-fake-codex-"));
  const fake = join(bin, "codex");
  writeFileSync(fake, `#!${process.execPath}\n${FAKE_CODEX}`);
  chmodSync(fake, 0o755);
  const log = join(bin, "calls.jsonl");
  cleanups.push(() => {
    repo.dispose();
    rmSync(bin, { recursive: true, force: true });
  });
  const readCalls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  return {
    repo,
    root: realpathSync(repo.root),
    bin,
    log,
    run(args, env = {}) {
      const r = spawnSync(process.execPath, [join(repo.root, WRAPPER), ...args], {
        cwd: repo.root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_CODEX_LOG: log,
          FAKE_CODEX_USAGE: usageResult(),
          CCC_CODEX_KILL_GRACE_MS: "300",
          ...env,
        },
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
    },
    calls: readCalls,
    execCalls: () => readCalls().filter((c) => c.argv[0] === "exec"),
  };
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
    expect(call?.cwd).toBe(h.root);

    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    expect(out.status).toBe("ok");
    expect(out.report).toMatch(/^\.planning\/codex\/reports\/.+-review\.json$/);
    const report = JSON.parse(readFileSync(join(h.root, out.report), "utf8"));
    expect(report.verdict).toBe("needs-attention");
    expect(report.advisory).toBe(true);
    expect(report.review.findings).toHaveLength(1);
    const md = readFileSync(join(h.root, out.report.replace(/\.json$/, ".md")), "utf8");
    expect(md).toContain("Off-by-one");
    expect(md).toContain("BLOCKER candidate");
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

  it("rejects a directory that is not a worktree of this repository", () => {
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

  it("the watchdog kills the whole process group and exits 21", () => {
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
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(child, 0);
        spawnSync("sleep", ["0.1"]);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
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
