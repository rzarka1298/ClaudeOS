import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ARGV_MAX,
  AGENT_BANNED_TOKENS,
  AGENT_ELEMENT_MAX,
  AGENT_ENV_KEY_RE,
  AGENT_ENV_MAX,
  AGENT_ENV_VALUE_MAX,
  AGENT_REASONS,
  type AgentLaunchChecks,
  type AgentLaunchInput,
  type CheckedAgentLaunchInput,
  UUID_RE,
  validateAgentLaunch,
  validateAgentLaunchChecked,
} from "./agent-launch.js";
import {
  FORBIDDEN_CODEX_TOKENS,
  FORBIDDEN_PERMISSION_TOKENS,
  normaliseForFlagMatch,
} from "./command-template.js";

// The ONE accept/reject corpus shared with the JavaScript validator (bridge-core.js). It is read
// from the repository root, never copied into the package.
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
  readFileSync(new URL("../../../scripts/codex/hostile-corpus.json", import.meta.url), "utf8"),
) as { version: number; cases: CorpusCase[] };

const CLAUDE = "/Users/USERNAME/.local/bin/claude";
const CODEX = "/Users/USERNAME/.local/bin/codex";
const UUID = "123e4567-e89b-12d3-a456-426614174000";

const claude = (...rest: unknown[]): AgentLaunchInput => ({
  agent: "claude",
  argv: [CLAUDE, ...rest],
  env: {},
});
const codex = (...rest: unknown[]): AgentLaunchInput => ({
  agent: "codex",
  argv: [CODEX, ...rest],
  env: {},
});
const reasonOf = (input: AgentLaunchInput): string | null => {
  const verdict = validateAgentLaunch(input);
  return verdict.ok ? null : verdict.reason;
};

