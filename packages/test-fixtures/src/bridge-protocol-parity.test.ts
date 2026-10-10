// JS and TypeScript parity for the codex-bridge contract (plan 05.1-09, D-08, D-12).
//
// `scripts/codex/antigravity-extension/bridge-core.js` is what the installed helper and the IDE
// extension run; `@ccc/launchers` (agent-launch.ts, bridge-protocol.ts) is what the service runs
// BEFORE it writes a request. If the two ever disagree, a launch the service accepted is
// discarded by the helper (annoying) or, worse, one the service refused is accepted by the helper
// (a hole). This file ties them together: constants, state directories, the ban-token list, the
// whole shared hostile corpus (verdict AND reason), a deterministic differential sweep over flag
// combinations, and a real-filesystem comparison of the containment rules.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_ARGV_MAX,
  AGENT_BANNED_TOKENS,
  AGENT_ELEMENT_MAX,
  AGENT_ENV_KEY_RE,
  AGENT_ENV_MAX,
  AGENT_ENV_VALUE_MAX,
  AGENT_NAMES,
  AGENT_REASONS,
  BRIDGE_BANNED_TOKENS,
  BRIDGE_CAPABILITIES,
  BRIDGE_CLAIMED_KEEP_MS,
  BRIDGE_CONTAIN_DELAY_MS,
  BRIDGE_DIRECTORY_NAMES,
  BRIDGE_FUTURE_SKEW_MS,
  BRIDGE_HEARTBEAT_FRESH_MS,
  BRIDGE_KINDS,
  BRIDGE_MODES,
  BRIDGE_PROTOCOL_MARKER_FILE,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REQUEST_FILE_PATTERN,
  BRIDGE_ROLES,
  BRIDGE_RUN_ID_PATTERN,
  BRIDGE_STATE_PROBES,
  BRIDGE_TTL_MS,
  bridgeCommandPath,
  bridgeStateDir,
  projectDirName,
  projectStateCandidates,
  UUID_RE,
  validateAgentLaunch,
  validateAgentLaunchChecked,
} from "@ccc/launchers";
import { afterAll, describe, expect, it } from "vitest";
import { loadBridgeCore } from "./codex-bridge-core.js";
import { REPO_ROOT } from "./gate-repo.js";

const core = loadBridgeCore();

interface CorpusCase {
  id: string;
  category: string;
  agent: unknown;
  argv: unknown;
  env: unknown;
  expect: "accept" | "reject";
  reason?: string;
}
const corpus = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts", "codex", "hostile-corpus.json"), "utf8"),
) as { version: number; cases: CorpusCase[] };

