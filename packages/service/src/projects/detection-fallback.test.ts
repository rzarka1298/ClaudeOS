import { describe, expect, it } from "vitest";
import {
  createFakeCommandRunner,
  type ScriptedReply,
} from "../test-support/fake-command-runner.js";
import { createDetector } from "./detection.js";

/**
 * Wave-5 review finding 9: Spotlight can answer with paths that no longer
 * hold the bundle (a stale index after an app moved or was deleted). When
 * none of the paths it named is confirmed by its own `Info.plist`, the
 * detector falls back to the folder scan instead of reporting nothing. Every
 * process is the fake runner; no real `mdfind` or `plutil` runs.
 */

const HOME = "/Users/USERNAME";
const MDFIND = "/usr/bin/mdfind";
const PLUTIL = "/usr/bin/plutil";
const CLAUDE_QUERY = "kMDItemCFBundleIdentifier == 'com.anthropic.claudefordesktop'";

function plist(app: string, key: string, value: string): ScriptedReply {
  return {
    match: (file, args) =>
      file === PLUTIL && args[1] === key && args[args.length - 1] === `${app}/Contents/Info.plist`,
    outcome: { exitCode: 0, stdout: `${value}\n` },
  };
}

function detectorWith(script: readonly ScriptedReply[], listings: Record<string, string[]>) {
  const runner = createFakeCommandRunner({ script });
  const listed: string[] = [];
  const detector = createDetector({
    runner,
    homeDir: HOME,
    readdir: (dir) => {
      listed.push(dir);
      return Promise.resolve(listings[dir] ?? []);
    },
    isExecutable: () => Promise.resolve(false),
    resolveGit: () => Promise.resolve({ kind: "unavailable" }),
    now: () => new Date("2026-09-30T12:00:00.000Z"),
  });
  return { detector, listed };
}

describe("Spotlight answers only stale paths (finding 9)", () => {
  it("falls back to the folder scan when no Spotlight path is confirmed", async () => {
    const stale = "/Applications/Old Claude.app";
    const moved = `${HOME}/Applications/Claude.app`;
    const { detector, listed } = detectorWith(
      [
        // Spotlight still names the old location; its Info.plist is gone
        // (unscripted plutil call fails).
        {
          match: (file, args) => file === MDFIND && args[0] === CLAUDE_QUERY,
          outcome: { exitCode: 0, stdout: `${stale}\n` },
        },
        { match: (file) => file === MDFIND, outcome: { exitCode: 0, stdout: "" } },
        plist(moved, "CFBundleIdentifier", "com.anthropic.claudefordesktop"),
        plist(moved, "CFBundleName", "Claude"),
      ],
      { [`${HOME}/Applications`]: ["Claude.app"] },
    );

    const response = await detector.detect();

    expect(response.apps["claude-desktop"]).toEqual([
      { bundleId: "com.anthropic.claudefordesktop", name: "Claude", location: "user-applications" },
    ]);
    expect(listed).toContain(`${HOME}/Applications`);
  });

  it("findBundle (the save-time check) also falls back when Spotlight's paths are stale", async () => {
    const moved = `${HOME}/Applications/Claude.app`;
    const { detector } = detectorWith(
      [
        {
          match: (file, args) => file === MDFIND && args[0] === CLAUDE_QUERY,
          outcome: { exitCode: 0, stdout: "/Applications/Gone.app\n" },
        },
        plist(moved, "CFBundleIdentifier", "com.anthropic.claudefordesktop"),
      ],
      { [`${HOME}/Applications`]: ["Claude.app"] },
    );
    expect(await detector.findBundle("com.anthropic.claudefordesktop")).toBe(true);
  });

  it("does not scan the folders when Spotlight's answer is confirmed", async () => {
    const app = "/Applications/Claude.app";
    const { detector, listed } = detectorWith(
      [
        {
          match: (file, args) => file === MDFIND && args[0] === CLAUDE_QUERY,
          outcome: { exitCode: 0, stdout: `${app}\n` },
        },
        plist(app, "CFBundleIdentifier", "com.anthropic.claudefordesktop"),
      ],
      {},
    );
    expect(await detector.findBundle("com.anthropic.claudefordesktop")).toBe(true);
    expect(listed).toEqual([]);
  });
});
