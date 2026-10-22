import { describe, expect, it } from "vitest";
import {
  createFakeCommandRunner,
  type ScriptedReply,
} from "../test-support/fake-command-runner.js";
import {
  CLAUDE_CANDIDATE_PATHS,
  claudeCandidatesFromEnv,
  createDetector,
  homeApplicationsFromEnv,
} from "./detection.js";
import { resolveGit } from "./git-runner.js";

/**
 * The UAT sandbox override for Claude detection (lane B review M6), the same
 * shape as the Codex one: a service started in a sandbox inherits the real HOME,
 * so `CCC_CLAUDE_CANDIDATES_DISABLED=1` / `CCC_CLAUDE_CANDIDATES_DIR=<abs dir>`
 * keep it from statting, listing or reading anything under the real home. Every
 * test uses fakes: no real spawn, stat or readdir.
 */

const HOME = "/Users/USERNAME";
const MDFIND = "/usr/bin/mdfind";
const PLUTIL = "/usr/bin/plutil";
const SANDBOX = "/private/tmp/ccc-uat/claude-fake";

describe("claudeCandidatesFromEnv", () => {
  it("is the fixed list when neither variable is set", () => {
    expect(claudeCandidatesFromEnv({}, HOME)).toEqual(CLAUDE_CANDIDATE_PATHS(HOME));
    expect(homeApplicationsFromEnv({}, HOME)).toBe(`${HOME}/Applications`);
  });

  it("DISABLED=1 drops the home-relative candidate and the home Applications folder, keeping system locations", () => {
    const env = { CCC_CLAUDE_CANDIDATES_DISABLED: "1" };
    expect(claudeCandidatesFromEnv(env, HOME).map((candidate) => candidate.path)).toEqual([
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(homeApplicationsFromEnv(env, HOME)).toBeNull();
  });

  it("DIR replaces the home-relative candidate and the home Applications folder", () => {
    const env = { CCC_CLAUDE_CANDIDATES_DIR: SANDBOX };
    expect(claudeCandidatesFromEnv(env, HOME)).toEqual([
      { candidateId: "local-bin", path: `${SANDBOX}/claude` },
      { candidateId: "homebrew", path: "/opt/homebrew/bin/claude" },
      { candidateId: "usr-local", path: "/usr/local/bin/claude" },
    ]);
    expect(homeApplicationsFromEnv(env, HOME)).toBe(`${SANDBOX}/Applications`);
    // A trailing slash does not double up.
    expect(
      claudeCandidatesFromEnv({ CCC_CLAUDE_CANDIDATES_DIR: `${SANDBOX}/` }, HOME)[0]?.path,
    ).toBe(`${SANDBOX}/claude`);
  });

  it("a relative, NUL-bearing or empty DIR is ignored and the case is treated as disabled", () => {
    for (const dir of ["relative/dir", "", `${SANDBOX}\0/x`, "~/x"]) {
      const env = { CCC_CLAUDE_CANDIDATES_DIR: dir };
      expect(
        claudeCandidatesFromEnv(env, HOME).map((candidate) => candidate.path),
        JSON.stringify(dir),
      ).toEqual(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
      expect(homeApplicationsFromEnv(env, HOME), JSON.stringify(dir)).toBeNull();
    }
  });

  it("DISABLED wins over DIR, and only the exact value 1 disables", () => {
    expect(
      claudeCandidatesFromEnv(
        { CCC_CLAUDE_CANDIDATES_DISABLED: "1", CCC_CLAUDE_CANDIDATES_DIR: SANDBOX },
        HOME,
      ).map((candidate) => candidate.path),
    ).toEqual(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
    for (const value of ["0", "true", "", "yes"]) {
      expect(
        claudeCandidatesFromEnv({ CCC_CLAUDE_CANDIDATES_DISABLED: value }, HOME),
        value,
      ).toEqual(CLAUDE_CANDIDATE_PATHS(HOME));
    }
  });
});

function detectorFor(env: Record<string, string | undefined>, script: readonly ScriptedReply[]) {
  const listed: string[] = [];
  const statted: string[] = [];
  const runner = createFakeCommandRunner({ script });
  const detector = createDetector({
    runner,
    homeDir: HOME,
    env,
    readdir: (dir) => {
      listed.push(dir);
      return Promise.resolve([]);
    },
    isExecutable: (path) => {
      statted.push(path);
      return Promise.resolve(false);
    },
    resolveGit: () =>
      resolveGit(
        createFakeCommandRunner({
          script: [{ match: () => true, outcome: { exitCode: 0 } }],
        }),
        () => false,
      ),
    now: () => new Date("2026-10-22T09:00:00.000Z"),
  });
  return { detector, runner, listed, statted };
}

const NOTHING: ScriptedReply = {
  match: (file) => file === MDFIND,
  outcome: { exitCode: 0, stdout: "" },
};

describe("Detector under the Claude sandbox override", () => {
  it("default: stats the home candidate and lists ~/Applications", async () => {
    const { detector, listed, statted } = detectorFor({}, [NOTHING]);
    await detector.detect();
    expect(statted).toContain(`${HOME}/.local/bin/claude`);
    expect(listed).toContain(`${HOME}/Applications`);
  });

  it("DISABLED=1: nothing under the real home is stat-ed or listed; /Applications and system folders still are", async () => {
    const { detector, listed, statted } = detectorFor({ CCC_CLAUDE_CANDIDATES_DISABLED: "1" }, [
      NOTHING,
    ]);
    await detector.detect();
    expect(statted).toEqual(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
    expect(listed.some((dir) => dir.startsWith(HOME))).toBe(false);
    expect(listed).toEqual(
      expect.arrayContaining([
        "/Applications",
        "/Applications/Utilities",
        "/System/Applications",
        "/System/Applications/Utilities",
      ]),
    );
    // The disabled home candidate no longer resolves, not even by its fixed id.
    expect(detector.candidatePath("local-bin")).toBeNull();
    expect(detector.candidatePath("homebrew")).toBe("/opt/homebrew/bin/claude");
  });

  it("DIR: the candidate is <dir>/claude, ~/Applications becomes <dir>/Applications, the real home is untouched", async () => {
    const { detector, listed, statted } = detectorFor({ CCC_CLAUDE_CANDIDATES_DIR: SANDBOX }, [
      NOTHING,
    ]);
    await detector.detect();
    expect(statted).toContain(`${SANDBOX}/claude`);
    expect(statted.some((path) => path.startsWith(HOME))).toBe(false);
    expect(listed).toContain(`${SANDBOX}/Applications`);
    expect(listed.some((dir) => dir.startsWith(HOME))).toBe(false);
    expect(detector.candidatePath("local-bin")).toBe(`${SANDBOX}/claude`);
  });

  it("an invalid DIR behaves as disabled", async () => {
    const { detector, listed, statted } = detectorFor({ CCC_CLAUDE_CANDIDATES_DIR: "relative" }, [
      NOTHING,
    ]);
    await detector.detect();
    expect(statted.some((path) => path.startsWith(HOME) || path.startsWith("relative"))).toBe(
      false,
    );
    expect(listed.some((dir) => dir.startsWith(HOME) || dir.startsWith("relative"))).toBe(false);
  });

  it("DISABLED=1: a Spotlight hit under the real ~/Applications is never read with plutil", async () => {
    const real = `${HOME}/Applications/Claude.app`;
    const { detector, runner } = detectorFor({ CCC_CLAUDE_CANDIDATES_DISABLED: "1" }, [
      {
        match: (file, args) =>
          file === MDFIND &&
          args[0] === "kMDItemCFBundleIdentifier == 'com.anthropic.claudefordesktop'",
        outcome: { exitCode: 0, stdout: `${real}\n` },
      },
      NOTHING,
    ]);
    const response = await detector.detect();
    expect(
      runner.calls.some((call) => call.file === PLUTIL && call.args.at(-1)?.startsWith(HOME)),
    ).toBe(false);
    expect(response.apps["claude-desktop"]).toEqual([]);
  });

  it("DISABLED=1: probeBundle never reads a hit under the real ~/Applications", async () => {
    const real = `${HOME}/Applications/Claude.app`;
    const { detector, runner } = detectorFor({ CCC_CLAUDE_CANDIDATES_DISABLED: "1" }, [
      {
        match: (file) => file === MDFIND,
        outcome: {
          exitCode: 0,
          stdout: `/System/Applications/Utilities/Terminal.app\n${real}\n`,
        },
      },
    ]);
    expect(await detector.probeBundle("com.anthropic.claudefordesktop")).toBe("not-found");
    expect(runner.calls.some((call) => call.file === PLUTIL)).toBe(false);
  });

  it("without the override a hit under ~/Applications is still read (nothing changes by default)", async () => {
    const real = `${HOME}/Applications/Claude.app`;
    const { detector, runner } = detectorFor({}, [
      {
        match: (file) => file === MDFIND,
        outcome: {
          exitCode: 0,
          stdout: `/System/Applications/Utilities/Terminal.app\n${real}\n`,
        },
      },
      {
        match: (file) => file === PLUTIL,
        outcome: { exitCode: 0, stdout: "com.anthropic.claudefordesktop\n" },
      },
    ]);
    expect(await detector.probeBundle("com.anthropic.claudefordesktop")).toBe("found");
    expect(runner.calls.some((call) => call.file === PLUTIL)).toBe(true);
  });
});
