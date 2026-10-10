import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DetectionResponseSchema,
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_MARK_TESTED_PATH,
  LAUNCHERS_SAVE_PATH,
  LAUNCHERS_TEST_PATH,
  LauncherConfigRefusalBodySchema,
  LauncherConfigViewSchema,
  LaunchResultSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
  TEMPLATE_REFUSAL_REASONS,
  type TemplateRefusalReason,
} from "@ccc/domain";
import { type TemplateRefusal, validateCommandTemplate } from "@ccc/launchers";
import { getLauncherConfig, listLauncherConfigs, saveLauncherConfig } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CodexDetection, createCodexDetection } from "../codex/detection.js";
import { logger } from "../logging.js";
import { INVALID_BODY_BODY } from "../route-kit.js";
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
  // The Antigravity wildcard query (D-27) answers every matching bundle at once.
  const wildcard = "com.google.antigravity";
  script.push({
    match: (file, args) =>
      file === "/usr/bin/mdfind" && args[0] === `kMDItemCFBundleIdentifier == '${wildcard}*'`,
    outcome: {
      exitCode: 0,
      stdout: apps
        .filter((app) => app.bundleId.startsWith(wildcard))
        .map((app) => `${app.path}\n`)
        .join(""),
    },
  });
  for (const app of apps) {
    script.push({
      match: (file, args) =>
        file === "/usr/bin/mdfind" && args[0] === `kMDItemCFBundleIdentifier == '${app.bundleId}'`,
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

describe("Test launcher and mark tested (D-28, RR-14)", () => {
  async function saveAntigravity(bundleId = "com.google.antigravity"): Promise<void> {
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, { launcherId: "antigravity", bundleId });
    expect(reply.status).toBe(200);
  }

  it("fires one real launch of the saved configuration and never marks it tested by itself", async () => {
    await saveAntigravity();
    const reply = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });
    expect(reply.status).toBe(200);
    expect(LaunchResultSchema.parse(reply.body)).toEqual({ ok: true });
    expect(harness.spawner.calls.map((call) => call.argv)).toEqual([
      ["/usr/bin/open", "-b", "com.google.antigravity"],
    ]);
    expect(getLauncherConfig(harness.store.db, "antigravity")?.tested).toBe(false);
    expect((await snapshotLaunchers()).antigravity).toBe("set-up");
  });

  it("marks it tested only when the owner answers It opened after a passing Test", async () => {
    await saveAntigravity();
    await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });

    const reply = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "antigravity" });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(getLauncherConfig(harness.store.db, "antigravity")?.tested).toBe(true);
    expect((await snapshotLaunchers()).antigravity).toBe("tested");
    const updates = harness.projectsUpdates().filter((update) => update.launchers !== undefined);
    expect(updates.at(-1)?.launchers?.antigravity).toBe("tested");
  });

  it("refuses to mark a launcher with no passing Test since its last save", async () => {
    await saveAntigravity();
    const untested = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "antigravity" });
    expect(untested.status).toBe(409);
    expect(untested.body).toEqual({ error: "launcher has no passing test" });

    harness.spawner.mode = {
      kind: "fail",
      outcome: { exitCode: 1, stderrClass: "bundle-not-found" },
    };
    const failed = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });
    expect(failed.body).toEqual({ ok: false, error: "app-not-found" });
    const afterFailure = await harness.post(LAUNCHERS_MARK_TESTED_PATH, {
      launcherId: "antigravity",
    });
    expect(afterFailure.status).toBe(409);
    expect(getLauncherConfig(harness.store.db, "antigravity")?.tested).toBe(false);
  });

  it("refuses to mark a launcher that is not saved", async () => {
    const reply = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "claude-desktop" });
    expect(reply.status).toBe(409);
    expect(getLauncherConfig(harness.store.db, "claude-desktop")).toBeNull();
  });

  it("a later save resets Tested, the snapshot shows set-up again, and the old Test no longer counts", async () => {
    await saveAntigravity();
    await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });
    await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "antigravity" });
    expect((await snapshotLaunchers()).antigravity).toBe("tested");

    await saveAntigravity("com.google.antigravity-ide");

    expect(getLauncherConfig(harness.store.db, "antigravity")?.tested).toBe(false);
    expect((await snapshotLaunchers()).antigravity).toBe("set-up");
    const again = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "antigravity" });
    expect(again.status).toBe(409);
  });

  it("tests Finder and GitHub, which need no setup (RR-15)", async () => {
    const finder = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "finder" });
    const github = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "github" });
    expect(finder.body).toEqual({ ok: true });
    expect(github.body).toEqual({ ok: true });
    expect(harness.spawner.calls.map((call) => call.argv)).toEqual([
      ["/usr/bin/open", "-R", harness.homeDir],
      ["/usr/bin/open", "https://github.com"],
    ]);
  });

  it("answers launcher-not-configured for an unsaved launcher and spawns nothing", async () => {
    const reply = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "claude-code" });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: false, error: "launcher-not-configured" });
    expect(harness.spawner.calls).toHaveLength(0);
  });

  it("refuses a Test body carrying anything but the launcher id, and spawns nothing", async () => {
    const reply = await harness.post(LAUNCHERS_TEST_PATH, {
      launcherId: "finder",
      path: "/Applications",
    });
    expect(reply.status).toBe(400);
    expect(harness.spawner.calls).toHaveLength(0);
  });

  it("rejects unauthenticated Test and mark-tested requests with 401", async () => {
    await saveAntigravity();
    const test = await harness.post(
      LAUNCHERS_TEST_PATH,
      { launcherId: "antigravity" },
      { token: null },
    );
    const mark = await harness.post(
      LAUNCHERS_MARK_TESTED_PATH,
      { launcherId: "antigravity" },
      { token: null },
    );
    expect(test.status).toBe(401);
    expect(mark.status).toBe(401);
    expect(harness.spawner.calls).toHaveLength(0);
    expect(getLauncherConfig(harness.store.db, "antigravity")?.tested).toBe(false);
  });
});

