// `codex-bridge agent <runId>` — the queue side of the pair launch (D-02, D-08).
//
// The Antigravity tab runs the fixed launcher with argv `agent <runId>`. The helper must re-read the
// CLAIMED request, re-validate it with the shared bridge-core function, and exec exactly the validated
// argv as an argument array. Every case runs a staged copy of the real helper as a child process over a
// temporary HOME and bridge state directory, with fake executables named exactly `claude` and `codex`.
// Nothing here starts a real agent, runs raw `codex`, or touches the owner's home or Antigravity.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadBridgeCore, loadWindowSimulator } from "./codex-bridge-core.js";
import { REPO_ROOT } from "./gate-repo.js";

const core = loadBridgeCore();
const { createWindowSimulator } = loadWindowSimulator();

// The fixed refusal line: names at most the digits-only run id, never a reason or a value.
const REFUSED = /codex-wrapper: agent( \d{8}T\d{9}Z)?: refused, nothing was started/;
function expectRefused(r: { status: number | null; out: string }): void {
  expect(r.status).toBe(2);
  expect(r.out).toMatch(REFUSED);
}
const RUN_ID = "20261010T120000123Z";
// One argument with spaces, a double quote, a dollar sign, a backtick, a semicolon and a glob.
const AWKWARD = "a b \"c\" $HOME `x` ; rm * && echo \\ 'q'";

const STAGED_FILES = [
  "scripts/codex/codex.mjs",
  "scripts/codex/antigravity-extension/bridge-core.js",
  "scripts/codex/antigravity-extension/package.json",
];

