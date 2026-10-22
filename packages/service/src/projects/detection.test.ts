import { DetectionResponseSchema } from "@ccc/domain";
import { TERMINAL_PRESETS } from "@ccc/launchers";
import { describe, expect, it, vi } from "vitest";
import type { BridgeStatus } from "../codex/bridge-state.js";
import { createCodexDetection } from "../codex/detection.js";
import {
  createFakeCommandRunner,
  type ScriptedReply,
} from "../test-support/fake-command-runner.js";
import {
  CANDIDATE_BUNDLE_IDS,
  CLAUDE_CANDIDATE_PATHS,
  createDetector,
  DETECTION_QUERY_PATTERN,
} from "./detection.js";
import { resolveGit } from "./git-runner.js";

/**
 * Detection (D-27, D-21, PROJ-11): every test drives the detector through the
 * fake command runner, so no test runs the real `mdfind` or `plutil`
 * (RESEARCH Pattern 8: Spotlight may be off on CI).
 */

const HOME = "/Users/USERNAME";

const MDFIND = "/usr/bin/mdfind";
const PLUTIL = "/usr/bin/plutil";

function mdfind(query: string, paths: readonly string[]): ScriptedReply {
  return {
    match: (file, args) => file === MDFIND && args[0] === `kMDItemCFBundleIdentifier == '${query}'`,
    outcome: { exitCode: 0, stdout: paths.map((path) => `${path}\n`).join("") },
  };
}

function mdfindFails(): ScriptedReply {
  return { match: (file) => file === MDFIND, outcome: { exitCode: 1, stdout: "" } };
}

function plist(app: string, key: string, value: string): ScriptedReply {
  return {
    match: (file, args) =>
      file === PLUTIL && args[1] === key && args[args.length - 1] === `${app}/Contents/Info.plist`,
    outcome: { exitCode: 0, stdout: `${value}\n` },
  };
}

function app(path: string, bundleId: string, name: string): ScriptedReply[] {
  return [plist(path, "CFBundleIdentifier", bundleId), plist(path, "CFBundleName", name)];
}

/** Every other mdfind query finds nothing; every unscripted call fails (ENOENT). */
const NOTHING_ELSE: ScriptedReply = {
  match: (file) => file === MDFIND,
  outcome: { exitCode: 0, stdout: "" },
};

function detectorWith(
  script: readonly ScriptedReply[],
  options: {
    readdir?: (dir: string) => Promise<readonly string[]>;
    executables?: readonly string[];
    gitAvailable?: boolean;
  } = {},
) {
  const runner = createFakeCommandRunner({ script });
  const executables = new Set(options.executables ?? []);
  const detector = createDetector({
    runner,
    homeDir: HOME,
    readdir: options.readdir ?? (() => Promise.resolve([])),
    isExecutable: (path) => Promise.resolve(executables.has(path)),
    resolveGit: () => {
      const gitRunner = createFakeCommandRunner({
        script: [
          {
            match: (file) => file === "/usr/bin/xcode-select",
            outcome: { exitCode: options.gitAvailable === false ? 2 : 0 },
          },
        ],
      });
      return resolveGit(gitRunner, () => false);
    },
    now: () => new Date("2026-09-30T12:00:00.000Z"),
  });
  return { detector, runner };
}