describe("constants: the TypeScript mirror equals bridge-core.js", () => {
  it("protocol, kinds, modes, roles, timings, directories and the marker file", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(core.PROTOCOL_VERSION);
    expect([...BRIDGE_CAPABILITIES]).toEqual(core.CAPABILITIES);
    expect(BRIDGE_RUN_ID_PATTERN.source).toBe(core.RUN_ID_RE.source);
    expect(BRIDGE_RUN_ID_PATTERN.flags).toBe(core.RUN_ID_RE.flags);
    expect(BRIDGE_REQUEST_FILE_PATTERN.source).toBe(core.REQUEST_FILE_RE.source);
    expect([...BRIDGE_KINDS]).toEqual(core.KINDS);
    expect([...BRIDGE_MODES]).toEqual(core.MODES);
    expect([...BRIDGE_ROLES]).toEqual(core.ROLES);
    expect(BRIDGE_TTL_MS).toBe(core.TTL_MS);
    expect(BRIDGE_FUTURE_SKEW_MS).toBe(core.FUTURE_SKEW_MS);
    expect(BRIDGE_HEARTBEAT_FRESH_MS).toBe(core.HEARTBEAT_FRESH_MS);
    expect(BRIDGE_CONTAIN_DELAY_MS).toBe(core.CONTAIN_DELAY_MS);
    expect(BRIDGE_CLAIMED_KEEP_MS).toBe(core.CLAIMED_KEEP_MS);
    expect(BRIDGE_PROTOCOL_MARKER_FILE).toBe(core.PROTOCOL_MARKER_FILE);
    expect([...BRIDGE_STATE_PROBES]).toEqual(core.STATE_PROBES);
    const jsDirs = core.dirs("/s");
    for (const [name, dir] of Object.entries(BRIDGE_DIRECTORY_NAMES)) {
      if (name in jsDirs) expect(`/s/${dir}`).toBe(jsDirs[name as keyof typeof jsDirs]);
    }
    expect(Object.keys(BRIDGE_DIRECTORY_NAMES).sort()).toEqual(
      ["claimed", "prompts", "requests", "tui", "windows"].sort(),
    );
  });

  it("agent limits, names, env key pattern, UUID pattern and the reason vocabulary", () => {
    expect([...AGENT_NAMES]).toEqual(core.AGENTS);
    expect(AGENT_ARGV_MAX).toBe(core.AGENT_ARGV_MAX);
    expect(AGENT_ELEMENT_MAX).toBe(core.AGENT_ELEMENT_MAX);
    expect(AGENT_ENV_MAX).toBe(core.AGENT_ENV_MAX);
    expect(AGENT_ENV_VALUE_MAX).toBe(core.AGENT_ENV_VALUE_MAX);
    expect(AGENT_ENV_KEY_RE.source).toBe(core.AGENT_ENV_KEY_RE.source);
    expect(UUID_RE.source).toBe(core.UUID_RE.source);
    expect(UUID_RE.flags).toBe(core.UUID_RE.flags);
    expect([...AGENT_REASONS]).toEqual(core.AGENT_REASONS);
  });

  it("the banned-token lists are identical sets, and in the same order", () => {
    expect(new Set(AGENT_BANNED_TOKENS)).toEqual(new Set(core.BANNED_TOKENS));
    expect([...AGENT_BANNED_TOKENS]).toEqual(core.BANNED_TOKENS);
    expect([...BRIDGE_BANNED_TOKENS]).toEqual(core.BANNED_TOKENS);
  });
});

describe("state directories", () => {
  const envs: Array<Record<string, string | undefined>> = [
    {},
    { XDG_STATE_HOME: "" },
    { XDG_STATE_HOME: undefined },
    { XDG_STATE_HOME: "relative/state" },
    { XDG_STATE_HOME: "state" },
    { XDG_STATE_HOME: "/Users/USERNAME/state" },
    { XDG_STATE_HOME: "/Users/USERNAME/state/" },
    { XDG_STATE_HOME: "/Users//USERNAME///state" },
    { XDG_STATE_HOME: "/a/b/../c/./d" },
    { XDG_STATE_HOME: "/.." },
    { XDG_STATE_HOME: "/" },
    { XDG_STATE_HOME: "/with space/état" },
  ];
  const homes = [
    "/Users/USERNAME",
    "/Users/USERNAME/",
    "/",
    "/home/u",
    "/a//b",
    "/a/../b",
    "rel/home",
    "",
  ];

  it("bridgeStateDir and the helper path agree over ten-plus env and home permutations", () => {
    let compared = 0;
    for (const env of envs) {
      for (const home of homes) {
        expect(bridgeStateDir(env, home), JSON.stringify({ env, home })).toBe(
          core.bridgeStateDir(env, home),
        );
        compared++;
      }
    }
    for (const home of homes) {
      expect(bridgeCommandPath(home), home).toBe(core.bridgeCommand(home));
    }
    expect(compared).toBeGreaterThanOrEqual(10);
  });

  const mains = [
    "/Users/USERNAME/repo",
    "/Users/USERNAME/repo/",
    "/Users/USERNAME/my project",
    '/Users/USERNAME/it\'s a "dir"',
    "/Users/USERNAME/ünïcödé-日本語",
    "/Users/USERNAME/😀 emoji",
    `/Users/USERNAME/${"long-name-".repeat(8)}`,
    `/Users/USERNAME/${"x".repeat(40)}`,
    `/Users/USERNAME/${"x".repeat(41)}`,
    "/",
    "//",
    "/Users/USERNAME/..",
    "/Users/USERNAME/.hidden",
    "/Users/USERNAME/a.b_c-d",
    "relative/path",
    "name-only",
    "",
  ];

  it("projectDirName and projectStateCandidates agree over hostile main paths", () => {
    const stateDirs = ["/Users/USERNAME/.local/state/codex-bridge", "/s/codex-bridge/"];
    for (const main of mains) {
      expect(projectDirName(main), JSON.stringify(main)).toBe(core.projectDirName(main));
      for (const stateDir of stateDirs) {
        expect(projectStateCandidates(main, stateDir), JSON.stringify([main, stateDir])).toEqual(
          core.projectStateCandidates(main, stateDir),
        );
      }
    }
  });
});

