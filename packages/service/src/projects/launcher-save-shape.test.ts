import { LAUNCHERS_SAVE_PATH } from "@ccc/domain";
import { getLauncherConfig } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LauncherHarness, startLauncherHarness } from "../test-support/launcher-harness.js";

/**
 * Wave-5 review finding 8 (ADR-0024 residual risks): a typed Claude Code
 * path must name Claude Code, not an interpreter or launcher shim that would
 * run its "arguments" as a program, and the arguments must not carry
 * `--settings`, which loads a settings file whose permission mode the
 * template validator cannot see. Every check runs before anything is stored.
 * `isExecutable` is faked true so only the new checks decide.
 */

let harness: LauncherHarness;

beforeEach(async () => {
  harness = await startLauncherHarness({ script: [], isExecutable: () => Promise.resolve(true) });
});

afterEach(() => {
  harness.close();
});

function saveTyped(path: string, args: readonly string[] = []) {
  return harness.post(LAUNCHERS_SAVE_PATH, {
    launcherId: "claude-code",
    executable: { kind: "path", path },
    args,
    terminal: { kind: "terminal-app" },
  });
}

describe("a typed Claude Code path that is an interpreter or shim is refused (finding 8)", () => {
  it.each([
    "/bin/sh",
    "/bin/bash",
    "/bin/zsh",
    "/bin/dash",
    "/bin/ksh",
    "/opt/homebrew/bin/fish",
    "/usr/bin/env",
    "/usr/bin/osascript",
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3.13",
    "/usr/local/bin/python",
    "/opt/homebrew/bin/node",
    "/usr/bin/perl",
    "/usr/bin/perl5.34",
    "/usr/bin/ruby",
    "/usr/bin/open",
    "/BIN/SH",
  ])("refuses %s as argv[0], names no path and stores nothing", async (path) => {
    const reply = await saveTyped(path, ["--model", "opus"]);
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      error: "launcher config refused",
      reason: "executable-not-found",
      index: 0,
      template: "claude-code",
    });
    expect(JSON.stringify(reply.body)).not.toContain(path);
    expect(getLauncherConfig(harness.store.db, "claude-code")).toBeNull();
  });

  it("accepts a typed path whose basename is claude", async () => {
    const reply = await saveTyped("/usr/local/bin/claude", ["--model", "opus"]);
    expect(reply.status).toBe(200);
  });
});

describe("--settings is refused in the Claude Code arguments (finding 8)", () => {
  it.each([
    [["--settings", "x.json"], 1],
    [["--model", "opus", "--settings=x.json"], 3],
    [["--model", "opus", "--SETTINGS", "{}"], 3],
  ] as const)("refuses %j at index %i as forbidden-flag", async (args, index) => {
    const reply = await saveTyped("/usr/local/bin/claude", args);
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      error: "launcher config refused",
      reason: "forbidden-flag",
      index,
      template: "claude-code",
    });
    expect(getLauncherConfig(harness.store.db, "claude-code")).toBeNull();
  });

  it("allows an argument that merely mentions settings as a value", async () => {
    const reply = await saveTyped("/usr/local/bin/claude", ["--append-system-prompt", "settings"]);
    expect(reply.status).toBe(200);
  });
});
