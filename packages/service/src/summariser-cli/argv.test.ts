import { describe, expect, it } from "vitest";
import {
  buildClaudeArgv,
  buildClaudeChildEnv,
  CLAUDE_AUTH_STATUS_ARGV,
  CLAUDE_CHILD_ENV_KEYS,
} from "./argv.js";

/** One-line comparison: a failure prints a single-line diff, which the RED classifier can read. */
const json = (value: unknown): string => JSON.stringify(value);

const PINNED = (model: string, instructions: string): string[] => [
  "-p",
  "--model",
  model,
  "--tools",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--setting-sources",
  "",
  "--safe-mode",
  "--no-session-persistence",
  "--max-turns",
  "1",
  "--permission-prompts",
  "none",
  "--system-prompt",
  instructions,
  "--output-format",
  "stream-json",
  "--verbose",
];

const FORBIDDEN_FLAGS = [
  "--bare",
  "--mcp-config",
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--plugin-dir",
  "--settings",
  "--agents",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--system-prompt-file",
  "--append-system-prompt",
];

describe("buildClaudeArgv (Test 1)", () => {
  it("is exactly the pinned 20-element array, in order", () => {
    const argv = buildClaudeArgv({ model: "claude-haiku-5-5", instructions: "I" });
    expect(json(argv)).toBe(json(PINNED("claude-haiku-5-5", "I")));
    expect(argv).toHaveLength(20);
  });

  it("carries the other allowed model and the instructions as one element", () => {
    const text = "You summarise.\nSecond line with --flag-looking words inside.";
    const argv = buildClaudeArgv({ model: "claude-sonnet-5-5", instructions: text });
    expect(json(argv)).toBe(json(PINNED("claude-sonnet-5-5", text)));
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe(text);
  });

  it("passes the empty tools and setting-sources values as elements followed by a flag", () => {
    const argv = buildClaudeArgv({ model: "claude-haiku-5-5", instructions: "I" });
    for (const flag of ["--tools", "--setting-sources"]) {
      const at = argv.indexOf(flag);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(argv[at + 1]).toBe("");
      expect(argv[at + 2]?.startsWith("--")).toBe(true);
    }
  });

  it("has no positional prompt and none of the forbidden flags", () => {
    const argv = buildClaudeArgv({ model: "claude-haiku-5-5", instructions: "I" });
    for (const flag of FORBIDDEN_FLAGS) expect(argv).not.toContain(flag);
    // Every element is a flag or the value of the flag before it: the last element is a flag.
    expect(argv.at(-1)).toBe("--verbose");
    expect(argv[0]).toBe("-p");
  });

  it("is a fresh array each call (a caller cannot corrupt the next one)", () => {
    const a = buildClaudeArgv({ model: "claude-haiku-5-5", instructions: "I" }) as string[];
    a.push("--bare");
    expect(buildClaudeArgv({ model: "claude-haiku-5-5", instructions: "I" })).toHaveLength(20);
  });

  it("refuses instructions that are empty, hold a NUL or could read as a flag, naming none of the text", () => {
    for (const bad of ["", "ab\0cd", "--tools x", "-p"]) {
      let message = "";
      try {
        buildClaudeArgv({ model: "claude-haiku-5-5", instructions: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      if (bad.length > 1) expect(message).not.toContain(bad);
    }
  });

  it("names the readiness argv and the env keys", () => {
    expect(json(CLAUDE_AUTH_STATUS_ARGV)).toBe(json(["auth", "status"]));
    expect(json([...CLAUDE_CHILD_ENV_KEYS])).toBe(
      json(["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH"]),
    );
  });
});

describe("buildClaudeChildEnv (Test 2)", () => {
  const PARENT = {
    HOME: "/Users/USERNAME",
    USER: "USERNAME",
    ANTHROPIC_API_KEY: "x",
    ANTHROPIC_AUTH_TOKEN: "x",
    ANTHROPIC_BASE_URL: "x",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "/x",
    HTTPS_PROXY: "x",
    NODE_EXTRA_CA_CERTS: "x",
    NODE_OPTIONS: "x",
    TMPDIR: "/t/",
  };

  it("has exactly HOME, USER, TMPDIR, LANG and PATH", () => {
    expect(json(buildClaudeChildEnv(PARENT))).toBe(
      json({
        HOME: "/Users/USERNAME",
        USER: "USERNAME",
        TMPDIR: "/t/",
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin",
      }),
    );
  });

  it("adds LOGNAME when the parent has a plain one, and nothing else", () => {
    const env = buildClaudeChildEnv({ ...PARENT, LOGNAME: "USERNAME" });
    expect(json(env)).toBe(
      json({
        HOME: "/Users/USERNAME",
        USER: "USERNAME",
        LOGNAME: "USERNAME",
        TMPDIR: "/t/",
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin",
      }),
    );
    expect(
      Object.keys(env ?? {}).every((k) => (CLAUDE_CHILD_ENV_KEYS as readonly string[]).includes(k)),
    ).toBe(true);
  });

  it("is null when HOME or USER is missing, empty, relative or not plain", () => {
    const { USER: _u, ...noUser } = PARENT;
    const { HOME: _h, ...noHome } = PARENT;
    expect(buildClaudeChildEnv(noUser)).toBeNull();
    expect(buildClaudeChildEnv(noHome)).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, HOME: "relative/home" })).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, HOME: "" })).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, HOME: "/Users/USERNAME\n" })).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, HOME: "/Users/USER\0NAME" })).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, USER: "" })).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, USER: "a b" })).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, USER: "/Users/USERNAME" })).toBeNull();
  });

  it("is null when the parent has no usable TMPDIR", () => {
    const { TMPDIR: _t, ...noTmp } = PARENT;
    expect(buildClaudeChildEnv(noTmp)).toBeNull();
    expect(buildClaudeChildEnv({ ...PARENT, TMPDIR: "tmp" })).toBeNull();
  });

  it("drops an unusable LOGNAME instead of copying it", () => {
    const env = buildClaudeChildEnv({ ...PARENT, LOGNAME: "bad name\n" });
    expect(env).not.toBeNull();
    expect(env).not.toHaveProperty("LOGNAME");
  });

  it("never copies a credential, endpoint, proxy, TLS or runtime variable", () => {
    const env = buildClaudeChildEnv(PARENT) ?? {};
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/^(ANTHROPIC_|CLAUDE_|NODE_|.*PROXY|SSL_|AWS_|GOOGLE_)/i);
    }
  });
});