describe("the hostile corpus: one verdict, one reason from both validators", () => {
  it("has not shrunk below its category coverage, so parity cannot be vacuous", () => {
    expect(corpus.version).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(188);
    const rejectCategories = new Set(
      corpus.cases.filter((c) => c.expect === "reject").map((c) => c.category),
    );
    for (const category of [
      "control-char",
      "empty-element",
      "oversize-element",
      "oversize-argv",
      "relative-argv0",
      "empty-argv0",
      "basename-mismatch",
      "agent-basename-disagree",
      "ban-token",
      "env-key",
      "env-value",
    ]) {
      expect(rejectCategories, category).toContain(category);
    }
    expect(corpus.cases.filter((c) => c.expect === "accept").length).toBeGreaterThanOrEqual(8);
  });

  it.each(corpus.cases.map((c) => [c.id, c] as const))("%s", (id, c) => {
    const input = { agent: c.agent, argv: c.argv, env: c.env };
    const js = core.validateAgentShape(input);
    const ts = validateAgentLaunch(input);
    expect(ts, `case ${id}: TypeScript differs from JavaScript`).toEqual(js);
    expect(ts.ok, `case ${id}: wrong verdict`).toBe(c.expect === "accept");
    if (!ts.ok) expect(ts.reason, `case ${id}: wrong reason`).toBe(c.reason);
  });
});

describe("differential sweep over flag combinations (beyond the corpus)", () => {
  const UUID = "123e4567-e89b-12d3-a456-426614174000";
  const pool: string[] = [
    "--model",
    "opus",
    "-m",
    "-n",
    "name",
    "--permission-mode",
    "--permission-mode=plan",
    "--permission-mode=auto",
    "--permission_mode",
    "plan",
    "acceptEdits",
    "default",
    "auto",
    "-s",
    "--sandbox",
    "--sandbox=read-only",
    "-sread-only",
    "read-only",
    "workspace-write",
    "never",
    "-a",
    "--ask-for-approval",
    "-anever",
    "on-request",
    "untrusted",
    "-c",
    "-cmodel=x",
    "-c=x",
    "-p",
    "-pprofile",
    "-C",
    "--cd",
    "--cd=/Users/USERNAME/repo",
    "--add-dir",
    "--add-dir=x",
    "/Users/USERNAME/repo",
    "--config",
    "--CONFIG=x",
    "--profile",
    "--settings",
    "--settings={}",
    "--mcp_config",
    "--plugin-dir",
    "--agents",
    "--allowedTools",
    "--allowed_tools=Bash",
    "resume",
    "--resume",
    "-r",
    "--session-id",
    `--resume=${UUID}`,
    `--session-id=${UUID}`,
    UUID,
    "not-a-uuid",
    "--last",
    "mcp",
    "config",
    "exec",
    "login",
    "e",
    "a",
    "--",
    "-",
    "-x",
    "--continue",
    "--yolo",
    "--full auto",
    "prompt text",
    "ＭＣＰ",
  ];
  // A small deterministic PRNG (mulberry32) so a failure reproduces.
  let seed = 0x5eed05a1;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (): string => pool[Math.floor(rand() * pool.length)] as string;

  const exe = (agent: string) => `/Users/USERNAME/.local/bin/${agent}`;
  const compare = (agent: string, rest: string[]): void => {
    const input = { agent, argv: [exe(agent), ...rest], env: {} };
    const js = core.validateAgentShape(input);
    const ts = validateAgentLaunch(input);
    expect(ts, `${agent} ${JSON.stringify(rest)}`).toEqual(js);
  };

  it("every pair of pool elements, both agents", () => {
    for (const agent of ["claude", "codex"]) {
      compare(agent, []);
      for (const a of pool) {
        compare(agent, [a]);
        for (const b of pool) compare(agent, [a, b]);
      }
    }
  });

  it("four thousand seeded random argv of up to five elements, both agents", () => {
    for (let i = 0; i < 4000; i++) {
      const agent = i % 2 === 0 ? "claude" : "codex";
      const rest = Array.from({ length: 1 + Math.floor(rand() * 5) }, pick);
      compare(agent, rest);
    }
  });
});

