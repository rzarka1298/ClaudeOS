import { describe, expect, it } from "vitest";
import type { ProjectId } from "./ids.js";
import {
  LAUNCH_ACTIONS,
  LAUNCH_ERROR_KINDS,
  LAUNCH_PATH,
  LAUNCHER_IDS,
  LauncherConfigRefusalBodySchema,
  LaunchRequestSchema,
  type LaunchResult,
  LaunchResultSchema,
  parseStoredLauncherConfig,
  SaveLauncherConfigRequestSchema,
  SystemSettingsPaneSchema,
  TEMPLATE_REFUSAL_REASONS,
  type TerminalLauncher,
  type TerminalLaunchInput,
  TestLauncherRequestSchema,
} from "./launch.js";

const PROJECT_ID = "0000000000123456789abcdef";
const LINE_FEED = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);

describe("launch vocabulary (D-26, D-06)", () => {
  it("LAUNCH_ERROR_KINDS is exactly the ten D-26 members in D-26 order", () => {
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
    ]);
    expect(LAUNCH_ERROR_KINDS.length).toBe(10);
  });

  it("LAUNCH_ACTIONS and LAUNCHER_IDS are exact", () => {
    expect(LAUNCH_ACTIONS).toEqual([
      "antigravity",
      "claude-code",
      "finder",
      "github",
      "claude-desktop",
    ]);
    expect(LAUNCHER_IDS).toEqual(["antigravity", "claude-code", "claude-desktop"]);
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

  it("a test request names a launcher id only", () => {
    expect(TestLauncherRequestSchema.safeParse({ launcherId: "claude-code" }).success).toBe(true);
    expect(TestLauncherRequestSchema.safeParse({ launcherId: "finder" }).success).toBe(false);
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
    const withoutEnv: TerminalLaunchInput = {
      cwd: "/Users/USERNAME/code/example-project",
      argv: ["/usr/bin/true"],
    };
    const withEnv: TerminalLaunchInput = {
      cwd: "/Users/USERNAME/code/example-project",
      argv: ["/usr/bin/true"],
      env: { CCC_RUN_ID: "run-1" },
    };
    await expect(launcher.launch(withoutEnv)).resolves.toEqual({ ok: true });
    await expect(launcher.launch(withEnv)).resolves.toEqual({ ok: true });
    expect(seen[1]?.env).toEqual({ CCC_RUN_ID: "run-1" });
  });

  it("a ProjectId-typed lookup key compiles against the port shapes", () => {
    const id = PROJECT_ID as ProjectId;
    expect(id).toBe(PROJECT_ID);
  });
});
