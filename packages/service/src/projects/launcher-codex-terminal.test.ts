import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAUNCHERS_MARK_TESTED_PATH, LAUNCHERS_SAVE_PATH, LAUNCHERS_TEST_PATH } from "@ccc/domain";
import { getLauncherConfig, saveLauncherConfig } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LauncherHarness, startLauncherHarness } from "../test-support/launcher-harness.js";
import { TEST_ALREADY_RUNNING_BODY } from "./launcher-routes.js";

/**
 * Codex opens in the claude-code row's terminal (D-11), so a Codex Test and
 * the pass it earns belong to the Codex row AND that terminal: changing the
 * terminal must stop a running Test being joined and a stale pass being
 * accepted by Mark Tested (Codex review, finding 4).
 */

let harness: LauncherHarness;
let codexPath: string;
let claudePath: string;

function makeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

const TERMINAL_APP = { kind: "terminal-app" } as const;
const OTHER_TERMINAL = { kind: "antigravity-terminal" } as const;

function seedRows(terminal: unknown): void {
  saveLauncherConfig(harness.store.db, "claude-code", {
    executablePath: claudePath,
    args: [],
    terminal,
  });
  saveLauncherConfig(harness.store.db, "codex", { executablePath: codexPath, args: [] });
}

beforeEach(async () => {
  harness = await startLauncherHarness({ script: [], isExecutable: async () => true });
  codexPath = join(harness.homeDir, ".local", "bin", "codex");
  claudePath = join(harness.homeDir, ".local", "bin", "claude");
  makeExecutable(codexPath);
  makeExecutable(claudePath);
});

afterEach(() => {
  harness.close();
});

describe("a Codex Test is tied to the shared terminal (Codex review, finding 4)", () => {
  it("does not let a Test started under a changed terminal join the running one", async () => {
    seedRows(TERMINAL_APP);
    harness.spawner.mode = { kind: "succeed", delayMs: 200 };
    const first = harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The terminal changes under the running Test; the Codex row itself is untouched.
    const claude = getLauncherConfig(harness.store.db, "claude-code");
    saveLauncherConfig(harness.store.db, "claude-code", {
      ...(claude?.config as object),
      terminal: OTHER_TERMINAL,
    });
    const second = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
    expect(second).toEqual({ status: 409, body: TEST_ALREADY_RUNNING_BODY });
    expect((await first).status).toBe(200);
  });

  it("does not accept a pass earned under another terminal at Mark Tested", async () => {
    seedRows(TERMINAL_APP);
    expect((await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" })).body).toEqual({
      ok: true,
    });
    saveLauncherConfig(harness.store.db, "claude-code", {
      executablePath: claudePath,
      args: [],
      terminal: OTHER_TERMINAL,
    });
    const mark = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" });
    expect(mark.status).toBe(409);
    expect(mark.body).toEqual({ error: "launcher has no passing test" });
    expect(getLauncherConfig(harness.store.db, "codex")?.tested).toBe(false);
  });

  it("still accepts a pass when the terminal is unchanged", async () => {
    seedRows(TERMINAL_APP);
    await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
    const mark = await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" });
    expect(mark.status).toBe(200);
    expect(getLauncherConfig(harness.store.db, "codex")?.tested).toBe(true);
  });

  it("clears the Codex tested status when a save changes the claude-code terminal", async () => {
    seedRows(TERMINAL_APP);
    await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
    await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" });
    expect(getLauncherConfig(harness.store.db, "codex")?.tested).toBe(true);

    const save = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "path", path: claudePath },
      args: [],
      terminal: OTHER_TERMINAL,
    });
    expect(save.status).toBe(200);
    expect(getLauncherConfig(harness.store.db, "codex")?.tested).toBe(false);
  });

  it("keeps the Codex tested status when the claude-code save leaves the terminal alone", async () => {
    seedRows(TERMINAL_APP);
    await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "codex" });
    await harness.post(LAUNCHERS_MARK_TESTED_PATH, { launcherId: "codex" });

    const save = await harness.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "claude-code",
      executable: { kind: "path", path: claudePath },
      args: [],
      terminal: TERMINAL_APP,
    });
    expect(save.status).toBe(200);
    expect(getLauncherConfig(harness.store.db, "codex")?.tested).toBe(true);
  });
});
