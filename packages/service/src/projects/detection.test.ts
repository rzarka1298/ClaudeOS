import { DetectionResponseSchema } from "@ccc/domain";
import { TERMINAL_PRESETS } from "@ccc/launchers";
import { describe, expect, it } from "vitest";
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