describe("containment on a real filesystem: validateRequest (JS) vs validateAgentLaunchChecked (TS)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-bridge-parity-")));
  const project = join(base, "repo");
  const outside = join(base, "elsewhere");
  const sibling = join(base, "repo2");
  mkdirSync(join(project, "packages", "a"), { recursive: true });
  mkdirSync(join(project, "packages", "b"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  symlinkSync(outside, join(project, "escape"));
  symlinkSync(join(project, "packages", "a"), join(project, "inside-link"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  for (const agent of ["claude", "codex"]) {
    writeFileSync(join(bin, agent), "#!/bin/sh\n");
    chmodSync(join(bin, agent), 0o755);
  }
  writeFileSync(join(base, "plain-file"), "x");
  const noExecDir = join(base, "noexec");
  mkdirSync(noExecDir);
  writeFileSync(join(noExecDir, "claude"), "#!/bin/sh\n");
  chmodSync(join(noExecDir, "claude"), 0o644);

  const checks = {
    isExecutable: (p: string): boolean => {
      try {
        const st = statSync(p);
        return st.isFile() && (st.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
    realDir: (p: string, from: string): string | null => {
      try {
        const real = realpathSync(resolve(from, p));
        return statSync(real).isDirectory() ? real : null;
      } catch {
        return null;
      }
    },
  };

  const cwdCases: Array<string | null> = [
    null,
    project,
    join(project, "packages", "a"),
    join(project, "inside-link"),
    join(project, "escape"),
    outside,
    sibling,
    join(project, ".."),
    join(project, "missing"),
  ];
  const argvCases = (agent: "claude" | "codex"): string[][] => [
    [],
    ["--add-dir", "packages/a"],
    ["--add-dir", "packages/a", "packages/b"],
    ["--add-dir", "packages/a", outside],
    ["--add-dir", outside],
    [`--add-dir=${outside}`],
    ["--add-dir", "escape"],
    ["--add-dir", "inside-link"],
    ["--add-dir", "../elsewhere"],
    ["--add-dir", "../repo2"],
    ["--add-dir", "missing"],
    ["--add-dir"],
    ["--add-dir", join(base, "plain-file")],
    ...(agent === "codex"
      ? [
          ["-C", "packages/a"],
          ["-C", outside],
          [`-C${outside}`],
          ["-C"],
          ["--cd", "escape"],
          ["--cd=packages/b"],
          ["--cd", "../elsewhere"],
        ]
      : []),
  ];

  it("agree on accept versus reject for every project, cwd and directory-argument combination", async () => {
    let compared = 0;
    for (const agent of ["claude", "codex"] as const) {
      for (const cwd of cwdCases) {
        for (const rest of argvCases(agent)) {
          const argv = [join(bin, agent), ...rest];
          const raw = {
            runId: "20261010T123456789Z",
            kind: "agent",
            mode: "agent",
            agent,
            projectRoot: project,
            cwd,
            argv,
            env: { CCC_RUN_ID: "x" },
            sessionId: null,
            liveLog: null,
            pid: null,
            createdAt: new Date().toISOString(),
            protocol: 2,
          };
          const js = core.validateRequest(raw, { stateDir: join(base, "state"), checkAge: false });
          const ts = await validateAgentLaunchChecked(
            { agent, argv, env: raw.env, projectRoot: project, cwd },
            checks,
          );
          expect(ts.ok, `${agent} cwd=${cwd} argv=${JSON.stringify(rest)}`).toBe(js.ok);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  it("agree on an argv[0] that is missing, not executable or a directory", async () => {
    for (const exePath of [
      join(bin, "claude"),
      join(noExecDir, "claude"),
      join(base, "bin", "nope", "claude"),
    ]) {
      const argv = [exePath];
      const raw = {
        runId: "20261010T123456789Z",
        kind: "agent",
        mode: "agent",
        agent: "claude",
        projectRoot: project,
        cwd: null,
        argv,
        env: {},
        sessionId: null,
        liveLog: null,
        pid: null,
        createdAt: new Date().toISOString(),
        protocol: 2,
      };
      const js = core.validateRequest(raw, { stateDir: join(base, "state"), checkAge: false });
      const ts = await validateAgentLaunchChecked(
        { agent: "claude", argv, env: {}, projectRoot: project },
        checks,
      );
      expect(ts.ok, exePath).toBe(js.ok);
    }
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });
});