describe("app detection (D-27)", () => {
  it("returns both Antigravity bundles from the wildcard query and preselects nothing", async () => {
    const { detector, runner } = detectorWith([
      mdfind("com.google.antigravity*", [
        "/Applications/Antigravity.app",
        "/Applications/Antigravity IDE.app",
      ]),
      ...app("/Applications/Antigravity.app", "com.google.antigravity", "Antigravity"),
      ...app("/Applications/Antigravity IDE.app", "com.google.antigravity-ide", "Antigravity IDE"),
      NOTHING_ELSE,
    ]);

    const response = await detector.detect();

    expect(DetectionResponseSchema.parse(response)).toEqual(response);
    expect(response.apps.antigravity).toEqual([
      { bundleId: "com.google.antigravity", name: "Antigravity", location: "applications" },
      { bundleId: "com.google.antigravity-ide", name: "Antigravity IDE", location: "applications" },
    ]);
    // Detection proposes only: nothing in the response marks a choice.
    expect(JSON.stringify(response.apps)).not.toMatch(/selected|chosen|default/i);
    // The query is an argv element, never a shell string.
    const antigravityQuery = runner.calls.find(
      (call) => call.file === MDFIND && call.args[0]?.includes("antigravity"),
    );
    expect(antigravityQuery?.args).toEqual([
      "kMDItemCFBundleIdentifier == 'com.google.antigravity*'",
    ]);
  });

  it("queries every candidate bundle ID with mdfind", async () => {
    const { detector, runner } = detectorWith([NOTHING_ELSE]);
    await detector.detect();
    const queried = runner.calls.filter((call) => call.file === MDFIND).map((call) => call.args[0]);
    for (const candidate of Object.values(CANDIDATE_BUNDLE_IDS)) {
      expect(queried).toContain(`kMDItemCFBundleIdentifier == '${candidate}'`);
    }
  });

  it("falls back to Info.plist reads over the Applications folders when mdfind fails", async () => {
    const listings: Record<string, readonly string[]> = {
      "/System/Applications/Utilities": ["Terminal.app", "Notes.txt"],
      [`${HOME}/Applications`]: ["Claude.app"],
    };
    const listed: string[] = [];
    const { detector } = detectorWith(
      [
        mdfindFails(),
        ...app("/System/Applications/Utilities/Terminal.app", "com.apple.Terminal", "Terminal"),
        ...app(`${HOME}/Applications/Claude.app`, "com.anthropic.claudefordesktop", "Claude"),
      ],
      {
        readdir: (dir) => {
          listed.push(dir);
          return Promise.resolve(listings[dir] ?? []);
        },
      },
    );

    const response = await detector.detect();

    expect(response.apps.terminal).toEqual([
      { bundleId: "com.apple.Terminal", name: "Terminal", location: "applications" },
    ]);
    expect(response.apps["claude-desktop"]).toEqual([
      {
        bundleId: "com.anthropic.claudefordesktop",
        name: "Claude",
        location: "user-applications",
      },
    ]);
    expect(listed).toContain("/Applications");
    expect(listed).toContain(`${HOME}/Applications`);
  });

  it("labels a bundle outside the Applications folders as other, and never returns a path", async () => {
    const { detector } = detectorWith([
      mdfind("com.anthropic.claudefordesktop", [
        `${HOME}/Applications/Claude.app`,
        "/Volumes/Backup/Claude.app",
      ]),
      ...app(`${HOME}/Applications/Claude.app`, "com.anthropic.claudefordesktop", "Claude"),
      ...app("/Volumes/Backup/Claude.app", "com.anthropic.claudefordesktop", "Claude"),
      NOTHING_ELSE,
    ]);

    const response = await detector.detect();

    expect(response.apps["claude-desktop"].map((found) => found.location)).toEqual([
      "user-applications",
      "other",
    ]);
    const serialised = JSON.stringify(response);
    expect(serialised).not.toContain(HOME);
    expect(serialised).not.toContain("/Volumes");
    expect(serialised).not.toContain(".app");
  });

  it("drops a match whose Info.plist names a different bundle", async () => {
    const { detector } = detectorWith([
      mdfind("com.apple.Terminal", ["/Applications/Impostor.app"]),
      ...app("/Applications/Impostor.app", "com.example.impostor", "Terminal"),
      NOTHING_ELSE,
    ]);
    const response = await detector.detect();
    expect(response.apps.terminal).toEqual([]);
  });

  it("offers the terminal presets from @ccc/launchers, all unverified", async () => {
    const { detector } = detectorWith([NOTHING_ELSE]);
    const response = await detector.detect();
    expect(response.terminalPresets).toEqual(
      TERMINAL_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        argv: [...preset.argv],
        verified: false,
      })),
    );
  });
});

