import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DetectionResponseSchema,
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_SAVE_PATH,
  LauncherConfigRefusalBodySchema,
  LauncherConfigViewSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
  TEMPLATE_REFUSAL_REASONS,
  type TemplateRefusalReason,
} from "@ccc/domain";
import { type TemplateRefusal, validateCommandTemplate } from "@ccc/launchers";
import { getLauncherConfig, listLauncherConfigs } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScriptedReply } from "../test-support/fake-command-runner.js";
import { type LauncherHarness, startLauncherHarness } from "../test-support/launcher-harness.js";

/**
 * The launcher setup routes over the real socket (PROJ-10, PROJ-11, D-22,
 * D-27, PR-13): detection proposes, the owner's explicit save is validated in
 * full and stored, and the snapshot's launchers summary follows. Every
 * process port is a fake (no mdfind, plutil or open ever runs).
 */

/** Scripted Spotlight + Info.plist answers for the installed apps of this fake Mac. */
function installed(apps: readonly { path: string; bundleId: string; name: string }[]) {
  const script: ScriptedReply[] = [];
  for (const app of apps) {
    script.push({
      match: (file, args) =>
        file === "/usr/bin/mdfind" &&
        (args[0] === `kMDItemCFBundleIdentifier == '${app.bundleId}'` ||
          (args[0]?.endsWith("*'") === true &&
            app.bundleId.startsWith(args[0].slice("kMDItemCFBundleIdentifier == '".length, -2)))),
      outcome: { exitCode: 0, stdout: `${app.path}\n` },
    });
    for (const [key, value] of [
      ["CFBundleIdentifier", app.bundleId],
      ["CFBundleName", app.name],
    ] as const) {
      script.push({
        match: (file, args) =>
          file === "/usr/bin/plutil" &&
          args[1] === key &&
          args[args.length - 1] === `${app.path}/Contents/Info.plist`,
        outcome: { exitCode: 0, stdout: `${value}\n` },
      });
    }
  }
  script.push({
    match: (file) => file === "/usr/bin/mdfind",
    outcome: { exitCode: 0, stdout: "" },
  });
  return script;
}

const ANTIGRAVITY = {
  path: "/Applications/Antigravity.app",
  bundleId: "com.google.antigravity",
  name: "Antigravity",
};
const ANTIGRAVITY_IDE = {
  path: "/Applications/Antigravity IDE.app",
  bundleId: "com.google.antigravity-ide",
  name: "Antigravity IDE",
};
const CLAUDE_DESKTOP = {
  path: "/Applications/Claude.app",
  bundleId: "com.anthropic.claudefordesktop",
  name: "Claude",
};

let harness: LauncherHarness;
/** `~/.local/bin/claude` in the harness home: a symlink to a versioned binary. */
let claudeSymlink: string;
let claudeRealpath: string;

function makeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

beforeEach(async () => {
  harness = await startLauncherHarness({
    script: installed([ANTIGRAVITY, ANTIGRAVITY_IDE, CLAUDE_DESKTOP]),
  });
  claudeRealpath = join(harness.homeDir, ".local", "share", "claude", "versions", "9.9.9");
  makeExecutable(claudeRealpath);
  claudeSymlink = join(harness.homeDir, ".local", "bin", "claude");
  mkdirSync(dirname(claudeSymlink), { recursive: true });
  symlinkSync(claudeRealpath, claudeSymlink);
});

afterEach(() => {
  harness.close();
});

async function detectedCandidateId(): Promise<string> {
  const reply = await harness.post(LAUNCHERS_DETECT_PATH, {});
  const detection = DetectionResponseSchema.parse(reply.body);
  const candidate = detection.claudeExecutables.find(
    (found) => found.displayPath === "~/.local/bin/claude",
  );
  if (candidate === undefined) throw new Error("the claude symlink was not detected");
  return candidate.candidateId;
}

async function snapshotLaunchers() {
  const reply = await harness.get(SNAPSHOT_PATH);
  expect(reply.status).toBe(200);
  return SnapshotResponseSchema.parse(reply.body).state.projects.launchers;
}

