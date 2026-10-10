import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetectedCodexExecutableSchema, TerminalChoiceSchema } from "@ccc/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFakeCommandRunner,
  type ScriptedReply,
} from "../test-support/fake-command-runner.js";
import type { BridgeStatus } from "./bridge-state.js";
import { CODEX_CANDIDATE_PATHS, createCodexDetection } from "./detection.js";

/**
 * Codex detection (plan 05.1-21, D-11, D-12, CODEX-03). Every child goes
 * through the fake command runner: no real `codex` ever runs, and the only
 * files are fake ones in temporary directories.
 */

const HOME = "/Users/USERNAME";
const USER_INSTALL = `${HOME}/.local/bin/codex`;
const APP_BUNDLE = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

function versionReply(path: string, stdout: string, extra: object = {}): ScriptedReply {
  return {
    match: (file, args) => file === path && args.length === 1 && args[0] === "--version",
    outcome: { exitCode: 0, stdout, ...extra },
  };
}

function bridgeStatus(
  state: BridgeStatus["state"],
  dirSource: BridgeStatus["dirSource"] = "primary",
): BridgeStatus {
  return {
    state,
    protocol: state === "not-installed" ? null : 2,
    capabilities: state === "not-installed" ? null : ["agent"],
    launcherPresent: state !== "not-installed",
    dir: `${HOME}/.local/state/codex-bridge`,
    dirSource,
    launchable: true,
    windows: [],
  };
}

function detection(
  options: {
    script?: readonly ScriptedReply[];
    executables?: readonly string[];
    bridge?: BridgeStatus;
    homeDir?: string;
  } = {},
) {
  const runner = createFakeCommandRunner({ script: options.script ?? [] });
  const executables = new Set(options.executables ?? []);
  const subject = createCodexDetection({
    runner,
    homeDir: options.homeDir ?? HOME,
    isExecutable: (path) => Promise.resolve(executables.has(path)),
    readBridgeStatus: () => options.bridge ?? bridgeStatus("not-installed"),
  });
  return { subject, runner };
}

describe("Codex detection proposes two candidates (tracer, D-11, CODEX-03)", () => {
  it("Test 1: the user install and the app-bundled binary are listed with versions in order, no home path in the response", async () => {
    const { subject, runner } = detection({
      script: [
        versionReply(USER_INSTALL, "codex-cli 0.159.2\n"),
        versionReply(APP_BUNDLE, "codex-cli 0.155.0-alpha.9.2\n"),
      ],
      executables: [USER_INSTALL, APP_BUNDLE],
    });
    const result = await subject.detectCodex();
    expect(result.executables).toEqual([
      {
        candidateId: "user-install",
        displayPath: "~/.local/bin/codex",
        version: "0.159.2",
        location: "user-install",
      },
      {
        candidateId: "app-bundle",
        displayPath: APP_BUNDLE,
        version: "0.155.0-alpha.9.2",
        location: "app-bundle",
      },
    ]);
    for (const executable of result.executables) {
      expect(DetectedCodexExecutableSchema.safeParse(executable).success).toBe(true);
      // None is pre-selected: the entry has exactly these four members.
      expect(Object.keys(executable).sort()).toEqual([
        "candidateId",
        "displayPath",
        "location",
        "version",
      ]);
    }
    expect(JSON.stringify(result)).not.toContain(HOME);
    expect(result.doctor).toBe("unknown");
    // Each child got exactly `--version`, a minimal environment and tight caps.
    expect(runner.calls).toHaveLength(2);
    for (const call of runner.calls) {
      expect(call.args).toEqual(["--version"]);
      expect(Object.keys(call.options.env).sort()).toEqual(["HOME", "LC_ALL", "PATH"]);
      expect(call.options.timeoutMs).toBeLessThanOrEqual(5000);
      expect(call.options.maxBufferBytes).toBeLessThanOrEqual(4096);
    }
  });

  it("the known locations are the user install, the app bundle, then the package-manager ones", () => {
    expect(CODEX_CANDIDATE_PATHS(HOME).map((c) => [c.candidateId, c.location])).toEqual([
      ["user-install", "user-install"],
      ["app-bundle", "app-bundle"],
      ["homebrew", "package-manager"],
      ["usr-local", "package-manager"],
    ]);
  });
});

