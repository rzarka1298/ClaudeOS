import { describe, expect, it } from "vitest";
import type { ProjectId } from "./ids.js";
import {
  DetectionResponseSchema,
  LAUNCH_ACTIONS,
  LAUNCH_ERROR_KINDS,
  LAUNCH_PAIR_ACTION,
  LAUNCH_PAIR_PATH,
  LAUNCH_PATH,
  LAUNCHER_IDS,
  LAUNCHER_TEST_AUTOMATION_CAP_MS,
  LauncherConfigRefusalBodySchema,
  LauncherConfigViewSchema,
  LaunchPairRequestSchema,
  LaunchPairResponseSchema,
  LaunchRequestSchema,
  type LaunchResult,
  LaunchResultSchema,
  launchErrorKindSchema,
  PairAgentResultSchema,
  parseStoredLauncherConfig,
  REFUSED_TEMPLATES,
  SaveLauncherConfigRequestSchema,
  StoredCodexConfigSchema,
  SystemSettingsPaneSchema,
  TEMPLATE_REFUSAL_REASONS,
  TEST_LAUNCHER_IDS,
  type TerminalLauncher,
  type TerminalLaunchInput,
  TestLauncherRequestSchema,
  terminalMayPromptForAutomation,
} from "./launch.js";

const PROJECT_ID = "0000000000123456789abcdef";
const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c0d1";
const LINE_FEED = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);