describe("detect, save the owner's choice, and see Antigravity set up (tracer)", () => {
  it("detects both Antigravity bundles, saves the chosen one, and the snapshot reports set-up", async () => {
    const detect = await harness.post(LAUNCHERS_DETECT_PATH, {});
    expect(detect.status).toBe(200);
    const detection = DetectionResponseSchema.parse(detect.body);
    expect(detection.apps.antigravity.map((found) => found.bundleId)).toEqual([
      "com.google.antigravity",
      "com.google.antigravity-ide",
    ]);
    // Detection proposes only: nothing is stored until a save (D-27).
    expect(listLauncherConfigs(harness.store.db)).toEqual([]);

    const save = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "antigravity",
      bundleId: "com.google.antigravity",
    });
    expect(save.status).toBe(200);
    expect(save.body).toEqual({ ok: true });
    expect(getLauncherConfig(harness.store.db, "antigravity")?.config).toEqual({
      bundleId: "com.google.antigravity",
    });

    expect((await snapshotLaunchers()).antigravity).toBe("set-up");
    const updates = harness.projectsUpdates().filter((update) => update.launchers !== undefined);
    expect(updates.at(-1)?.launchers?.antigravity).toBe("set-up");
  });

  it("serves the saved summary through GET /snapshot", async () => {
    await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-desktop",
      bundleId: "com.anthropic.claudefordesktop",
    });
    const launchers = await snapshotLaunchers();
    expect(launchers["claude-desktop"]).toBe("set-up");
    expect(launchers.antigravity).toBe("not-set-up");
  });

  it("refuses a bundle ID no installed app has, stores nothing and names no path", async () => {
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "antigravity",
      bundleId: "com.example.none",
    });
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      error: "launcher config refused",
      reason: "bundle-not-found",
      index: null,
    });
    expect(listLauncherConfigs(harness.store.db)).toEqual([]);
    expect(harness.projectsUpdates().filter((update) => update.launchers !== undefined)).toEqual(
      [],
    );
  });

  it("rejects an unauthenticated save with 401 and stores nothing", async () => {
    const reply = await harness.post(
      LAUNCHERS_SAVE_PATH,
      { launcherId: "antigravity", bundleId: "com.google.antigravity" },
      { token: null },
    );
    expect(reply.status).toBe(401);
    expect(listLauncherConfigs(harness.store.db)).toEqual([]);
  });

  it("rejects an unauthenticated detect with 401 and runs no detection", async () => {
    const reply = await harness.post(LAUNCHERS_DETECT_PATH, {}, { token: null });
    expect(reply.status).toBe(401);
    expect(harness.runner.calls).toHaveLength(0);
  });
});