describe("a candidate chosen before a service restart still saves (codex review 3, finding 3)", () => {
  it("a fresh service (no detection run yet) resolves a known candidate ID to its fixed location", async () => {
    // The plugin kept `local-bin` from a detection the previous service run
    // answered; this service has detected nothing since it started.
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId: "local-bin" },
      args: ["{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    expect(reply.status).toBe(200);
    expect(getLauncherConfig(harness.store.db, "claude-code")?.config).toEqual({
      executablePath: claudeSymlink,
      args: ["{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
  });

  it("a known candidate whose file is gone is still refused, as a detected one that vanished is", async () => {
    rmSync(claudeSymlink);
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId: "local-bin" },
      args: [],
      terminal: { kind: "terminal-app" },
    });
    expect(reply.status).toBe(422);
    expect(LauncherConfigRefusalBodySchema.parse(reply.body)).toMatchObject({
      reason: "executable-not-executable",
      index: 0,
    });
    expect(getLauncherConfig(harness.store.db, "claude-code")).toBeNull();
  });
});

describe("a save's validation is bounded inside the client's budget (codex review 3, finding 4)", () => {
  it("an app save whose install check outlasts the cap answers a failure and never stores late", async () => {
    harness.close();
    let finish: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    harness = await startLauncherHarness({
      script: installed([ANTIGRAVITY]),
      saveValidationCapMs: 50,
      // Spotlight stalls: the check answers "installed" long after the cap.
      wrapDetector: (detector) => ({
        ...detector,
        findBundle: (bundleId) =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(detector.findBundle(bundleId));
              setTimeout(() => finish?.(), 20);
            }, 1000);
          }),
      }),
    });

    const started = Date.now();
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "antigravity",
      bundleId: ANTIGRAVITY.bundleId,
    });
    expect(Date.now() - started).toBeLessThan(800);
    expect(reply.status).not.toBe(200);
    expect(reply.body).toEqual({ error: "launcher check timed out" });

    await settled;
    expect(getLauncherConfig(harness.store.db, "antigravity")).toBeNull();
  });
});