describe("validateAgentLaunch over the hostile corpus (tracer)", () => {
  it("the corpus has not shrunk below its category coverage", () => {
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

  it.each(corpus.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const verdict = validateAgentLaunch({ agent: c.agent, argv: c.argv, env: c.env });
    if (c.expect === "accept") {
      expect(verdict).toEqual({ ok: true });
    } else {
      expect(verdict).toEqual({ ok: false, reason: c.reason });
      expect(AGENT_REASONS).toContain((verdict as { reason: string }).reason);
    }
  });
});

describe("argv[0]", () => {
  it("must be absolute with a basename exactly equal to the agent", () => {
    for (const exe of [
      "/Users/USERNAME/.local/bin/claude ",
      "/Users/USERNAME/.local/bin/Claude",
      "/Users/USERNAME/.local/bin/claude.sh",
      "/Users/USERNAME/.local/bin/claude.exe",
      "/Users/USERNAME/.local/bin/../bin/claude/../claude2",
    ]) {
      expect(reasonOf({ agent: "claude", argv: [exe], env: {} }), exe).not.toBeNull();
    }
    expect(reasonOf({ agent: "claude", argv: ["/Users/USERNAME/../claude"], env: {} })).toBe(
      "argv0-not-absolute",
    );
    expect(reasonOf({ agent: "claude", argv: ["/Users/USERNAME/./claude"], env: {} })).toBe(
      "argv0-not-absolute",
    );
    expect(reasonOf({ agent: "claude", argv: ["/Users//USERNAME/claude"], env: {} })).toBe(
      "argv0-not-absolute",
    );
    expect(reasonOf({ agent: "claude", argv: ["claude"], env: {} })).toBe("argv0-not-absolute");
    expect(reasonOf({ agent: "claude", argv: [CLAUDE.toUpperCase()], env: {} })).toBe(
      "argv0-basename",
    );
  });

  it("an agent of codex with a claude basename is refused, and the reverse", () => {
    expect(reasonOf({ agent: "codex", argv: [CLAUDE], env: {} })).toBe("argv0-basename");
    expect(reasonOf({ agent: "claude", argv: [CODEX], env: {} })).toBe("argv0-basename");
    expect(reasonOf({ agent: "codex", argv: [CODEX], env: {} })).toBeNull();
    expect(reasonOf({ agent: "claude", argv: [CLAUDE], env: {} })).toBeNull();
  });

  it("an agent name that is not claude or codex is bad-agent", () => {
    for (const agent of ["", "Claude", "claude ", "sh", null, undefined, 1, {}, ["claude"]]) {
      expect(reasonOf({ agent, argv: [CLAUDE], env: {} }), String(agent)).toBe("bad-agent");
    }
  });
});

describe("ban tokens (NFKC, lower-case, non-alphanumerics removed)", () => {
  it("shares the normaliser and the token lists with the template validator", () => {
    expect(normaliseForFlagMatch("--Dangerously_Skip-Permissions")).toBe(
      "dangerouslyskippermissions",
    );
    expect(AGENT_BANNED_TOKENS).toEqual([
      ...FORBIDDEN_PERMISSION_TOKENS,
      ...FORBIDDEN_CODEX_TOKENS,
    ]);
    expect(AGENT_BANNED_TOKENS).toHaveLength(8);
  });

  it("refuses the fullwidth, underscore, equals-joined and JSON spellings in any element, argv[0] included", () => {
    const spellings = [
      "--dangerously-skip-permissions",
      "--dangerously_skip_permissions",
      "－－ｄａｎｇｅｒｏｕｓｌｙ－ｓｋｉｐ－ｐｅｒｍｉｓｓｉｏｎｓ",
      "--permission-mode=bypassPermissions",
      '{"permissions":{"defaultMode":"bypassPermissions"}}',
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--yolo",
      "--full-auto",
      "--approve-for-me",
      "--sandbox=danger-full-access",
      "danger_full_access",
    ];
    for (const spelling of spellings) {
      expect(reasonOf(claude(spelling)), spelling).toBe("banned-flag");
      expect(reasonOf(codex("--model", spelling)), spelling).toBe("banned-flag");
    }
    expect(reasonOf({ agent: "claude", argv: ["/Users/USERNAME/--yolo/claude"], env: {} })).toBe(
      "banned-flag",
    );
  });

  it("a token split across two elements is not a token", () => {
    expect(reasonOf(claude("--full", "auto"))).toBeNull();
  });
});

describe("env", () => {
  const withEnv = (env: unknown): AgentLaunchInput => ({
    agent: "claude",
    argv: [CLAUDE],
    env,
  });

  it("accepts CCC_ keys within the bounds", () => {
    expect(reasonOf(withEnv({ CCC_RUN_ID: "abc", CCC_X1: "" }))).toBeNull();
    const sixteen = Object.fromEntries(
      Array.from({ length: AGENT_ENV_MAX }, (_, i) => [`CCC_K${i}`, "v"]),
    );
    expect(reasonOf(withEnv(sixteen))).toBeNull();
  });

  it("refuses keys outside the CCC_ pattern with env-key", () => {
    for (const key of ["PATH", "LD_PRELOAD", "ccc_run", "CCC_", "CCC_a", "NODE_OPTIONS", "CCC-X"]) {
      expect(reasonOf(withEnv({ [key]: "v" })), key).toBe("env-key");
    }
    expect(AGENT_ENV_KEY_RE.test("CCC_OK")).toBe(true);
  });

  it("refuses more than sixteen entries, over-long values and control characters", () => {
    const seventeen = Object.fromEntries(
      Array.from({ length: AGENT_ENV_MAX + 1 }, (_, i) => [`CCC_K${i}`, "v"]),
    );
    expect(reasonOf(withEnv(seventeen))).toBe("bad-env");
    expect(reasonOf(withEnv({ CCC_A: "x".repeat(AGENT_ENV_VALUE_MAX) }))).toBeNull();
    expect(reasonOf(withEnv({ CCC_A: "x".repeat(AGENT_ENV_VALUE_MAX + 1) }))).toBe("env-value");
    for (const value of ["a\nb", "a\u0000b", "\u001b[31m", "a\u0085b", "a b", "a\tb", 5, null]) {
      expect(reasonOf(withEnv({ CCC_A: value })), JSON.stringify(value)).toBe("env-value");
    }
  });

  it("refuses an env that is not a plain object", () => {
    for (const env of [null, undefined, [], "x", 1, new Map(), Object.create({ CCC_A: "v" })]) {
      expect(reasonOf(withEnv(env)), String(env)).toBe("bad-env");
    }
    expect(reasonOf(withEnv(Object.create(null)))).toBeNull();
  });
});

describe("deny-by-default flag rules on the final argv (carry-forward F-01/F-02)", () => {
  it("refuses config-carrying flags in every spelling, for both agents", () => {
    const spellings: string[][] = [
      ["--config", "model=x"],
      ["--config=model=x"],
      ["--CONFIG", "model=x"],
      ["--Config=model=x"],
      ["--profile", "p"],
      ["--profile=p"],
      ["--settings", '{"a":1}'],
      ["--settings={}"],
      ["--SETTINGS={}"],
      ["--mcp-config", "x.json"],
      ["--mcp_config", "x.json"],
      ["--mcp_config=x.json"],
      ["--plugin-dir", "/Users/USERNAME/repo/p"],
      ["--agents", "{}"],
      ["--allowedTools", "Bash"],
      ["--allowed-tools=Bash"],
      ["--allowed_tools", "Bash"],
    ];
    for (const rest of spellings) {
      expect(reasonOf(claude(...rest)), `claude ${rest.join(" ")}`).toBe("banned-flag");
      expect(reasonOf(codex(...rest)), `codex ${rest.join(" ")}`).toBe("banned-flag");
    }
  });

  it("refuses a codex -c and -p override in every short spelling, but not claude -c (continue)", () => {
    for (const rest of [
      ["-c", 'sandbox_mode="danger\\u002dfull\\u002daccess"'],
      ["-c=model=x"],
      ["-cmodel=x"],
      ["-p", "profile"],
      ["-pprofile"],
    ]) {
      expect(reasonOf(codex(...rest)), rest.join(" ")).toBe("banned-flag");
    }
    expect(reasonOf(claude("-c"))).toBeNull();
    expect(reasonOf(claude("--continue"))).toBeNull();
  });

  it("permits --permission-mode only with default, plan or acceptEdits", () => {
    for (const mode of ["default", "plan", "acceptEdits"]) {
      expect(reasonOf(claude("--permission-mode", mode)), mode).toBeNull();
      expect(reasonOf(claude(`--permission-mode=${mode}`)), mode).toBeNull();
    }
    for (const mode of ["auto", "dontAsk", "ACCEPTEDITS", "", "acceptEdits ", "bypass"]) {
      const args = mode === "" ? ["--permission-mode"] : ["--permission-mode", mode];
      expect(reasonOf(claude(...args)), mode).toBe("banned-flag");
    }
    expect(reasonOf(claude("--permission-mode"))).toBe("banned-flag");
    expect(reasonOf(claude("--permission_mode", "auto"))).toBe("banned-flag");
  });

  it("permits codex --sandbox and --ask-for-approval only with the safe values", () => {
    expect(reasonOf(codex("--sandbox", "read-only"))).toBeNull();
    expect(reasonOf(codex("-s", "workspace-write"))).toBeNull();
    expect(reasonOf(codex("--sandbox=read-only"))).toBeNull();
    expect(reasonOf(codex("-sread-only"))).toBeNull();
    expect(reasonOf(codex("--ask-for-approval", "on-request"))).toBeNull();
    expect(reasonOf(codex("-a", "untrusted"))).toBeNull();
    expect(reasonOf(codex("-a=on-failure"))).toBeNull();
    for (const rest of [
      ["--sandbox", "never"],
      ["-s", "anything"],
      ["--sandbox"],
      ["-s"],
      ["--ask-for-approval", "never"],
      ["-a", "never"],
      ["-anever"],
      ["--ask-for-approval"],
    ]) {
      expect(reasonOf(codex(...rest)), rest.join(" ")).toBe("banned-flag");
    }
  });

  it("requires a UUID for claude --resume, -r and --session-id, and for codex resume", () => {
    expect(UUID_RE.test(UUID)).toBe(true);
    for (const flag of ["--resume", "-r", "--session-id"]) {
      expect(reasonOf(claude(flag, UUID)), flag).toBeNull();
      expect(reasonOf(claude(`${flag}=${UUID}`)), flag).toBeNull();
      expect(reasonOf(claude(flag, "not-a-uuid")), flag).toBe("bad-argv");
      expect(reasonOf(claude(flag)), flag).toBe("bad-argv");
      expect(reasonOf(claude(flag, `${UUID} --yolo`)), flag).not.toBeNull();
    }
    expect(reasonOf(codex("resume", UUID))).toBeNull();
    expect(reasonOf(codex("resume"))).toBe("bad-argv");
    expect(reasonOf(codex("resume", "--last"))).toBe("bad-argv");
    expect(reasonOf(codex("resume", "latest"))).toBe("bad-argv");
  });

  it("refuses subcommands that configure, install, log in or execute", () => {
    for (const sub of [
      "mcp",
      "config",
      "plugin",
      "plugins",
      "update",
      "install",
      "setup-token",
      "doctor",
    ]) {
      expect(reasonOf(claude(sub)), sub).toBe("banned-flag");
    }
    for (const sub of [
      "mcp",
      "mcp-server",
      "login",
      "logout",
      "exec",
      "apply",
      "cloud",
      "sandbox",
      "features",
    ]) {
      expect(reasonOf(codex(sub)), sub).toBe("banned-flag");
    }
    expect(reasonOf(claude("--model", "opus", "-n", "a name"))).toBeNull();
  });
});

describe("limits", () => {
  it("argv length 32, element length 4096 are inclusive limits", () => {
    expect(AGENT_ARGV_MAX).toBe(32);
    expect(AGENT_ELEMENT_MAX).toBe(4096);
    expect(
      reasonOf({
        agent: "claude",
        argv: [CLAUDE, ...Array(AGENT_ARGV_MAX - 1).fill("a")],
        env: {},
      }),
    ).toBeNull();
    expect(
      reasonOf({ agent: "claude", argv: [CLAUDE, ...Array(AGENT_ARGV_MAX).fill("a")], env: {} }),
    ).toBe("argv-length");
    expect(reasonOf({ agent: "claude", argv: [], env: {} })).toBe("argv-length");
    expect(reasonOf(claude("x".repeat(AGENT_ELEMENT_MAX)))).toBeNull();
    expect(reasonOf(claude("x".repeat(AGENT_ELEMENT_MAX + 1)))).toBe("argv-element");
  });

  it("a control character wins over a later fault (check order matches the JS validator)", () => {
    expect(
      reasonOf({ agent: "claude", argv: ["relative\u0000", "--yolo"], env: { PATH: "x" } }),
    ).toBe("argv-control");
    expect(reasonOf({ agent: "claude", argv: ["relative", "--yolo"], env: { PATH: "x" } })).toBe(
      "argv0-not-absolute",
    );
    expect(reasonOf({ agent: "claude", argv: [CLAUDE, "--yolo"], env: { PATH: "x" } })).toBe(
      "banned-flag",
    );
  });
});

describe("totality: never throws, never echoes the offending value", () => {
  it("returns a reason code for any hostile input", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      "x",
      [],
      {},
      { agent: "claude" },
      { agent: "claude", argv: "not an array", env: {} },
      { agent: "claude", argv: { length: 1, 0: CLAUDE }, env: {} },
      { agent: "claude", argv: [CLAUDE, 5], env: {} },
      { agent: "claude", argv: [CLAUDE, null], env: {} },
      { agent: "claude", argv: [CLAUDE, Symbol("s")], env: {} },
      { agent: "claude", argv: [CLAUDE], env: null },
      { agent: "claude", argv: new Array(3), env: {} },
      { agent: Symbol("a"), argv: [CLAUDE], env: {} },
      JSON.parse('{"agent":"claude","argv":["/a/claude"],"env":{"__proto__":{"CCC_A":"v"}}}'),
      {
        get agent(): string {
          throw new Error("getter");
        },
        argv: [CLAUDE],
        env: {},
      },
      new Proxy(
        {},
        {
          get() {
            throw new Error("proxy");
          },
          ownKeys() {
            throw new Error("proxy");
          },
        },
      ),
    ];
    for (const input of hostile) {
      expect(() => validateAgentLaunch(input as AgentLaunchInput)).not.toThrow();
      const verdict = validateAgentLaunch(input as AgentLaunchInput);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(AGENT_REASONS).toContain(verdict.reason);
    }
  });

  it("a reason is one of the fixed words and never contains the offending value", () => {
    const secret = "TOPSECRET-VALUE-9f2a";
    for (const input of [
      { agent: "claude", argv: [CLAUDE, `--yolo=${secret}`], env: {} },
      { agent: "claude", argv: [CLAUDE, `${secret}\u0000`], env: {} },
      { agent: "claude", argv: [CLAUDE, "--permission-mode", secret], env: {} },
      { agent: "claude", argv: [CLAUDE], env: { [`CCC_${secret}`]: "v", [secret]: "v" } },
      { agent: "claude", argv: [CLAUDE], env: { CCC_A: `${secret}\n` } },
      { agent: secret, argv: [CLAUDE], env: {} },
    ]) {
      const verdict = validateAgentLaunch(input);
      expect(verdict.ok).toBe(false);
      expect(JSON.stringify(verdict)).not.toContain("TOPSECRET");
      if (!verdict.ok) expect(AGENT_REASONS).toContain(verdict.reason);
    }
  });
});