describe("launch vocabulary (D-26, D-06)", () => {
  it("LAUNCH_ERROR_KINDS is the ten D-26 members in D-26 order, then the three bridge kinds (D-09)", () => {
    expect(LAUNCH_ERROR_KINDS).toEqual([
      "service-disconnected",
      "launcher-not-configured",
      "app-not-found",
      "project-missing",
      "project-moved",
      "no-github-remote",
      "automation-denied",
      "folder-access-denied",
      "timeout",
      "spawn-failed",
      "bridge-not-installed",
      "bridge-outdated",
      "window-not-ready",
    ]);
    expect(LAUNCH_ERROR_KINDS.length).toBe(13);
  });

  it("launchErrorKindSchema accepts the three bridge kinds and refuses an unknown one", () => {
    for (const kind of ["bridge-not-installed", "bridge-outdated", "window-not-ready"]) {
      expect(launchErrorKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(launchErrorKindSchema.safeParse("bridge-exploded").success).toBe(false);
  });

  it("LAUNCH_ACTIONS and LAUNCHER_IDS are exact", () => {
    expect(LAUNCH_ACTIONS).toEqual([
      "antigravity",
      "claude-code",
      "finder",
      "github",
      "claude-desktop",
    ]);
    expect(LAUNCHER_IDS).toEqual(["antigravity", "claude-code", "claude-desktop", "codex"]);
  });

  it("places the launch route under the versioned API base", () => {
    expect(LAUNCH_PATH).toBe("/api/v1/projects/launch");
  });
});

describe("LaunchRequestSchema", () => {
  it("accepts a finder request with a projectId and a claude-desktop request without one", () => {
    expect(LaunchRequestSchema.safeParse({ action: "finder", projectId: PROJECT_ID }).success).toBe(
      true,
    );
    expect(LaunchRequestSchema.safeParse({ action: "claude-desktop" }).success).toBe(true);
    for (const action of ["antigravity", "claude-code", "github"]) {
      expect(LaunchRequestSchema.safeParse({ action, projectId: PROJECT_ID }).success, action).toBe(
        true,
      );
    }
  });

  it("rejects a project action without a projectId", () => {
    expect(LaunchRequestSchema.safeParse({ action: "finder" }).success).toBe(false);
  });

  it("rejects a claude-desktop request that carries a projectId", () => {
    expect(
      LaunchRequestSchema.safeParse({ action: "claude-desktop", projectId: PROJECT_ID }).success,
    ).toBe(false);
  });

  it("rejects any request carrying a path key (D-06, T-04-05)", () => {
    for (const action of LAUNCH_ACTIONS) {
      const body =
        action === "claude-desktop"
          ? { action, path: "/Users/USERNAME/code/example-project" }
          : { action, projectId: PROJECT_ID, path: "/Users/USERNAME/code/example-project" };
      expect(LaunchRequestSchema.safeParse(body).success, action).toBe(false);
    }
  });

  it("rejects an unknown action", () => {
    expect(LaunchRequestSchema.safeParse({ action: "vscode", projectId: PROJECT_ID }).success).toBe(
      false,
    );
  });
});

describe("LaunchResultSchema", () => {
  it("accepts success and a typed failure", () => {
    expect(LaunchResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(LaunchResultSchema.safeParse({ ok: false, error: "timeout" }).success).toBe(true);
  });

  it("rejects an unknown error kind and any free-text message", () => {
    expect(LaunchResultSchema.safeParse({ ok: false, error: "other" }).success).toBe(false);
    expect(
      LaunchResultSchema.safeParse({ ok: false, error: "timeout", message: "x" }).success,
    ).toBe(false);
  });
});

describe("SaveLauncherConfigRequestSchema (D-19, D-22, UI-SPEC S7)", () => {
  const claudeCode = {
    launcherId: "claude-code",
    executable: { kind: "candidate", candidateId: "c0" },
    args: [],
    terminal: { kind: "terminal-app" },
  };

  it("accepts an app launcher with a bundle ID", () => {
    expect(
      SaveLauncherConfigRequestSchema.safeParse({
        launcherId: "antigravity",
        bundleId: "com.google.antigravity",
      }).success,
    ).toBe(true);
    expect(
      SaveLauncherConfigRequestSchema.safeParse({
        launcherId: "claude-desktop",
        bundleId: "com.example.app",
      }).success,
    ).toBe(true);
  });

  it("rejects a malformed or over-long bundle ID", () => {
    for (const bundleId of ["com example app", "com/example", "", `com.${"a".repeat(252)}`]) {
      expect(
        SaveLauncherConfigRequestSchema.safeParse({ launcherId: "antigravity", bundleId }).success,
        bundleId.slice(0, 20),
      ).toBe(false);
    }
  });

  it("accepts a Claude Code config with a detected executable, no args and Terminal", () => {
    expect(SaveLauncherConfigRequestSchema.safeParse(claudeCode).success).toBe(true);
    expect(
      SaveLauncherConfigRequestSchema.safeParse({
        ...claudeCode,
        executable: { kind: "path", path: "/Users/USERNAME/.local/bin/claude" },
        args: ["{projectPath}"],
      }).success,
    ).toBe(true);
  });

  it("caps Claude Code args at 31 so executable plus args stay within 32", () => {
    const args = (n: number) => Array.from({ length: n }, (_, i) => `--flag-${i}`);
    expect(
      SaveLauncherConfigRequestSchema.safeParse({ ...claudeCode, args: args(31) }).success,
    ).toBe(true);
    expect(
      SaveLauncherConfigRequestSchema.safeParse({ ...claudeCode, args: args(32) }).success,
    ).toBe(false);
  });

  it("caps a custom terminal argv at 32", () => {
    const terminal = (n: number) => ({
      kind: "custom",
      preset: "blank",
      argv: ["/usr/bin/open", ...Array.from({ length: n - 2 }, () => "-a"), "{script}"],
    });
    expect(
      SaveLauncherConfigRequestSchema.safeParse({ ...claudeCode, terminal: terminal(32) }).success,
    ).toBe(true);
    expect(
      SaveLauncherConfigRequestSchema.safeParse({ ...claudeCode, terminal: terminal(33) }).success,
    ).toBe(false);
  });

  it("rejects any argument containing a line break", () => {
    for (const bad of [`a${LINE_FEED}b`, `a${CARRIAGE_RETURN}b`]) {
      expect(
        SaveLauncherConfigRequestSchema.safeParse({ ...claudeCode, args: [bad] }).success,
      ).toBe(false);
      expect(
        SaveLauncherConfigRequestSchema.safeParse({
          ...claudeCode,
          terminal: { kind: "custom", preset: "blank", argv: ["/usr/bin/open", bad] },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an empty argument and an unknown key", () => {
    expect(SaveLauncherConfigRequestSchema.safeParse({ ...claudeCode, args: [""] }).success).toBe(
      false,
    );
    expect(
      SaveLauncherConfigRequestSchema.safeParse({
        launcherId: "antigravity",
        bundleId: "com.example.app",
        command: "open",
      }).success,
    ).toBe(false);
  });
});

describe("DetectionResponseSchema terminal presets (D-23, D-27)", () => {
  const apps = {
    antigravity: [],
    "claude-desktop": [],
    iterm2: [],
    ghostty: [],
    wezterm: [],
    terminal: [],
  };
  const detection = (argv: string[]) => ({
    detectedAt: "2026-09-26T00:00:00.000Z",
    apps,
    claudeExecutables: [],
    terminalPresets: [{ id: "blank", label: "Blank template", argv, verified: false }],
    git: "available",
  });

  it("carries the blank preset's empty executable placeholder", () => {
    expect(DetectionResponseSchema.safeParse(detection(["", "{script}"])).success).toBe(true);
  });

  it("still refuses a line break or control character in a preset element", () => {
    expect(DetectionResponseSchema.safeParse(detection(["/bin/x\n", "{script}"])).success).toBe(
      false,
    );
    expect(
      DetectionResponseSchema.safeParse(detection([`/bin/${String.fromCharCode(7)}`, "{script}"]))
        .success,
    ).toBe(false);
  });

  it("a saved custom terminal still refuses the empty placeholder", () => {
    expect(
      SaveLauncherConfigRequestSchema.safeParse({
        launcherId: "claude-code",
        executable: { kind: "candidate", candidateId: "c0" },
        args: [],
        terminal: { kind: "custom", preset: "blank", argv: ["", "{script}"] },
      }).success,
    ).toBe(false);
  });
});

describe("SystemSettingsPaneSchema (RR-16, PR-10)", () => {
  it("accepts exactly automation and privacy-security", () => {
    expect(SystemSettingsPaneSchema.safeParse("automation").success).toBe(true);
    expect(SystemSettingsPaneSchema.safeParse("privacy-security").success).toBe(true);
    expect(SystemSettingsPaneSchema.safeParse("files-and-folders").success).toBe(false);
    expect(
      SystemSettingsPaneSchema.safeParse("x-apple.systempreferences:com.apple.preference").success,
    ).toBe(false);
  });
});

describe("parseStoredLauncherConfig", () => {
  it("returns an app config and a Claude Code config", () => {
    expect(
      parseStoredLauncherConfig("antigravity", { bundleId: "com.google.antigravity" }),
    ).toEqual({ bundleId: "com.google.antigravity" });
    const claudeCode = {
      executablePath: "/Users/USERNAME/.local/bin/claude",
      args: ["{projectPath}"],
      terminal: { kind: "terminal-app" },
    };
    expect(parseStoredLauncherConfig("claude-code", claudeCode)).toEqual(claudeCode);
  });

  it("returns null for a relative executable, a missing field or an unknown launcher id", () => {
    expect(
      parseStoredLauncherConfig("claude-code", {
        executablePath: "bin/claude",
        args: [],
        terminal: { kind: "terminal-app" },
      }),
    ).toBeNull();
    expect(
      parseStoredLauncherConfig("claude-code", {
        executablePath: "/Users/USERNAME/.local/bin/claude",
        args: [],
      }),
    ).toBeNull();
    expect(parseStoredLauncherConfig("finder", { bundleId: "com.apple.finder" })).toBeNull();
    expect(parseStoredLauncherConfig("claude-desktop", {})).toBeNull();
  });
});

describe("Antigravity terminal choice (D-07)", () => {
  const CLAUDE_PATH = "/Users/USERNAME/.local/bin/claude";

  it("round-trips a stored Claude Code config whose terminal is the strict antigravity-terminal object", () => {
    const stored = {
      executablePath: CLAUDE_PATH,
      args: [],
      terminal: { kind: "antigravity-terminal" },
    };
    expect(parseStoredLauncherConfig("claude-code", stored)).toEqual(stored);
  });

  it("refuses an extra key on the antigravity-terminal object", () => {
    expect(
      parseStoredLauncherConfig("claude-code", {
        executablePath: CLAUDE_PATH,
        args: [],
        terminal: { kind: "antigravity-terminal", preset: "iterm2" },
      }),
    ).toBeNull();
  });

  it("is accepted by the save request and refused with a preset or argv key", () => {
    const base = {
      launcherId: "claude-code",
      executable: { kind: "path", path: CLAUDE_PATH },
      args: [],
    };
    expect(
      SaveLauncherConfigRequestSchema.safeParse({
        ...base,
        terminal: { kind: "antigravity-terminal" },
      }).success,
    ).toBe(true);
    for (const extra of [{ preset: "iterm2" }, { argv: ["x"] }]) {
      expect(
        SaveLauncherConfigRequestSchema.safeParse({
          ...base,
          terminal: { kind: "antigravity-terminal", ...extra },
        }).success,
      ).toBe(false);
    }
  });

  it("never prompts for macOS Automation", () => {
    expect(terminalMayPromptForAutomation({ kind: "antigravity-terminal" })).toBe(false);
  });
});

describe("launcher-config refusal body (PR-13)", () => {
  it("carries a reason enum and an argument index, never a path", () => {
    expect(TEMPLATE_REFUSAL_REASONS).toContain("forbidden-flag");
    expect(TEMPLATE_REFUSAL_REASONS).toHaveLength(11);
    expect(
      LauncherConfigRefusalBodySchema.safeParse({
        error: "launcher config refused",
        reason: "embedded-placeholder",
        index: 2,
      }).success,
    ).toBe(true);
    expect(
      LauncherConfigRefusalBodySchema.safeParse({
        error: "launcher config refused",
        reason: "bundle-not-found",
        index: null,
      }).success,
    ).toBe(true);
    expect(
      LauncherConfigRefusalBodySchema.safeParse({
        error: "launcher config refused",
        reason: "/Users/USERNAME/.local/bin/claude",
        index: null,
      }).success,
    ).toBe(false);
  });

  it("may say which template a refusal is about, and nothing else", () => {
    const body = {
      error: "launcher config refused",
      reason: "forbidden-flag",
      index: 1,
      template: "terminal",
    };
    expect(LauncherConfigRefusalBodySchema.parse(body)).toEqual(body);
    expect(
      LauncherConfigRefusalBodySchema.safeParse({ ...body, template: "/usr/bin/open" }).success,
    ).toBe(false);
  });

  it("a test request names one of the five launch actions and nothing else (D-28, RR-15)", () => {
    for (const launcherId of LAUNCH_ACTIONS) {
      expect(TestLauncherRequestSchema.safeParse({ launcherId }).success).toBe(true);
    }
    expect(TestLauncherRequestSchema.safeParse({ launcherId: "terminal" }).success).toBe(false);
    expect(TestLauncherRequestSchema.safeParse({ launcherId: "codex" }).success).toBe(true);
    expect(TEST_LAUNCHER_IDS).toEqual([...LAUNCH_ACTIONS, "codex"]);
    expect(
      TestLauncherRequestSchema.safeParse({ launcherId: "finder", path: "/Applications" }).success,
    ).toBe(false);
  });

  it("only an osascript custom terminal can raise the Automation prompt in a Test", () => {
    expect(terminalMayPromptForAutomation({ kind: "terminal-app" })).toBe(false);
    expect(
      terminalMayPromptForAutomation({
        kind: "custom",
        preset: "iterm2",
        argv: ["/usr/bin/osascript", "-e", "on run argv", "{script}"],
      }),
    ).toBe(true);
    expect(
      terminalMayPromptForAutomation({
        kind: "custom",
        preset: "ghostty",
        argv: ["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "{script}"],
      }),
    ).toBe(false);
    expect(LAUNCHER_TEST_AUTOMATION_CAP_MS).toBeGreaterThan(4000);
  });
});

describe("TerminalLauncher port (D-49, PR-07)", () => {
  it("accepts an input without env and one with env", async () => {
    const seen: TerminalLaunchInput[] = [];
    const launcher: TerminalLauncher = {
      launch(input: TerminalLaunchInput): Promise<LaunchResult> {
        seen.push(input);
        return Promise.resolve({ ok: true });
      },
    };
    const signal = new AbortController().signal;
    const withoutEnv: TerminalLaunchInput = {
      cwd: "/Users/USERNAME/code/example-project",
      argv: ["/usr/bin/true"],
      signal,
    };
    const withEnv: TerminalLaunchInput = {
      cwd: "/Users/USERNAME/code/example-project",
      argv: ["/usr/bin/true"],
      env: { CCC_RUN_ID: "run-1" },
      signal,
    };
    await expect(launcher.launch(withoutEnv)).resolves.toEqual({ ok: true });
    await expect(launcher.launch(withEnv)).resolves.toEqual({ ok: true });
    expect(seen[1]?.env).toEqual({ CCC_RUN_ID: "run-1" });
  });

  it("carries the launch's AbortSignal, so an adapter can refuse to open after the cap", () => {
    const controller = new AbortController();
    const input: TerminalLaunchInput = {
      cwd: "/Users/USERNAME/code/example-project",
      argv: ["/usr/bin/true"],
      signal: controller.signal,
    };
    controller.abort();
    expect(input.signal.aborted).toBe(true);
  });

  it("a ProjectId-typed lookup key compiles against the port shapes", () => {
    const id = PROJECT_ID as ProjectId;
    expect(id).toBe(PROJECT_ID);
  });
});

const CODEX_PATH = "/Users/USERNAME/.local/bin/codex";

describe("Codex launcher config (D-11)", () => {
  it("StoredCodexConfigSchema accepts an absolute executable and up to 31 arguments", () => {
    expect(
      StoredCodexConfigSchema.safeParse({ executablePath: CODEX_PATH, args: [] }).success,
    ).toBe(true);
    expect(
      StoredCodexConfigSchema.safeParse({
        executablePath: CODEX_PATH,
        args: Array.from({ length: 31 }, () => "a"),
      }).success,
    ).toBe(true);
  });

  it("refuses a relative path, a 32nd argument, an empty argument and any extra key including terminal", () => {
    const refuses = (value: unknown): boolean => !StoredCodexConfigSchema.safeParse(value).success;
    expect(refuses({ executablePath: "bin/codex", args: [] })).toBe(true);
    expect(
      refuses({ executablePath: CODEX_PATH, args: Array.from({ length: 32 }, () => "a") }),
    ).toBe(true);
    expect(refuses({ executablePath: CODEX_PATH, args: [""] })).toBe(true);
    expect(
      refuses({ executablePath: CODEX_PATH, args: [], terminal: { kind: "terminal-app" } }),
    ).toBe(true);
    expect(refuses({ executablePath: CODEX_PATH, args: [], extra: 1 })).toBe(true);
  });

  it("parseStoredLauncherConfig('codex') returns the object or null", () => {
    const stored = { executablePath: CODEX_PATH, args: ["{projectPath}"] };
    expect(parseStoredLauncherConfig("codex", stored)).toEqual(stored);
    expect(parseStoredLauncherConfig("codex", { executablePath: "codex", args: [] })).toBeNull();
    expect(parseStoredLauncherConfig("codex", { bundleId: "com.openai.codex" })).toBeNull();
  });

  it("the save request has a codex branch that refuses a terminal key", () => {
    const base = { launcherId: "codex", executable: { kind: "path", path: CODEX_PATH }, args: [] };
    expect(SaveLauncherConfigRequestSchema.safeParse(base).success).toBe(true);
    expect(
      SaveLauncherConfigRequestSchema.safeParse({
        launcherId: "codex",
        executable: { kind: "candidate", candidateId: "c1" },
        args: ["--flag"],
      }).success,
    ).toBe(true);
    expect(
      SaveLauncherConfigRequestSchema.safeParse({ ...base, terminal: { kind: "terminal-app" } })
        .success,
    ).toBe(false);
  });

  it("REFUSED_TEMPLATES contains codex and the refusal body accepts it", () => {
    expect(REFUSED_TEMPLATES).toContain("codex");
    expect(
      LauncherConfigRefusalBodySchema.safeParse({
        error: "launcher config refused",
        reason: "forbidden-flag",
        index: 1,
        template: "codex",
      }).success,
    ).toBe(true);
  });
});

describe("pair launch contract (D-10, CODEX-02)", () => {
  it("has its own path and leaves LAUNCH_ACTIONS at five entries", () => {
    expect(LAUNCH_PAIR_PATH).toBe("/api/v1/projects/launch-pair");
    expect(LAUNCH_PAIR_ACTION).toBe("claude-codex-pair");
    expect(LAUNCH_ACTIONS).toHaveLength(5);
    expect(
      LaunchRequestSchema.safeParse({ action: "claude-codex-pair", projectId: PROJECT_ID }).success,
    ).toBe(false);
  });

  it("LaunchPairRequestSchema accepts only projectId and an optional guard choice", () => {
    expect(LaunchPairRequestSchema.safeParse({ projectId: PROJECT_ID }).success).toBe(true);
    expect(
      LaunchPairRequestSchema.safeParse({ projectId: PROJECT_ID, choice: { kind: "plan" } })
        .success,
    ).toBe(true);
    for (const key of ["path", "argv", "executable", "agent", "shell"]) {
      expect(
        LaunchPairRequestSchema.safeParse({ projectId: PROJECT_ID, [key]: "x" }).success,
        key,
      ).toBe(false);
    }
    expect(LaunchPairRequestSchema.safeParse({}).success).toBe(false);
  });

  it("PairAgentResultSchema accepts opened, error with one kind, and setup", () => {
    expect(PairAgentResultSchema.safeParse({ status: "opened" }).success).toBe(true);
    expect(PairAgentResultSchema.safeParse({ status: "setup" }).success).toBe(true);
    for (const error of LAUNCH_ERROR_KINDS) {
      expect(PairAgentResultSchema.safeParse({ status: "error", error }).success, error).toBe(true);
    }
    expect(PairAgentResultSchema.safeParse({ status: "error" }).success).toBe(false);
    expect(PairAgentResultSchema.safeParse({ status: "error", error: "nope" }).success).toBe(false);
    expect(PairAgentResultSchema.safeParse({ status: "opened", error: "timeout" }).success).toBe(
      false,
    );
  });

  it("LaunchPairResponseSchema accepts the envelope and the guard conflict, nothing else", () => {
    const opened = { status: "opened" };
    expect(LaunchPairResponseSchema.safeParse({ claude: opened, codex: opened }).success).toBe(
      true,
    );
    expect(
      LaunchPairResponseSchema.safeParse({ claude: opened, codex: { status: "setup" } }).success,
    ).toBe(true);
    expect(
      LaunchPairResponseSchema.safeParse({
        claude: { status: "error", error: "bridge-outdated" },
        codex: { status: "error", error: "window-not-ready" },
      }).success,
    ).toBe(true);
    expect(
      LaunchPairResponseSchema.safeParse({
        ok: false,
        conflict: {
          projectName: "p",
          conflicts: [{ runId: RUN_ID, sessionName: "s", state: "running", lastActivityAt: null }],
        },
      }).success,
    ).toBe(true);
    expect(LaunchPairResponseSchema.safeParse({ claude: opened }).success).toBe(false);
    expect(LaunchPairResponseSchema.safeParse({ codex: opened }).success).toBe(false);
    expect(
      LaunchPairResponseSchema.safeParse({ claude: opened, codex: opened, gemini: opened }).success,
    ).toBe(false);
  });

  it("the claude result never carries the setup status", () => {
    const opened = { status: "opened" };
    expect(
      LaunchPairResponseSchema.safeParse({ claude: { status: "setup" }, codex: opened }).success,
    ).toBe(false);
  });
});

describe("additive configuration and detection views (D-11, D-12, CODEX-03)", () => {
  const olderConfig = { antigravity: null, "claude-code": null, "claude-desktop": null };

  it("LauncherConfigViewSchema parses an older answer, and a newer one with or without codex", () => {
    expect(LauncherConfigViewSchema.safeParse(olderConfig).success).toBe(true);
    expect(LauncherConfigViewSchema.safeParse({ ...olderConfig, codex: null }).success).toBe(true);
    expect(
      LauncherConfigViewSchema.safeParse({
        ...olderConfig,
        codex: { executableDisplay: "~/.local/bin/codex", args: [], tested: false },
      }).success,
    ).toBe(true);
    expect(
      LauncherConfigViewSchema.safeParse({
        ...olderConfig,
        codex: { executableDisplay: "~/.local/bin/codex", args: [], tested: false, terminal: {} },
      }).success,
    ).toBe(false);
  });

  const apps = {
    antigravity: [],
    "claude-desktop": [],
    iterm2: [],
    ghostty: [],
    wezterm: [],
    terminal: [],
  };
  const olderDetection = {
    detectedAt: "2026-10-10T00:00:00.000Z",
    apps,
    claudeExecutables: [],
    terminalPresets: [],
    git: "available",
  };

  it("DetectionResponseSchema parses an older answer and a newer one with candidates, health, bridge and a suggestion", () => {
    expect(DetectionResponseSchema.safeParse(olderDetection).success).toBe(true);
    const newer = {
      ...olderDetection,
      codex: {
        executables: [
          {
            candidateId: "c1",
            displayPath: "~/.local/bin/codex",
            version: "0.159.2",
            location: "user-install",
          },
          {
            candidateId: "c2",
            displayPath: "/Applications/ChatGPT.app",
            version: null,
            location: "app-bundle",
          },
        ],
        doctor: "unknown",
      },
      bridge: "installed",
      suggestedTerminal: { kind: "antigravity-terminal" },
    };
    expect(DetectionResponseSchema.safeParse(newer).success).toBe(true);
    expect(DetectionResponseSchema.safeParse({ ...newer, bridge: "installed-idle" }).success).toBe(
      true,
    );
    expect(DetectionResponseSchema.safeParse({ ...newer, bridge: "melted" }).success).toBe(false);
    expect(
      DetectionResponseSchema.safeParse({
        ...newer,
        codex: { ...newer.codex, executables: [{ ...newer.codex.executables[0], path: "/x" }] },
      }).success,
    ).toBe(false);
  });

  it("DetectionResponseSchema accepts the versions CODEX_VERSION_PATTERN accepts (prerelease) and keeps the length bound", () => {
    const withVersion = (version: string | null) => ({
      ...olderDetection,
      codex: {
        executables: [
          {
            candidateId: "c1",
            displayPath: "~/.local/bin/codex",
            version,
            location: "user-install",
          },
        ],
        doctor: "unknown",
      },
    });
    for (const version of ["0.159.2", "0.155.0-alpha.9.2", "1.0-rc1", null]) {
      expect(DetectionResponseSchema.safeParse(withVersion(version)).success, String(version)).toBe(
        true,
      );
    }
    for (const version of ["", "abc", "0.1.2-", "0.1.2-a b", "1.2.3.4.5", `1.${"2".repeat(70)}`]) {
      expect(DetectionResponseSchema.safeParse(withVersion(version)).success, version).toBe(false);
    }
  });
});