describe("the Codex launcher: save, view, test and mark tested (plan 05.1-21, D-11, CODEX-03)", () => {
  /** `~/.local/bin/codex` in the harness home: a symlink to a versioned fake binary. */
  let codexSymlink: string;
  let codexDetection: CodexDetection;

  beforeEach(async () => {
    harness.close();
    harness = await startLauncherHarness({
      script: installed([ANTIGRAVITY]),
      wrapDetector: (detector) => ({
        ...detector,
        codexCandidatePath: (candidateId) => codexDetection.candidatePath(candidateId),
      }),
    });
    codexDetection = createCodexDetection({
      runner: harness.runner,
      homeDir: harness.homeDir,
      readBridgeStatus: () => {
        throw new Error("not used by the save routes");
      },
    });
    const real = join(harness.homeDir, ".codex-fake", "releases", "9.9.9", "codex");
    makeExecutable(real);
    codexSymlink = join(harness.homeDir, ".local", "bin", "codex");
    mkdirSync(dirname(codexSymlink), { recursive: true });
    symlinkSync(real, codexSymlink);
  });

  const BAN_CASES: readonly (readonly [string, readonly string[], number])[] = [
    ["the approval and sandbox bypass flag", ["--dangerously-bypass-approvals-and-sandbox"], 1],
    ["the hook-trust bypass", ["--dangerously-bypass-hook-trust"], 1],
    ["yolo", ["--yolo"], 1],
    ["full-auto", ["--full-auto"], 1],
    ["approve-for-me", ["--approve-for-me"], 1],
    [
      "a sandbox flag with the danger value as two elements",
      ["--sandbox", "danger-full-access"],
      2,
    ],
    ["the equals form", ["--sandbox=danger-full-access"], 1],
    ["an attached short form", ["-sdanger-full-access"], 1],
    ["a config override carrying the danger value", ["-c", 'sandbox_mode="danger-full-access"'], 1],
    ["the long config flag", ["--config", "model=o3"], 1],
    ["the profile flag", ["--profile", "work"], 1],
    ["the short profile flag", ["-p", "work"], 1],
    ["upper case with underscores", ["--YOLO"], 1],
    ["a full-width spelling", ["--ｙｏｌｏ"], 1],
    ["the Phase 4 Claude skip flag", ["--dangerously-skip-permissions"], 1],
    ["the Phase 4 Claude permission mode", ["--permission-mode", "bypassPermissions"], 1],
    ["a flag after an ordinary argument", ["--model", "o3", "--yolo"], 3],
    ["a flag the agent allowlist does not carry", ["--bg"], 1],
    ["an unknown subcommand operand", ["exec"], 1],
    ["an approval value the allowlist does not carry", ["-a", "never"], 1],
  ];

  async function savedCodex() {
    return getLauncherConfig(harness.store.db, "codex");
  }

  function saveBody(args: readonly string[] = [], executable: unknown = null): unknown {
    return {
      launcherId: "codex",
      executable: executable ?? { kind: "candidate", candidateId: "user-install" },
      args,
    };
  }

  it("saves a detected candidate with empty arguments, stores no terminal, and the view shows it display-safe", async () => {
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, saveBody());
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    const stored = await savedCodex();
    // The symlink path, never its realpath (D-21), and no terminal key (D-11).
    expect(stored?.config).toEqual({ executablePath: codexSymlink, args: [] });
    expect(Object.keys(stored?.config as object).sort()).toEqual(["args", "executablePath"]);

    const view = await harness.post(LAUNCHERS_GET_PATH, {});
    const parsed = LauncherConfigViewSchema.parse(view.body);
    expect(parsed.codex).toEqual({
      executableDisplay: "~/.local/bin/codex",
      args: [],
      tested: false,
    });
    expect(JSON.stringify(view.body)).not.toContain(harness.homeDir);
  });

  it("saves a typed absolute path and an ordinary model argument", async () => {
    const reply = await harness.post(
      LAUNCHERS_SAVE_PATH,
      saveBody(["--model", "o3"], { kind: "path", path: codexSymlink }),
    );
    expect(reply.status).toBe(200);
    expect((await savedCodex())?.config).toEqual({
      executablePath: codexSymlink,
      args: ["--model", "o3"],
    });
  });

  it("keeps a whole-token project placeholder as a value of the working-directory flag", async () => {
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, saveBody(["-C", "{projectPath}"]));
    expect(reply.status).toBe(200);
  });

  it.each(BAN_CASES)(
    "refuses %s with the structured body naming the index and the template, and stores nothing",
    async (_name, args, index) => {
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, saveBody(args));
      expect(reply.status).toBe(422);
      expect(reply.body).toEqual({
        error: "launcher config refused",
        reason: "forbidden-flag",
        index,
        template: "codex",
      });
      expect(LauncherConfigRefusalBodySchema.parse(reply.body).template).toBe("codex");
      // The refusal never echoes the argument.
      for (const argument of args) {
        expect(JSON.stringify(reply.body)).not.toContain(argument.replace(/^-+/, ""));
      }
      expect(await savedCodex()).toBeNull();
    },
  );

  it("refuses a stored-shape bypass that an already saved row would carry only by this route", async () => {
    // The route is the only writer: a refused save leaves a previously saved row as it was.
    await harness.post(LAUNCHERS_SAVE_PATH, saveBody(["--model", "o3"]));
    const before = await savedCodex();
    const reply = await harness.post(LAUNCHERS_SAVE_PATH, saveBody(["--yolo"]));
    expect(reply.status).toBe(422);
    expect(await savedCodex()).toEqual(before);
  });

  describe("the executable", () => {
    function typed(path: string): unknown {
      return saveBody([], { kind: "path", path });
    }

    it("refuses a file that is present but not executable", async () => {
      const path = join(harness.homeDir, "plain", "codex");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "x");
      chmodSync(path, 0o644);
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, typed(path));
      expect(reply.status).toBe(422);
      expect(reply.body).toEqual({
        error: "launcher config refused",
        reason: "executable-not-executable",
        index: 0,
        template: "codex",
      });
      expect(await savedCodex()).toBeNull();
    });

    it("refuses a path that does not exist", async () => {
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, typed("/nonexistent/dir/codex"));
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ reason: "executable-not-executable", index: 0 });
      expect(await savedCodex()).toBeNull();
    });

    it.each([
      "claude",
      "sh",
      "bash",
      "env",
      "node",
      "python3",
      "osascript",
      "Codex",
      "codex.sh",
      "codex-wrapper",
    ])("refuses an executable whose basename is %s, not exactly codex", async (name) => {
      const path = join(harness.homeDir, "shim", name);
      makeExecutable(path);
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, typed(path));
      expect(reply.status).toBe(422);
      expect(reply.body).toEqual({
        error: "launcher config refused",
        reason: "executable-not-found",
        index: 0,
        template: "codex",
      });
      expect(await savedCodex()).toBeNull();
    });

    it("refuses a real interpreter path even when it is executable", async () => {
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, typed("/bin/sh"));
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ reason: "executable-not-found", index: 0 });
    });

    it("refuses a candidate id this service does not know", async () => {
      const reply = await harness.post(
        LAUNCHERS_SAVE_PATH,
        saveBody([], { kind: "candidate", candidateId: "never-detected" }),
      );
      expect(reply.status).toBe(422);
      expect(reply.body).toEqual({
        error: "launcher config refused",
        reason: "executable-not-found",
        index: 0,
        template: "codex",
      });
    });

    it("refuses a relative typed path through the strict schema", async () => {
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, typed("codex"));
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual(INVALID_BODY_BODY);
    });
  });

  describe("the strict request shape", () => {
    it.each([
      ["a terminal key", { ...(saveBody() as object), terminal: { kind: "terminal-app" } }],
      ["an extra key", { ...(saveBody() as object), env: { A: "b" } }],
      ["a Claude-only field", { ...(saveBody() as object), permissionMode: "plan" }],
      [
        "no arguments member",
        { launcherId: "codex", executable: { kind: "candidate", candidateId: "user-install" } },
      ],
      ["a bundle id", { launcherId: "codex", bundleId: "com.example.codex" }],
    ])("answers the constant 400 for %s and stores nothing", async (_name, body) => {
      const reply = await harness.post(LAUNCHERS_SAVE_PATH, body);
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual(INVALID_BODY_BODY);
      expect(await savedCodex()).toBeNull();
    });
  });

  it("logs the route, the launcher id and the reason only", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    try {
      await harness.post(LAUNCHERS_SAVE_PATH, saveBody(["--yolo"]));
      await harness.post(LAUNCHERS_SAVE_PATH, saveBody());
      const calls = [...warn.mock.calls, ...info.mock.calls];
      expect(calls.length).toBeGreaterThan(0);
      for (const [fields] of calls) {
        expect(
          Object.keys(fields as object).every((key) =>
            ["route", "launcherId", "reason"].includes(key),
          ),
        ).toBe(true);
      }
      expect(JSON.stringify(calls)).not.toContain("yolo");
      expect(JSON.stringify(calls)).not.toContain(harness.homeDir);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  describe("the Test step and mark-tested", () => {
    async function saveBoth(): Promise<void> {
      const claude = await detectedClaudeSave();
      expect(claude.status).toBe(200);
      expect((await harness.post(LAUNCHERS_SAVE_PATH, saveBody())).status).toBe(200);
    }

    async function detectedClaudeSave() {
      return harness.post(LAUNCHERS_SAVE_PATH, {
        launcherId: "claude-code",
        executable: { kind: "path", path: join(harness.homeDir, "bin-claude") },
        args: [],
        terminal: { kind: "terminal-app" },
      });
    }

    beforeEach(() => {
      makeExecutable(join(harness.homeDir, "bin-claude"));
    });

    it("runs the saved codex with the version flag in the claude-code row's terminal", async () => {
      await saveBoth();
      const reply = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
      expect(reply.status).toBe(200);
      expect(LaunchResultSchema.parse(reply.body)).toEqual({ ok: true });
      expect(harness.spawner.calls).toHaveLength(1);
      const argv = harness.spawner.calls[0]?.argv ?? [];
      expect(argv.slice(0, 3)).toEqual(["/usr/bin/open", "-b", "com.apple.Terminal"]);
      const script = readFileSync(argv[3] ?? "", "utf8");
      expect(script.split("\n")).toContain(`'${codexSymlink}' '--version'`);
      expect(script).toContain(`cd -- '${harness.homeDir}' ||`);
    });

    it("answers launcher-not-configured and spawns nothing without a claude-code row", async () => {
      expect((await harness.post(LAUNCHERS_SAVE_PATH, saveBody())).status).toBe(200);
      const reply = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ ok: false, error: "launcher-not-configured" });
      expect(harness.spawner.calls).toHaveLength(0);
    });

    it("answers launcher-not-configured and spawns nothing without a codex row", async () => {
      expect((await detectedClaudeSave()).status).toBe(200);
      const reply = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
      expect(reply.body).toEqual({ ok: false, error: "launcher-not-configured" });
      expect(harness.spawner.calls).toHaveLength(0);
    });

    it("re-validates the saved row: a row that carries a banned argument is not tested", async () => {
      expect((await detectedClaudeSave()).status).toBe(200);
      // A row written around the route (an older build, a hand edit) is still refused at Test.
      saveLauncherConfig(harness.store.db, "codex", {
        executablePath: codexSymlink,
        args: ["--dangerously-bypass-approvals-and-sandbox"],
      });
      const reply = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
      expect(reply.body).toEqual({ ok: false, error: "launcher-not-configured" });
      expect(harness.spawner.calls).toHaveLength(0);
    });

    it("marks the codex launcher tested after a passing Test, and the view reflects it", async () => {
      await saveBoth();
      expect((await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" })).body).toEqual({
        ok: true,
      });
      const mark = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" });
      expect(mark.status).toBe(200);
      const view = LauncherConfigViewSchema.parse(
        (await harness.post(LAUNCHERS_GET_PATH, {})).body,
      );
      expect(view.codex?.tested).toBe(true);
    });

    it("refuses to mark codex tested without a passing Test, and a new save clears the flag", async () => {
      await saveBoth();
      const early = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" });
      expect(early.status).toBe(409);
      await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
      expect((await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" })).status).toBe(
        200,
      );
      // Saving a different row resets Tested and the passing Test no longer counts.
      expect((await harness.post(LAUNCHERS_SAVE_PATH, saveBody(["--model", "o3"]))).status).toBe(
        200,
      );
      const view = LauncherConfigViewSchema.parse(
        (await harness.post(LAUNCHERS_GET_PATH, {})).body,
      );
      expect(view.codex?.tested).toBe(false);
      expect((await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" })).status).toBe(
        409,
      );
    });

    it("refuses a second Test of a row saved since the running Test read it", async () => {
      await saveBoth();
      harness.spawner.mode = { kind: "succeed", delayMs: 200 };
      const first = harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      await harness.post(LAUNCHERS_SAVE_PATH, saveBody(["--model", "o3"]));
      const second = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
      expect(second.status).toBe(409);
      expect((await first).status).toBe(200);
    });
  });
});