describe("validateAgentLaunchChecked (the injected filesystem checks)", () => {
  const ROOT = "/Users/USERNAME/repo";
  // A tiny fake filesystem: realDir resolves relative to base and follows the symlink table.
  const links: Record<string, string> = {
    "/Users/USERNAME/repo/escape": "/Users/USERNAME/elsewhere",
    "/Users/USERNAME/repo/inside-link": "/Users/USERNAME/repo/packages/a",
  };
  const dirs = new Set([
    ROOT,
    `${ROOT}/packages`,
    `${ROOT}/packages/a`,
    `${ROOT}/packages/b`,
    "/Users/USERNAME/elsewhere",
    "/Users/USERNAME/repo2",
    "/Users/USERNAME",
  ]);
  const fakeRealDir = (path: string, base: string): string | null => {
    const resolved = posix.resolve(base, path);
    const target = links[resolved] ?? resolved;
    return dirs.has(target) ? target : null;
  };
  const checks = (overrides: Partial<AgentLaunchChecks> = {}): AgentLaunchChecks => ({
    isExecutable: async () => true,
    realDir: async (path, base) => fakeRealDir(path, base),
    ...overrides,
  });
  const launch = (
    agent: "claude" | "codex",
    rest: string[],
    extra: Partial<CheckedAgentLaunchInput> = {},
  ): CheckedAgentLaunchInput => ({
    agent,
    argv: [agent === "claude" ? CLAUDE : CODEX, ...rest],
    env: {},
    projectRoot: ROOT,
    ...extra,
  });
  const verdictOf = async (input: CheckedAgentLaunchInput, c = checks()) =>
    validateAgentLaunchChecked(input, c);

  it("accepts a good launch and returns the real project root and cwd", async () => {
    expect(await verdictOf(launch("claude", ["--model", "opus"]))).toEqual({
      ok: true,
      projectRoot: ROOT,
      cwd: ROOT,
    });
    expect(await verdictOf(launch("claude", [], { cwd: `${ROOT}/packages/a` }))).toEqual({
      ok: true,
      projectRoot: ROOT,
      cwd: `${ROOT}/packages/a`,
    });
  });

  it("runs the pure shape first: a shape refusal never reaches the filesystem checks", async () => {
    const isExecutable = vi.fn(async () => true);
    const realDir = vi.fn(async () => ROOT);
    const verdict = await validateAgentLaunchChecked(
      { agent: "claude", argv: [CLAUDE, "--yolo"], env: {}, projectRoot: ROOT },
      { isExecutable, realDir },
    );
    expect(verdict).toEqual({ ok: false, reason: "banned-flag" });
    expect(isExecutable).not.toHaveBeenCalled();
  });

  it("refuses an argv[0] that is not an executable file, asking the check about argv[0] only", async () => {
    const isExecutable = vi.fn(async () => false);
    expect(await verdictOf(launch("claude", []), checks({ isExecutable }))).toEqual({
      ok: false,
      reason: "argv0-not-executable",
    });
    expect(isExecutable).toHaveBeenCalledTimes(1);
    expect(isExecutable).toHaveBeenCalledWith(CLAUDE);
  });

  it("refuses a project root that is not a real directory or not absolute", async () => {
    expect(
      await verdictOf(launch("claude", [], { projectRoot: "/Users/USERNAME/nowhere" })),
    ).toEqual({
      ok: false,
      reason: "project-root",
    });
    expect(await verdictOf(launch("claude", [], { projectRoot: "repo" }))).toEqual({
      ok: false,
      reason: "project-root",
    });
  });

  it("refuses a cwd that is missing, outside the project, a sibling with a shared prefix or a symlink out", async () => {
    expect(await verdictOf(launch("claude", [], { cwd: `${ROOT}/gone` }))).toEqual({
      ok: false,
      reason: "cwd-not-directory",
    });
    for (const cwd of [
      "/Users/USERNAME/elsewhere",
      "/Users/USERNAME/repo2",
      `${ROOT}/escape`,
      `${ROOT}/..`,
    ]) {
      expect(await verdictOf(launch("claude", [], { cwd })), cwd).toEqual({
        ok: false,
        reason: "cwd-outside",
      });
    }
    expect(await verdictOf(launch("claude", [], { cwd: `${ROOT}/inside-link` }))).toEqual({
      ok: true,
      projectRoot: ROOT,
      cwd: `${ROOT}/packages/a`,
    });
  });

  it("refuses --add-dir, -C and --cd arguments outside the project after realpath", async () => {
    const refused = async (agent: "claude" | "codex", rest: string[]) =>
      verdictOf(launch(agent, rest));
    const outside = { ok: false, reason: "dir-argument-outside" };
    expect(await refused("claude", ["--add-dir", "/Users/USERNAME/elsewhere"])).toEqual(outside);
    expect(await refused("claude", ["--add-dir=/Users/USERNAME/elsewhere"])).toEqual(outside);
    expect(await refused("claude", ["--add-dir", "../elsewhere"])).toEqual(outside);
    expect(await refused("claude", ["--add-dir", "escape"])).toEqual(outside);
    expect(await refused("claude", ["--add-dir", "/Users/USERNAME/repo2"])).toEqual(outside);
    expect(
      await refused("claude", ["--add-dir", "packages/a", "/Users/USERNAME/elsewhere"]),
    ).toEqual(outside);
    expect(await refused("claude", ["--add-dir", "packages/missing"])).toEqual(outside);
    expect(await refused("claude", ["--add-dir"])).toEqual(outside);
    expect(await refused("codex", ["-C", "/Users/USERNAME/elsewhere"])).toEqual(outside);
    expect(await refused("codex", ["-C/Users/USERNAME/elsewhere"])).toEqual(outside);
    expect(await refused("codex", ["--cd", "../elsewhere"])).toEqual(outside);
    expect(await refused("codex", ["--cd=escape"])).toEqual(outside);
    expect(await refused("codex", ["--add-dir", "escape"])).toEqual(outside);
    expect(await refused("codex", ["-C"])).toEqual(outside);
  });

  it("accepts directory arguments that resolve inside the project, relative to the cwd", async () => {
    expect((await verdictOf(launch("claude", ["--add-dir", "packages/a", "packages/b"]))).ok).toBe(
      true,
    );
    expect((await verdictOf(launch("codex", ["--cd", "packages/a"]))).ok).toBe(true);
    expect((await verdictOf(launch("codex", ["-C", ROOT]))).ok).toBe(true);
    expect(
      (await verdictOf(launch("claude", ["--add-dir", "../b"], { cwd: `${ROOT}/packages/a` }))).ok,
    ).toBe(true);
    expect((await verdictOf(launch("claude", ["--add-dir", "inside-link"]))).ok).toBe(true);
  });

  it("never throws when an injected check throws: it refuses", async () => {
    const boom = async () => {
      throw new Error("disk");
    };
    const verdict = await verdictOf(launch("claude", []), checks({ isExecutable: boom }));
    expect(verdict.ok).toBe(false);
    const verdict2 = await verdictOf(launch("claude", []), checks({ realDir: boom }));
    expect(verdict2.ok).toBe(false);
  });
});