describe("saving Claude Code (D-21, D-22, PR-13)", () => {
  it("stores the detected candidate's symlink path, not its realpath, with the args and terminal", async () => {
    const candidateId = await detectedCandidateId();
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId },
      args: ["--model", "opus", "{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    expect(reply.status).toBe(200);
    const stored = getLauncherConfig(harness.store.db, "claude-code")?.config;
    expect(stored).toEqual({
      executablePath: claudeSymlink,
      args: ["--model", "opus", "{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    expect(realpathSync.native(claudeSymlink)).toBe(realpathSync.native(claudeRealpath));
    expect((stored as { executablePath: string }).executablePath).not.toBe(
      realpathSync.native(claudeRealpath),
    );
    expect(harness.collector.snapshot().launchers["claude-code"]).toEqual({
      status: "set-up",
      terminalLabel: "Terminal",
    });
  });

  it("accepts an owner-typed absolute path to an executable file", async () => {
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "path", path: claudeRealpath },
      args: [],
      terminal: { kind: "terminal-app" },
    });
    expect(reply.status).toBe(200);
  });

  const refusals: readonly {
    name: string;
    body: (candidateId: string) => unknown;
    reason: TemplateRefusalReason;
    index: number | null;
  }[] = [
    {
      name: "a forbidden permission-bypass flag in the arguments",
      body: (candidateId) => ({
        launcherId: "claude-code",
        executable: { kind: "candidate", candidateId },
        args: ["--model", "opus", "--dangerously-skip-permissions"],
        terminal: { kind: "terminal-app" },
      }),
      reason: "forbidden-flag",
      index: 3,
    },
    {
      name: "a custom terminal template without {script}",
      body: (candidateId) => ({
        launcherId: "claude-code",
        executable: { kind: "candidate", candidateId },
        args: [],
        terminal: { kind: "custom", preset: "blank", argv: ["/usr/bin/open", "-a", "Terminal"] },
      }),
      reason: "missing-script-placeholder",
      index: null,
    },
    {
      name: "a terminal template whose executable is not absolute",
      body: (candidateId) => ({
        launcherId: "claude-code",
        executable: { kind: "candidate", candidateId },
        args: [],
        terminal: { kind: "custom", preset: "blank", argv: ["wezterm", "{script}"] },
      }),
      reason: "executable-not-absolute",
      index: 0,
    },
    {
      name: "an embedded placeholder",
      body: (candidateId) => ({
        launcherId: "claude-code",
        executable: { kind: "candidate", candidateId },
        args: ["--cwd={projectPath}"],
        terminal: { kind: "terminal-app" },
      }),
      reason: "embedded-placeholder",
      index: 1,
    },
    {
      name: "a candidate this service never detected",
      body: () => ({
        launcherId: "claude-code",
        executable: { kind: "candidate", candidateId: "never-detected" },
        args: [],
        terminal: { kind: "terminal-app" },
      }),
      reason: "executable-not-found",
      index: 0,
    },
    {
      name: "a typed path that is not an executable file",
      body: () => ({
        launcherId: "claude-code",
        executable: { kind: "path", path: "/nonexistent/claude" },
        args: [],
        terminal: { kind: "terminal-app" },
      }),
      reason: "executable-not-executable",
      index: 0,
    },
  ];

  for (const refusal of refusals) {
    it(`refuses ${refusal.name} with { reason, index }, stores nothing and names no path`, async () => {
      const candidateId = await detectedCandidateId();
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, refusal.body(candidateId));
      expect(reply.status).toBe(422);
      const body = LauncherConfigRefusalBodySchema.parse(reply.body);
      expect(body.reason).toBe(refusal.reason);
      expect(body.index).toBe(refusal.index);
      expect(JSON.stringify(reply.body)).not.toContain("/");
      expect(getLauncherConfig(harness.store.db, "claude-code")).toBeNull();
    });
  }

  it("says which template a refusal is about, so the plugin can mark the right editor", async () => {
    const candidateId = await detectedCandidateId();
    const terminal = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId },
      args: [],
      terminal: {
        kind: "custom",
        preset: "blank",
        argv: ["/usr/bin/open", "--dangerously-skip-permissions", "{script}"],
      },
    });
    expect(LauncherConfigRefusalBodySchema.parse(terminal.body)).toMatchObject({
      reason: "forbidden-flag",
      index: 1,
      template: "terminal",
    });
    const claude = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId },
      args: ["--dangerously-skip-permissions"],
      terminal: { kind: "terminal-app" },
    });
    expect(LauncherConfigRefusalBodySchema.parse(claude.body)).toMatchObject({
      reason: "forbidden-flag",
      index: 1,
      template: "claude-code",
    });
  });
});

describe("reading the saved configuration back (PR-13)", () => {
  it("answers the display-safe view with the executable home-abbreviated", async () => {
    const candidateId = await detectedCandidateId();
    await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId },
      args: ["{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "antigravity",
      bundleId: "com.google.antigravity-ide",
    });

    const reply = await harness.post(LAUNCHERS_GET_PATH, {});

    expect(reply.status).toBe(200);
    expect(LauncherConfigViewSchema.parse(reply.body)).toEqual({
      antigravity: { bundleId: "com.google.antigravity-ide", tested: false },
      "claude-code": {
        executableDisplay: "~/.local/bin/claude",
        args: ["{projectPath}"],
        terminal: { kind: "terminal-app" },
        tested: false,
      },
      "claude-desktop": null,
    });
    expect(JSON.stringify(reply.body)).not.toContain(harness.homeDir);
  });
});

describe("refusal vocabulary (D-22)", () => {
  it("every refusal the template validator can produce is a domain refusal reason", () => {
    const corpus: readonly (readonly string[])[] = [
      [],
      ["relative"],
      ["/x", ""],
      ["/x", "a\nb"],
      ["/x", "--dangerously-skip-permissions"],
      ["/x", "--cwd={script}"],
      ["/x", "{nope}"],
      ["/not-executable", "{script}"],
      ["/x", "a"],
      Array.from({ length: 40 }, () => "/x"),
    ];
    const seen = new Set<TemplateRefusal>();
    for (const argv of corpus) {
      const result = validateCommandTemplate(argv, {
        kind: "terminal",
        isExecutable: (path) => path === "/x",
      });
      if (!result.ok) seen.add(result.reason);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
    for (const reason of seen) {
      expect(TEMPLATE_REFUSAL_REASONS as readonly string[]).toContain(reason);
    }
    // Compile-time: a TemplateRefusal is assignable to the domain enum.
    const widened: TemplateRefusalReason = [...seen][0] ?? "line-break";
    expect(widened).toBeDefined();
  });
});
