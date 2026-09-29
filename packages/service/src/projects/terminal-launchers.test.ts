import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TerminalLaunchInput } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import { ensureScriptDir } from "./script-dir.js";
import { createTerminalAppLauncher, selectTerminalLauncher } from "./terminal-launchers.js";

let runtimeDir: string;
let scriptDir: string;

function input(overrides: Partial<TerminalLaunchInput> = {}): TerminalLaunchInput {
  return {
    cwd: "/Users/USERNAME/code/example project",
    argv: ["/usr/local/bin/claude", "--flag"],
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "ccc-terminal-launchers-"));
  scriptDir = ensureScriptDir(runtimeDir);
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("the Terminal.app adapter (D-20, D-28)", () => {
  it("writes one script and hands it to Terminal by bundle ID, with no Apple Event", async () => {
    const spawner = createFakeSpawner();
    const launcher = createTerminalAppLauncher({ spawner, scriptDir });
    await expect(launcher.launch(input())).resolves.toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/open", "-b", "com.apple.Terminal"]);
    expect(argv).toHaveLength(4);
    const script = argv[3] ?? "";
    expect(dirname(script)).toBe(scriptDir);
    expect(readdirSync(scriptDir)).toHaveLength(1);
    const body = readFileSync(script, "utf8");
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).toContain("'/Users/USERNAME/code/example project'");
    expect(body).toContain("'/usr/local/bin/claude' '--flag'");
  });

  it("exports the env inside the script, never through the open child", async () => {
    const spawner = createFakeSpawner();
    const launcher = createTerminalAppLauncher({ spawner, scriptDir });
    await launcher.launch(input({ env: { CCC_RUN_ID: "r1" } }));
    const call = spawner.calls[0];
    expect(readFileSync(call?.argv[3] ?? "", "utf8")).toContain("export CCC_RUN_ID='r1'");
    expect(JSON.stringify(call?.opts ?? {})).not.toContain("CCC_RUN_ID");
  });

  it("passes the pipeline's abort signal to the spawn", async () => {
    const spawner = createFakeSpawner();
    const controller = new AbortController();
    await createTerminalAppLauncher({ spawner, scriptDir }).launch(
      input({ signal: controller.signal }),
    );
    expect(spawner.calls[0]?.opts.signal).toBe(controller.signal);
  });

  it("maps a bundle-not-found outcome to app-not-found and removes the unused script", async () => {
    const spawner = createFakeSpawner({
      kind: "fail",
      outcome: { exitCode: 1, stderrClass: "bundle-not-found" },
    });
    await expect(
      createTerminalAppLauncher({ spawner, scriptDir }).launch(input()),
    ).resolves.toEqual({ ok: false, error: "app-not-found" });
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("maps a script write failure to spawn-failed and spawns nothing", async () => {
    const spawner = createFakeSpawner();
    const launcher = createTerminalAppLauncher({ spawner, scriptDir: join(runtimeDir, "absent") });
    await expect(launcher.launch(input())).resolves.toEqual({ ok: false, error: "spawn-failed" });
    expect(spawner.calls).toHaveLength(0);
  });

  it("refuses an unsafe value before any script exists", async () => {
    const spawner = createFakeSpawner();
    const launcher = createTerminalAppLauncher({ spawner, scriptDir });
    await expect(launcher.launch(input({ argv: ["/bin/echo", "a\nb"] }))).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    await expect(launcher.launch(input({ env: { PATH: "/tmp" } }))).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(readdirSync(scriptDir)).toEqual([]);
    expect(spawner.calls).toHaveLength(0);
  });

  it("an already-aborted signal opens nothing and leaves no script", async () => {
    const spawner = createFakeSpawner();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createTerminalAppLauncher({ spawner, scriptDir }).launch(
        input({ signal: controller.signal }),
      ),
    ).resolves.toEqual({ ok: false, error: "timeout" });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("leaves a possibly handed-off script for the sweep when the hand-off timed out", async () => {
    const spawner = createFakeSpawner({
      kind: "fail",
      outcome: { exitCode: null, timedOut: true },
    });
    await expect(
      createTerminalAppLauncher({ spawner, scriptDir }).launch(input()),
    ).resolves.toEqual({ ok: false, error: "timeout" });
    const [script] = spawner.calls[0]?.argv.slice(3) ?? [];
    expect(existsSync(script ?? "")).toBe(true);
  });
});

describe("selectTerminalLauncher (PROJ-10, D-21)", () => {
  it("returns the Terminal.app adapter for { kind: terminal-app }", async () => {
    const spawner = createFakeSpawner();
    const launcher = selectTerminalLauncher({ kind: "terminal-app" }, { spawner, scriptDir });
    expect(launcher).not.toBeNull();
    await expect(launcher?.launch(input())).resolves.toEqual({ ok: true });
    expect(spawner.calls[0]?.argv.slice(0, 3)).toEqual([
      "/usr/bin/open",
      "-b",
      "com.apple.Terminal",
    ]);
  });
});