describe("candidates and versions are bounded (CODEX-03)", () => {
  it("Test 2: a missing or non-executable file is omitted", async () => {
    const { subject, runner } = detection({
      script: [versionReply(APP_BUNDLE, "codex-cli 0.160.0\n")],
      executables: [APP_BUNDLE],
    });
    const result = await subject.detectCodex();
    expect(result.executables.map((e) => e.candidateId)).toEqual(["app-bundle"]);
    // Nothing is spawned for a file that is not executable.
    expect(runner.calls.map((call) => call.file)).toEqual([APP_BUNDLE]);
  });

  it.each([
    ["a non-zero exit", { exitCode: 1, stdout: "codex-cli 0.1.0\n" }],
    ["a timeout", { exitCode: null, timedOut: true, stdout: "" }],
    ["a truncated output", { exitCode: null, truncated: true, stdout: "codex-cli 0.1.0" }],
    ["text that is not the version form", { exitCode: 0, stdout: "hello world\n" }],
    ["a version with trailing text", { exitCode: 0, stdout: "codex-cli 1.2.3 && rm -rf /\n" }],
    ["a version in the middle of a line", { exitCode: 0, stdout: "banner codex-cli 1.2.3\n" }],
    ["a non-dotted version", { exitCode: 0, stdout: "codex-cli latest\n" }],
    ["two lines", { exitCode: 0, stdout: "codex-cli 1.2.3\nextra\n" }],
    ["a control character", { exitCode: 0, stdout: "codex-cli 1.2.3\u001b[0m\n" }],
  ])("Test 2: %s yields version null and the candidate is still listed", async (_name, outcome) => {
    const { subject } = detection({
      script: [{ match: (file) => file === USER_INSTALL, outcome }],
      executables: [USER_INSTALL],
    });
    const result = await subject.detectCodex();
    expect(result.executables).toEqual([
      {
        candidateId: "user-install",
        displayPath: "~/.local/bin/codex",
        version: null,
        location: "user-install",
      },
    ]);
  });

  it("Test 2: a spawn failure yields version null", async () => {
    const { subject } = detection({ script: [], executables: [USER_INSTALL] });
    const result = await subject.detectCodex();
    expect(result.executables[0]?.version).toBeNull();
  });

  it("Test 3: with no Codex anywhere the list is empty and detect still resolves", async () => {
    const { subject, runner } = detection();
    const result = await subject.detectCodex();
    expect(result.executables).toEqual([]);
    expect(result.doctor).toBe("unknown");
    expect(runner.calls).toEqual([]);
  });
});

describe("candidate ids resolve inside the service only (T-05.1-01)", () => {
  it("Test 4: a known id resolves to its absolute path, before any detection and after one", async () => {
    const { subject } = detection({
      script: [versionReply(USER_INSTALL, "codex-cli 0.159.2\n")],
      executables: [USER_INSTALL],
    });
    // A fresh service run that has not detected yet re-derives the fixed known location.
    expect(subject.candidatePath("user-install")).toBe(USER_INSTALL);
    expect(subject.candidatePath("app-bundle")).toBe(APP_BUNDLE);
    await subject.detectCodex();
    expect(subject.candidatePath("user-install")).toBe(USER_INSTALL);
  });

  it("Test 4: an unknown id, a path and a traversal resolve to null", () => {
    const { subject } = detection();
    for (const id of ["", "nope", "/usr/bin/codex", "../user-install", "user-install/", "claude"]) {
      expect(subject.candidatePath(id)).toBeNull();
    }
  });
});

describe("the bridge word and the suggested terminal are a proposal (D-12, OQ-2)", () => {
  it.each([
    ["installed", "installed", "antigravity-terminal"],
    ["installed-idle", "installed-idle", "antigravity-terminal"],
    ["outdated", "outdated", "terminal-app"],
    ["not-installed", "not-installed", "terminal-app"],
  ] as const)("Test 5: a %s bridge reports %s and proposes %s", async (state, word, terminal) => {
    const { subject } = detection({ bridge: bridgeStatus(state) });
    const result = await subject.detectCodex();
    expect(result.bridge).toBe(word);
    expect(result.suggestedTerminal).toEqual({ kind: terminal });
    expect(TerminalChoiceSchema.safeParse(result.suggestedTerminal).success).toBe(true);
  });

  it("Test 5: a bridge found only in the default folder is different-folder and Terminal.app is proposed", async () => {
    const { subject } = detection({ bridge: bridgeStatus("installed", "default-fallback") });
    const result = await subject.detectCodex();
    expect(result.bridge).toBe("different-folder");
    expect(result.suggestedTerminal).toEqual({ kind: "terminal-app" });
  });
});

describe("detection writes nothing and never runs doctor (Test 6, D-17)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function snapshot(root: string): string[] {
    const lines: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const info = statSync(path);
        lines.push(`${path}\u0000${info.size}\u0000${info.mtimeMs}`);
        if (info.isDirectory()) walk(path);
      }
    };
    walk(root);
    return lines;
  }

  it("leaves the file system as it was and only ever runs the version flag", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-cdx-det-"));
    dirs.push(home);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const userInstall = join(home, ".local", "bin", "codex");
    const before = snapshot(home);
    const { subject, runner } = detection({
      homeDir: home,
      script: [versionReply(userInstall, "codex-cli 0.159.2\n")],
      executables: [userInstall],
    });
    await subject.detectCodex();
    await subject.detectCodex();
    expect(snapshot(home)).toEqual(before);
    for (const call of runner.calls) expect(call.args).toEqual(["--version"]);
    expect(runner.calls.flatMap((call) => call.args)).not.toContain("doctor");
  });
});