describe("the Spotlight query guard (T-04-10)", () => {
  it("accepts bundle IDs with an optional trailing wildcard only", () => {
    expect(DETECTION_QUERY_PATTERN.test("com.google.antigravity*")).toBe(true);
    expect(DETECTION_QUERY_PATTERN.test("com.apple.Terminal")).toBe(true);
    expect(DETECTION_QUERY_PATTERN.test("x' || kMDItemFSName == '*")).toBe(false);
    expect(DETECTION_QUERY_PATTERN.test("com.*.evil")).toBe(false);
    expect(DETECTION_QUERY_PATTERN.test("")).toBe(false);
  });

  it("never hands a hostile bundle-ID value to mdfind", async () => {
    const { detector, runner } = detectorWith([NOTHING_ELSE]);
    const hostile = "com.example' || kMDItemFSName == '*";
    expect(await detector.findBundle(hostile)).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("finds a saved bundle ID by an exact query", async () => {
    const { detector, runner } = detectorWith([
      mdfind("com.google.antigravity", ["/Applications/Antigravity.app"]),
      ...app("/Applications/Antigravity.app", "com.google.antigravity", "Antigravity"),
      NOTHING_ELSE,
    ]);
    expect(await detector.findBundle("com.google.antigravity")).toBe(true);
    expect(runner.calls[0]?.args).toEqual([
      "kMDItemCFBundleIdentifier == 'com.google.antigravity'",
    ]);
    expect(await detector.findBundle("com.example.none")).toBe(false);
  });

  it("never treats a wildcard as an exact bundle when finding one to save", async () => {
    const { detector, runner } = detectorWith([NOTHING_ELSE]);
    expect(await detector.findBundle("com.google.*")).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("claude executable detection (D-21)", () => {
  it("lists the known install locations in order", () => {
    expect(CLAUDE_CANDIDATE_PATHS(HOME).map((candidate) => candidate.path)).toEqual([
      `${HOME}/.local/bin/claude`,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
  });

  it("returns only executable candidates, home-abbreviated, and remembers their paths in memory", async () => {
    const { detector } = detectorWith([NOTHING_ELSE], {
      executables: [`${HOME}/.local/bin/claude`, "/usr/local/bin/claude"],
    });

    const response = await detector.detect();

    expect(response.claudeExecutables.map((found) => found.displayPath)).toEqual([
      "~/.local/bin/claude",
      "/usr/local/bin/claude",
    ]);
    const [first] = response.claudeExecutables;
    expect(first).toBeDefined();
    // The symlink path, not its realpath: it survives Claude Code updates.
    expect(detector.candidatePath(first?.candidateId ?? "")).toBe(`${HOME}/.local/bin/claude`);
    expect(detector.candidatePath("unknown")).toBeNull();
    expect(JSON.stringify(response)).not.toContain(HOME);
  });

  it("before any detection, resolves only the known candidate IDs, to their fixed locations (codex review 3, finding 3)", () => {
    // A service restarted since the plugin's detection has an empty map; the
    // plugin's retained ID still names one of these fixed locations.
    const { detector } = detectorWith([NOTHING_ELSE]);
    for (const known of CLAUDE_CANDIDATE_PATHS(HOME)) {
      expect(detector.candidatePath(known.candidateId)).toBe(known.path);
    }
    expect(detector.candidatePath("never-detected")).toBeNull();
    expect(detector.candidatePath("/opt/homebrew/bin/claude")).toBeNull();
  });
});

describe("git detection (D-10)", () => {
  it("reports git available when xcode-select succeeds", async () => {
    const { detector } = detectorWith([NOTHING_ELSE], { gitAvailable: true });
    expect((await detector.detect()).git).toBe("available");
  });

  it("reports git unavailable when xcode-select fails and no fallback git exists", async () => {
    const { detector } = detectorWith([NOTHING_ELSE], { gitAvailable: false });
    expect((await detector.detect()).git).toBe("unavailable");
  });
});

describe("Codex detection merged into the launcher detection (plan 05.1-21, D-11, D-12)", () => {
  const CODEX = `${HOME}/.local/bin/codex`;
  const READY_BRIDGE: BridgeStatus = {
    state: "installed",
    protocol: 2,
    capabilities: ["agent"],
    launcherPresent: true,
    dir: `${HOME}/.local/state/codex-bridge`,
    dirSource: "primary",
    launchable: true,
    windows: [],
  };

  function withCodex() {
    const runner = createFakeCommandRunner({
      script: [
        {
          match: (file, args) => file === CODEX && args[0] === "--version",
          outcome: { exitCode: 0, stdout: "codex-cli 0.159.2\n" },
        },
      ],
    });
    const codex = createCodexDetection({
      runner,
      homeDir: HOME,
      isExecutable: (path) => Promise.resolve(path === CODEX),
      readBridgeStatus: () => READY_BRIDGE,
    });
    const detector = createDetector({
      runner: createFakeCommandRunner({ script: [NOTHING_ELSE] }),
      homeDir: HOME,
      readdir: () => Promise.resolve([]),
      isExecutable: () => Promise.resolve(false),
      resolveGit: () => Promise.resolve({ kind: "unavailable" }),
      codex,
    });
    return { detector };
  }

  it("adds the optional codex, bridge and suggestedTerminal members, all schema-valid", async () => {
    const response = await withCodex().detector.detect();
    expect(DetectionResponseSchema.parse(response)).toEqual(response);
    expect(response.codex).toEqual({
      executables: [
        {
          candidateId: "user-install",
          displayPath: "~/.local/bin/codex",
          version: "0.159.2",
          location: "user-install",
        },
      ],
      doctor: "unknown",
    });
    expect(response.bridge).toBe("installed");
    expect(response.suggestedTerminal).toEqual({ kind: "antigravity-terminal" });
    expect(JSON.stringify(response)).not.toContain(HOME);
  });

  it("resolves a Codex candidate id to its path through the detector", () => {
    const { detector } = withCodex();
    expect(detector.codexCandidatePath("user-install")).toBe(CODEX);
    expect(detector.codexCandidatePath("unknown")).toBeNull();
  });

  it("without the Codex dependency the response has none of the new members", async () => {
    const { detector } = detectorWith([NOTHING_ELSE]);
    const response = await detector.detect();
    expect(Object.keys(response).sort()).toEqual([
      "apps",
      "claudeExecutables",
      "detectedAt",
      "git",
      "terminalPresets",
    ]);
    expect(detector.codexCandidatePath("user-install")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// probeBundle (plan 08-04, D-49, T-08-07, T-08-08): a bounded existence check
// for the health probe. It never scans folders and never launches anything.

describe("Detector.probeBundle (D-49)", () => {
  const BUNDLE_ID = "com.google.antigravity";
  const APP = "/Applications/Antigravity.app";
  const RUN_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

  function probeSetup(
    script: readonly ScriptedReply[],
    readdirCalls: string[] = [],
  ): ReturnType<typeof detectorWith> {
    return detectorWith(script, {
      readdir: (dir) => {
        readdirCalls.push(dir);
        return Promise.resolve([]);
      },
    });
  }

  it("Test 1: a hit whose Info.plist matches is found after exactly one mdfind and one plutil, both capped", async () => {
    const controller = new AbortController();
    const { detector, runner } = probeSetup([
      mdfind(BUNDLE_ID, [APP]),
      plist(APP, "CFBundleIdentifier", BUNDLE_ID),
    ]);

    const result = await detector.probeBundle(BUNDLE_ID, { signal: controller.signal });

    expect(result).toBe("found");
    expect(runner.calls).toHaveLength(2);
    const [find, read] = runner.calls;
    expect(find?.file).toBe(MDFIND);
    expect(find?.args).toEqual([`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`]);
    expect(find?.options.timeoutMs).toBe(1500);
    expect(find?.options.env).toEqual(RUN_ENV);
    expect(find?.options.signal).toBe(controller.signal);
    expect(read?.file).toBe(PLUTIL);
    expect(read?.args).toEqual([
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      `${APP}/Contents/Info.plist`,
    ]);
    expect(read?.options.timeoutMs).toBe(500);
    expect(read?.options.env).toEqual(RUN_ENV);
    expect(read?.options.signal).toBe(controller.signal);
  });

  it("reads only the first hit and never any other file", async () => {
    const { detector, runner } = probeSetup([
      mdfind(BUNDLE_ID, [APP, "/Applications/Other.app"]),
      plist(APP, "CFBundleIdentifier", BUNDLE_ID),
    ]);
    expect(await detector.probeBundle(BUNDLE_ID)).toBe("found");
    expect(runner.calls.filter((call) => call.file === PLUTIL)).toHaveLength(1);
    // Every spawn is one of the two absolute system binaries: nothing is ever launched.
    expect(runner.calls.every((call) => call.file === MDFIND || call.file === PLUTIL)).toBe(true);
  });

  it("clamps both caps to a smaller overall budget", async () => {
    const { detector, runner } = probeSetup([
      mdfind(BUNDLE_ID, [APP]),
      plist(APP, "CFBundleIdentifier", BUNDLE_ID),
    ]);
    await detector.probeBundle(BUNDLE_ID, { timeoutMs: 300 });
    expect(runner.calls[0]?.options.timeoutMs).toBe(300);
    expect(runner.calls[1]?.options.timeoutMs).toBeLessThanOrEqual(300);
    expect(runner.calls[1]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it("Test 2: no mdfind hit is not-found, with no plutil call and no folder scan", async () => {
    const scanned: string[] = [];
    const { detector, runner } = probeSetup([NOTHING_ELSE], scanned);
    expect(await detector.probeBundle(BUNDLE_ID)).toBe("not-found");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.file).toBe(MDFIND);
    expect(scanned).toEqual([]);
  });

  it("Test 3: a timeout, an abort, a failed exit or an overflow is indeterminate and never scans", async () => {
    const outcomes: Array<Partial<import("./command-runner.js").CommandOutcome>> = [
      { exitCode: null, errno: null, timedOut: true },
      { exitCode: null, errno: "ABORT_ERR" },
      { exitCode: null, errno: "ENOENT" },
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: `${APP}\n`, truncated: true },
    ];
    for (const outcome of outcomes) {
      const scanned: string[] = [];
      const { detector, runner } = probeSetup(
        [{ match: (file) => file === MDFIND, outcome }],
        scanned,
      );
      expect(await detector.probeBundle(BUNDLE_ID), JSON.stringify(outcome)).toBe("indeterminate");
      expect(runner.calls.filter((call) => call.file === PLUTIL)).toHaveLength(0);
      expect(scanned).toEqual([]);
    }
  });

  it("Test 3a: an empty answer that came with a diagnostic on stderr (Spotlight off) is indeterminate, not not-found", async () => {
    const { detector } = probeSetup([
      {
        match: (file) => file === MDFIND,
        outcome: { exitCode: 0, stdout: "", stderr: "indexing is disabled\n" },
      },
    ]);
    expect(await detector.probeBundle(BUNDLE_ID)).toBe("indeterminate");
  });

  it("Test 3b: a hit that is not an absolute .app path is indeterminate and nothing is read", async () => {
    for (const line of [
      "relative/Foo.app",
      "/Applications/Foo.txt",
      "/Applications/Fo\u0001o.app",
    ]) {
      const { detector, runner } = probeSetup([
        { match: (file) => file === MDFIND, outcome: { exitCode: 0, stdout: `${line}\n` } },
      ]);
      expect(await detector.probeBundle(BUNDLE_ID), line).toBe("indeterminate");
      expect(runner.calls.filter((call) => call.file === PLUTIL)).toHaveLength(0);
    }
  });

  it("Test 3c: a signal aborted before the call is indeterminate with no spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const { detector, runner } = probeSetup([mdfind(BUNDLE_ID, [APP])]);
    expect(await detector.probeBundle(BUNDLE_ID, { signal: controller.signal })).toBe(
      "indeterminate",
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("an abort between the two spawns stops before plutil", async () => {
    const controller = new AbortController();
    const script: ScriptedReply[] = [
      {
        match: (file) => {
          if (file === MDFIND) controller.abort();
          return file === MDFIND;
        },
        outcome: { exitCode: 0, stdout: `${APP}\n` },
      },
      plist(APP, "CFBundleIdentifier", BUNDLE_ID),
    ];
    const { detector, runner } = probeSetup(script);
    expect(await detector.probeBundle(BUNDLE_ID, { signal: controller.signal })).toBe(
      "indeterminate",
    );
    expect(runner.calls.filter((call) => call.file === PLUTIL)).toHaveLength(0);
  });

  it("a plist that cannot be read, times out, or names another bundle is indeterminate, never found or not-found", async () => {
    const replies: Array<Partial<import("./command-runner.js").CommandOutcome>> = [
      { exitCode: 1, stdout: "" },
      { exitCode: null, timedOut: true },
      { exitCode: null, errno: "ABORT_ERR" },
      { exitCode: 0, stdout: "com.example.something-else\n" },
      { exitCode: 0, stdout: "not a bundle id with spaces\n" },
      { exitCode: 0, stdout: "\n" },
    ];
    for (const outcome of replies) {
      const { detector } = probeSetup([
        mdfind(BUNDLE_ID, [APP]),
        { match: (file) => file === PLUTIL, outcome },
      ]);
      expect(await detector.probeBundle(BUNDLE_ID), JSON.stringify(outcome)).toBe("indeterminate");
    }
  });

  it("Test 4: an id that fails BundleIdSchema or the query pattern is indeterminate with no spawn", async () => {
    for (const hostile of [
      "com.example' || kMDItemFSName == '*",
      "com example",
      "com.*.evil",
      "com.google.*",
      "com.google.antigravity*",
      "",
      `com.${"a".repeat(260)}`,
      "com.example\nnewline",
      "com.example/../../x",
    ]) {
      const { detector, runner } = probeSetup([NOTHING_ELSE]);
      expect(await detector.probeBundle(hostile), JSON.stringify(hostile)).toBe("indeterminate");
      expect(runner.calls).toHaveLength(0);
    }
  });

  it("Test 5: findBundle still uses the fallback folder scan and its own caps", async () => {
    const scanned: string[] = [];
    const { detector, runner } = probeSetup([mdfindFails()], scanned);
    await detector.findBundle(BUNDLE_ID);
    expect(scanned.length).toBeGreaterThan(0);
    expect(runner.calls[0]?.options.timeoutMs).toBe(5000);
  });

  it("never logs or returns what the children printed", async () => {
    const logged: string[] = [];
    const spies = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation((...args: unknown[]) => {
        logged.push(args.join(" "));
      }),
    );
    try {
      const { detector } = probeSetup([
        mdfind(BUNDLE_ID, ["/Applications/Secret Project Name.app"]),
        plist("/Applications/Secret Project Name.app", "CFBundleIdentifier", BUNDLE_ID),
      ]);
      const result = await detector.probeBundle(BUNDLE_ID);
      expect(result).toBe("found");
      expect(JSON.stringify(result)).not.toContain("Secret");
      expect(logged).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