// A fake agent: records its argv, working directory and environment to the file named by the TAB's
// environment (never the request's), then behaves as the request's CCC_FAKE_* variables say.
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const log = process.env.FAKE_AGENT_LOG;
if (log) {
  const ccc = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("CCC_")) ccc[k] = v;
  fs.appendFileSync(
    log,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      ccc,
      path: process.env.PATH,
      tab: process.env.FAKE_TAB_MARK ?? null,
    }) + "\n",
  );
}
const sleep = Number(process.env.CCC_FAKE_SLEEP_MS || 0);
const finish = () => {
  if (process.env.CCC_FAKE_SIGNAL) process.kill(process.pid, process.env.CCC_FAKE_SIGNAL);
  else process.exit(Number(process.env.CCC_FAKE_EXIT || 0));
};
if (sleep > 0) setTimeout(finish, sleep);
else finish();
`;

interface Staged {
  kit: string;
  bin: string;
}
let staged: Staged | null = null;
function stage(): Staged {
  if (staged) return staged;
  const kit = realpathSync(mkdtempSync(join(tmpdir(), "ccc-agent-kit-")));
  for (const f of STAGED_FILES) {
    const to = join(kit, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(REPO_ROOT, f), to);
  }
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "ccc-agent-bin-")));
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${FAKE_AGENT}`, { mode: 0o755 });
    chmodSync(join(bin, name), 0o755);
  }
  staged = { kit, bin };
  return staged;
}
afterAll(() => {
  if (!staged) return;
  rmSync(staged.kit, { recursive: true, force: true });
  rmSync(staged.bin, { recursive: true, force: true });
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

interface World {
  home: string;
  state: string;
  project: string;
  claude: string;
  codex: string;
  log: string;
  request(over?: Record<string, unknown>): Record<string, unknown>;
  claim(raw: Record<string, unknown>): void;
  writeClaimed(raw: unknown, runId?: string): void;
  run(
    args: string[],
    env?: Record<string, string>,
  ): { status: number | null; out: string; stderr: string; stdout: string };
  calls(): Array<{
    argv: string[];
    cwd: string;
    ccc: Record<string, string>;
    path: string;
    tab: string | null;
  }>;
}

function helperEnv(w: { home: string; log: string }, over: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CODEX_BRIDGE_")) delete env[k];
  delete env.XDG_STATE_HOME;
  delete env.CODEX_HOME;
  return {
    ...env,
    HOME: w.home,
    FAKE_AGENT_LOG: w.log,
    FAKE_TAB_MARK: "tab-environment",
    CCC_AGENT_MARK: "from-the-tab",
    CODEX_BRIDGE_FOLLOW_SHELL: "0",
    ...over,
  };
}

function world(): World {
  const { kit, bin } = stage();
  const home = tmp("ccc-agent-home-");
  const project = tmp("ccc-agent-project-");
  const state = join(home, ".local", "state", "codex-bridge");
  core.ensureDirs(state);
  const log = join(home, "agent-calls.jsonl");
  const w: World = {
    home,
    state,
    project,
    claude: join(bin, "claude"),
    codex: join(bin, "codex"),
    log,
    request(over = {}) {
      return {
        runId: RUN_ID,
        kind: "agent",
        mode: "agent",
        agent: "claude",
        projectRoot: project,
        cwd: project,
        argv: [join(bin, "claude"), "--permission-mode", "plan", AWKWARD],
        env: { CCC_AGENT_MARK: "from-the-request" },
        sessionId: null,
        liveLog: null,
        pid: null,
        createdAt: new Date().toISOString(),
        protocol: 2,
        ...over,
      };
    },
    claim(raw) {
      core.writeRequest(state, raw as never);
      const sim = createWindowSimulator({
        stateDir: state,
        folders: [project],
        mode: "current",
        now: Date.now(),
      });
      const got = sim.tick();
      sim.close();
      expect(got.map((c) => c.request.runId)).toEqual([raw.runId]);
    },
    writeClaimed(raw, runId = RUN_ID) {
      mkdirSync(join(state, "claimed"), { recursive: true });
      writeFileSync(join(state, "claimed", `${runId}.json`), JSON.stringify(raw), { mode: 0o600 });
    },
    run(args, env = {}) {
      const r = spawnSync(process.execPath, [join(kit, "scripts/codex/codex.mjs"), ...args], {
        cwd: project,
        encoding: "utf8",
        timeout: 30_000,
        env: helperEnv(w, env),
      });
      return {
        status: r.status,
        out: `${r.stdout}${r.stderr}`,
        stderr: r.stderr,
        stdout: r.stdout,
      };
    },
    calls() {
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [];
    },
  };
  return w;
}

// ---------------------------------------------------------------------------
// Task 1 (tracer): a claimed request is executed as an argument array

describe("codex-bridge agent: a valid claimed request", () => {
  it("tracer: execs argv[0] with the rest as an argument array, in the request's cwd, with its CCC_ env merged over the tab's", () => {
    const w = world();
    w.claim(w.request({ env: { CCC_AGENT_MARK: "from-the-request", CCC_FAKE_EXIT: "0" } }));
    const r = w.run(["agent", RUN_ID]);
    expect(r.status).toBe(0);
    const [call, ...rest] = w.calls();
    expect(rest).toEqual([]);
    expect(call?.argv).toEqual(["--permission-mode", "plan", AWKWARD]);
    expect(call?.cwd).toBe(w.project);
    expect(call?.ccc.CCC_AGENT_MARK).toBe("from-the-request");
    // The tab's own environment survives for the child.
    expect(call?.tab).toBe("tab-environment");
    expect(call?.path).toBe(helperEnv(w).PATH);
  });

  it("runs the codex agent the same way", () => {
    const w = world();
    w.claim(
      w.request({
        agent: "codex",
        argv: [w.codex, "--ask-for-approval", "on-request", "do $THING"],
      }),
    );
    expect(w.run(["agent", RUN_ID]).status).toBe(0);
    expect(w.calls()[0]?.argv).toEqual(["--ask-for-approval", "on-request", "do $THING"]);
  });

  it("uses the symlink path the owner chose without resolving it", () => {
    const w = world();
    const linkDir = tmp("ccc-agent-link-");
    const link = join(linkDir, "claude");
    symlinkSync(w.claude, link);
    w.claim(w.request({ argv: [link, "hello"] }));
    expect(w.run(["agent", RUN_ID]).status).toBe(0);
    expect(w.calls()[0]?.argv).toEqual(["hello"]);
  });

  it("exits with the child's exit code", () => {
    const w = world();
    w.claim(w.request({ env: { CCC_FAKE_EXIT: "7" } }));
    const r = w.run(["agent", RUN_ID]);
    expect(r.status).toBe(7);
    expect(w.calls()).toHaveLength(1);
  });

  it("reports a signal-killed child with a fixed message and a non-zero code", () => {
    const w = world();
    w.claim(w.request({ env: { CCC_FAKE_SIGNAL: "SIGTERM" } }));
    const r = w.run(["agent", RUN_ID]);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.out).toMatch(/ended by a signal/);
    expect(r.out).not.toContain(AWKWARD);
  });

  it("survives a Ctrl-C aimed at the helper while the agent keeps running", async () => {
    const w = world();
    w.claim(w.request({ env: { CCC_FAKE_SLEEP_MS: "1500", CCC_FAKE_EXIT: "5" } }));
    const helper = spawn(
      process.execPath,
      [join(stage().kit, "scripts/codex/codex.mjs"), "agent", RUN_ID],
      { cwd: w.project, stdio: "ignore", env: helperEnv(w) },
    );
    const exited = new Promise<number | null>((res) => helper.on("exit", (code) => res(code)));
    for (let i = 0; i < 100 && w.calls().length === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(w.calls()).toHaveLength(1);
    helper.kill("SIGINT");
    // The agent was not signalled (only the helper was), so its own exit code comes through.
    expect(await exited).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// refusals: nothing is spawned and nothing of the request is printed

interface CorpusCase {
  id: string;
  category: string;
  agent: string;
  argv: unknown;
  env: Record<string, unknown>;
  expect: "accept" | "reject";
}
const corpus = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts", "codex", "hostile-corpus.json"), "utf8"),
) as { cases: CorpusCase[] };

function representatives(): CorpusCase[] {
  const byCategory = new Map<string, CorpusCase[]>();
  for (const c of corpus.cases) {
    if (c.expect !== "reject") continue;
    byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
  }
  const picked: CorpusCase[] = [];
  for (const cases of byCategory.values()) {
    const at = new Set([0, Math.floor(cases.length / 2), cases.length - 1]);
    for (const i of at) {
      const c = cases[i];
      if (c) picked.push(c);
    }
  }
  return picked;
}

function printable(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  // Short fragments ("a", "--model") legitimately appear in any fixed text.
  return out.filter((s) => s.length >= 5 && !/^\/.*\/(claude|codex)$/.test(s));
}

describe("codex-bridge agent: a hostile claimed request is refused with nothing spawned", () => {
  const cases = representatives();

  it("covers every reject category of the shared corpus", () => {
    const all = new Set(corpus.cases.filter((c) => c.expect === "reject").map((c) => c.category));
    expect(new Set(cases.map((c) => c.category))).toEqual(all);
    expect(all.size).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((c) => [c.category, c.id, c] as const))("%s: %s", (_category, _id, c) => {
    const w = world();
    // Where the case uses the corpus placeholder executable, point it at the real fake of that
    // agent so the refusal is about the defect, not about a missing file.
    const placeholder = /^\/Users\/USERNAME\/\.local\/bin\/(claude|codex)$/;
    const swap = (a: unknown, i: number) =>
      i === 0 && typeof a === "string" && placeholder.test(a)
        ? join(stage().bin, a.endsWith("codex") ? "codex" : "claude")
        : a;
    // Some cases deliberately carry an argv that is not an array.
    const argv: unknown = Array.isArray(c.argv) ? c.argv.map(swap) : swap(c.argv, 0);
    const raw = w.request({ agent: c.agent, argv, env: c.env });
    w.writeClaimed(raw);
    const r = w.run(["agent", RUN_ID]);
    expectRefused(r);
    expect(w.calls()).toEqual([]);
    for (const piece of printable({ argv, env: c.env })) expect(r.out).not.toContain(piece);
  });
});

describe("codex-bridge agent: other refusals", () => {
  it("refuses a run id with no claimed request", () => {
    const w = world();
    const r = w.run(["agent", "20261010T120000999Z"]);
    expectRefused(r);
    expect(w.calls()).toEqual([]);
  });

  it("refuses a malformed run id without echoing it", () => {
    const w = world();
    const r = w.run(["agent", "../../etc/passwd"]);
    expectRefused(r);
    expect(r.out).not.toContain("etc/passwd");
    expect(w.calls()).toEqual([]);
  });

  it("refuses a missing or surplus run id with the usage text", () => {
    const w = world();
    expect(w.run(["agent"]).status).toBe(2);
    expect(w.run(["agent", RUN_ID, "20261010T120000124Z"]).status).toBe(2);
    expect(w.calls()).toEqual([]);
  });

  it("refuses a claimed follow request", () => {
    const w = world();
    const live = join(w.state, "live.log");
    writeFileSync(live, "[end] x\n");
    w.writeClaimed({
      runId: RUN_ID,
      kind: "review",
      projectRoot: w.project,
      cwd: w.project,
      sessionId: null,
      liveLog: live,
      pid: null,
      createdAt: new Date().toISOString(),
    });
    const r = w.run(["agent", RUN_ID]);
    expectRefused(r);
    expect(w.calls()).toEqual([]);
  });

  it("refuses a claimed tui request", () => {
    const w = world();
    const live = join(w.state, "live.log");
    writeFileSync(live, "[end] x\n");
    const prompt = join(w.state, "prompts", `${RUN_ID}.md`);
    mkdirSync(dirname(prompt), { recursive: true });
    writeFileSync(prompt, "marker\n");
    w.writeClaimed({
      runId: RUN_ID,
      kind: "review",
      mode: "tui",
      role: "review",
      promptFile: prompt,
      projectRoot: w.project,
      cwd: w.project,
      sessionId: null,
      liveLog: live,
      pid: null,
      createdAt: new Date().toISOString(),
    });
    const r = w.run(["agent", RUN_ID]);
    expectRefused(r);
    expect(w.calls()).toEqual([]);
  });

  it("refuses an agent request whose kind and mode disagree", () => {
    const w = world();
    w.writeClaimed(w.request({ mode: "follow" }));
    expectRefused(w.run(["agent", RUN_ID]));
    expect(w.calls()).toEqual([]);
  });

  it("refuses a claimed request carrying an extra unknown key", () => {
    const w = world();
    w.writeClaimed(w.request({ shell: "/bin/sh -c 'echo pwned'" }));
    const r = w.run(["agent", RUN_ID]);
    expectRefused(r);
    expect(r.out).not.toContain("pwned");
    expect(w.calls()).toEqual([]);
  });

  it("refuses a request that is not protocol 2", () => {
    const w = world();
    w.writeClaimed(w.request({ protocol: 1 }));
    expectRefused(w.run(["agent", RUN_ID]));
    expect(w.calls()).toEqual([]);
  });

  it("refuses an environment key outside the CCC_ pattern written into the claimed file by hand", () => {
    const w = world();
    w.writeClaimed(w.request({ env: { PATH: "/tmp/evil", CCC_OK: "1" } }));
    const r = w.run(["agent", RUN_ID]);
    expectRefused(r);
    expect(r.out).not.toContain("/tmp/evil");
    expect(w.calls()).toEqual([]);
  });

  it("preserves the tab's PATH and merges only CCC_ keys", () => {
    const w = world();
    w.claim(w.request({ env: { CCC_ONLY: "yes" } }));
    expect(
      w.run(["agent", RUN_ID], { PATH: `${stage().bin}:${process.env.PATH ?? ""}` }).status,
    ).toBe(0);
    const [call] = w.calls();
    expect(call?.path.startsWith(stage().bin)).toBe(true);
    expect(call?.ccc.CCC_ONLY).toBe("yes");
    // The tab's own CCC_ variable that the request does not set is kept.
    expect(call?.ccc.CCC_AGENT_MARK).toBe("from-the-tab");
  });

  it("refuses argv[0] that is no longer an executable file, with a fixed message", () => {
    const w = world();
    const own = tmp("ccc-agent-own-");
    const exe = join(own, "claude");
    copyFileSync(w.claude, exe);
    chmodSync(exe, 0o755);
    w.claim(w.request({ argv: [exe, AWKWARD] }));
    chmodSync(exe, 0o644);
    const first = w.run(["agent", RUN_ID]);
    expectRefused(first);
    expect(first.out).toMatch(/not an executable|not executable/);
    expect(first.out).not.toContain(exe);
    rmSync(exe);
    const second = w.run(["agent", RUN_ID]);
    expectRefused(second);
    expect(second.out).not.toContain(exe);
    expect(w.calls()).toEqual([]);
  });

  it("refuses an argv[0] that is a directory named claude", () => {
    const w = world();
    const own = tmp("ccc-agent-dir-");
    mkdirSync(join(own, "claude"));
    w.writeClaimed(w.request({ argv: [join(own, "claude")] }));
    expectRefused(w.run(["agent", RUN_ID]));
    expect(w.calls()).toEqual([]);
  });

  it("follow refuses a claimed agent request instead of tailing a null log", () => {
    const w = world();
    w.claim(w.request());
    const r = w.run(["follow", RUN_ID]);
    expect(r.status).toBe(2);
    expect(r.out).not.toMatch(/live log/);
    expect(r.out).toMatch(/agent run/);
    expect(w.calls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the executable pin (review F carry-forward: argv[0] is pinned to the saved launcher row's path)

describe("codex-bridge agent: the pinned executable", () => {
  const pins = (w: World, value: unknown) =>
    writeFileSync(join(w.state, "agent-pins.json"), JSON.stringify(value), { mode: 0o600 });

  it("runs when argv[0] equals the pinned path for that agent", () => {
    const w = world();
    pins(w, { schemaVersion: 1, claude: w.claude, codex: w.codex });
    w.claim(w.request());
    expect(w.run(["agent", RUN_ID]).status).toBe(0);
    expect(w.calls()).toHaveLength(1);
  });

  it("refuses an executable the saved launcher row does not name, even when it is a valid claude", () => {
    const w = world();
    const other = tmp("ccc-agent-other-");
    const exe = join(other, "claude");
    copyFileSync(w.claude, exe);
    chmodSync(exe, 0o755);
    pins(w, { schemaVersion: 1, claude: w.claude, codex: w.codex });
    w.claim(w.request({ argv: [exe, "x"] }));
    const r = w.run(["agent", RUN_ID]);
    expectRefused(r);
    expect(r.out).toMatch(/launcher settings/);
    expect(r.out).not.toContain(other);
    expect(w.calls()).toEqual([]);
  });

  it("fails closed when the pin file is present but malformed, unreadable as a pin, or lacks the agent", () => {
    for (const bad of [
      "not json",
      JSON.stringify([1]),
      JSON.stringify({ schemaVersion: 1, codex: "/x/codex" }),
      JSON.stringify({ schemaVersion: 1, claude: 42 }),
      JSON.stringify({ schemaVersion: 1, claude: "relative/claude" }),
    ]) {
      const w = world();
      writeFileSync(join(w.state, "agent-pins.json"), bad, { mode: 0o600 });
      w.claim(w.request());
      expectRefused(w.run(["agent", RUN_ID]));
      expect(w.calls()).toEqual([]);
    }
  });

  it("refuses a pin file that is a symlink", () => {
    const w = world();
    const real = join(w.home, "real-pins.json");
    writeFileSync(real, JSON.stringify({ schemaVersion: 1, claude: w.claude }));
    symlinkSync(real, join(w.state, "agent-pins.json"));
    w.claim(w.request());
    expectRefused(w.run(["agent", RUN_ID]));
    expect(w.calls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the helper source: no shell on the agent path

describe("codex-bridge agent: source", () => {
  const source = readFileSync(join(REPO_ROOT, "scripts", "codex", "codex.mjs"), "utf8");

  function body(name: string): string {
    const start = source.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    return source.slice(start, end + 3);
  }

  it("cmdAgent starts the child without a shell or a command string", () => {
    const fn = body("cmdAgent");
    expect(fn).toMatch(/spawnSync\(/);
    expect(fn).toMatch(/shell:\s*false/);
    expect(fn).not.toMatch(/shell:\s*true/);
    expect(fn).not.toMatch(/\bexecSync\b|\bexec\(|\bexecFileSync\b|\bspawn\(/);
    expect(fn).not.toMatch(/["'`]-c["'`]/);
    expect(fn).not.toMatch(/\/bin\/(ba|z)?sh/);
    // Only argument arrays reach spawnSync: its first argument is a variable, never a template.
    for (const m of fn.matchAll(/spawnSync\(\s*([^,]+),/g)) expect(m[1]).not.toMatch(/[`"']/);
  });

  it("cmdAgent never prints request content", () => {
    const fn = body("cmdAgent");
    const printed = [...fn.matchAll(/(?:say|fail|refuse|write)\(([^;]*)\);/g)].map((m) => m[1]);
    expect(printed.length).toBeGreaterThan(0);
    for (const p of printed) expect(p).not.toMatch(/argv|\.env\b|req\.cwd|request\.cwd|reason/);
  });

  it("USAGE_TEXT lists the subcommand", () => {
    const usage = source.slice(
      source.indexOf("const USAGE_TEXT"),
      source.indexOf("// ----", source.indexOf("const USAGE_TEXT")),
    );
    expect(usage).toMatch(/codex\.mjs agent <run-id>/);
  });
});
