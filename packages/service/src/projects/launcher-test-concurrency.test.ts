import { LAUNCHERS_SAVE_PATH, LAUNCHERS_TEST_PATH, type LauncherId } from "@ccc/domain";
import type { LauncherConfigRecord } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScriptedReply } from "../test-support/fake-command-runner.js";
import { type LauncherHarness, startLauncherHarness } from "../test-support/launcher-harness.js";
import { recordTestOutcome, TEST_ALREADY_RUNNING_BODY } from "./launcher-routes.js";

/**
 * Wave-5 review findings 2 (server half) and 3.
 *
 * - Finding 2: one Test per launcher at a time. A second Test of the SAME
 *   saved configuration while the first is running shares the first's result
 *   (a double press, or two open views) and spawns nothing more; a Test of a
 *   configuration saved since the running one began is refused with a
 *   constant 409, because the running Test is not testing it.
 * - Finding 3: a Test that did not pass removes the launcher's recorded pass
 *   only when that pass is for the configuration the Test read — never a
 *   pass a newer configuration earned meanwhile.
 *
 * Every process port is a fake; the runtime directory is a temp dir.
 */

let harness: LauncherHarness;

beforeEach(async () => {
  const app = "/Applications/Antigravity.app";
  const script: ScriptedReply[] = [
    {
      match: (file, args) =>
        file === "/usr/bin/mdfind" &&
        args[0] === "kMDItemCFBundleIdentifier == 'com.google.antigravity'",
      outcome: { exitCode: 0, stdout: `${app}\n` },
    },
    {
      match: (file, args) =>
        file === "/usr/bin/plutil" &&
        args[1] === "CFBundleIdentifier" &&
        args[args.length - 1] === `${app}/Contents/Info.plist`,
      outcome: { exitCode: 0, stdout: "com.google.antigravity\n" },
    },
  ];
  harness = await startLauncherHarness({ script });
});

afterEach(() => {
  harness.close();
});

async function saveAntigravity(): Promise<void> {
  const reply = await harness.post(LAUNCHERS_SAVE_PATH, {
    launcherId: "antigravity",
    bundleId: "com.google.antigravity",
  });
  expect(reply.status).toBe(200);
}

describe("one Test per launcher at a time (finding 2)", () => {
  it("a concurrent Test of the same configuration shares the running Test's result", async () => {
    await saveAntigravity();
    harness.spawner.mode = { kind: "succeed", delayMs: 150 };
    const [first, second] = await Promise.all([
      harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" }),
      harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" }),
    ]);
    expect(first).toEqual({ status: 200, body: { ok: true } });
    expect(second).toEqual({ status: 200, body: { ok: true } });
    expect(harness.spawner.calls).toHaveLength(1);
  });

  it("a Test after the running one finished launches again", async () => {
    await saveAntigravity();
    await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });
    await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });
    expect(harness.spawner.calls).toHaveLength(2);
  });

  it("refuses a Test of a configuration saved while an older one is still running", async () => {
    await saveAntigravity();
    harness.spawner.mode = { kind: "succeed", delayMs: 200 };
    const first = harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });
    // Let the first Test reach the spawner before the re-save.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await saveAntigravity();
    const second = await harness.post(LAUNCHERS_TEST_PATH, { launcherId: "antigravity" });
    expect(second).toEqual({ status: 409, body: TEST_ALREADY_RUNNING_BODY });
    expect((await first).status).toBe(200);
    expect(harness.spawner.calls).toHaveLength(1);
  });

  it("different launchers test independently", async () => {
    harness.spawner.mode = { kind: "succeed", delayMs: 100 };
    const [finder, github] = await Promise.all([
      harness.post(LAUNCHERS_TEST_PATH, { launcherId: "finder" }),
      harness.post(LAUNCHERS_TEST_PATH, { launcherId: "github" }),
    ]);
    expect(finder.body).toEqual({ ok: true });
    expect(github.body).toEqual({ ok: true });
    expect(harness.spawner.calls).toHaveLength(2);
  });

  it("the busy refusal is a constant that names no path", () => {
    expect(TEST_ALREADY_RUNNING_BODY).toEqual({
      error: "a test of this launcher is already running",
    });
  });
});

describe("a failed Test removes only its own configuration's pass (finding 3)", () => {
  const ID: LauncherId = "antigravity";
  function record(updatedAt: string, bundleId: string): LauncherConfigRecord {
    return {
      launcherId: ID,
      config: { bundleId },
      tested: false,
      updatedAt,
    } as unknown as LauncherConfigRecord;
  }
  const older = record("2026-09-30T12:00:00.000Z", "com.google.antigravity");
  const newer = record("2026-09-30T12:00:05.000Z", "com.google.antigravity-ide");

  it("keeps a newer configuration's pass when an older Test fails", () => {
    const passed = new Map<LauncherId, string>();
    recordTestOutcome(passed, ID, { ok: true }, newer, newer);
    const newerPass = passed.get(ID);
    expect(newerPass).toBeDefined();
    recordTestOutcome(passed, ID, { ok: false, error: "timeout" }, older, newer);
    expect(passed.get(ID)).toBe(newerPass);
  });

  it("removes the pass the failed Test's own configuration held", () => {
    const passed = new Map<LauncherId, string>();
    recordTestOutcome(passed, ID, { ok: true }, older, older);
    recordTestOutcome(passed, ID, { ok: false, error: "app-not-found" }, older, older);
    expect(passed.has(ID)).toBe(false);
  });

  it("a pass across a save (before differs from after) records nothing and removes nothing newer", () => {
    const passed = new Map<LauncherId, string>();
    recordTestOutcome(passed, ID, { ok: true }, newer, newer);
    const newerPass = passed.get(ID);
    recordTestOutcome(passed, ID, { ok: true }, older, newer);
    expect(passed.get(ID)).toBe(newerPass);
  });
});
