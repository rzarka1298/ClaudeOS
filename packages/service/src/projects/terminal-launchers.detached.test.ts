import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecFileCommandRunner } from "./command-runner.js";
import { ensureScriptDir } from "./script-dir.js";
import { createCommandSpawner } from "./spawner.js";
import { createCustomTemplateLauncher, isExecutableFile } from "./terminal-launchers.js";

/*
 * Wave-4b review, finding 1: a custom template whose argv[0] is a
 * long-running terminal binary (`wezterm start …`) was SIGKILLed at the 4 s
 * cap, closing the window the owner had just seen open. These tests run REAL
 * stub executables through the REAL spawner: nothing here opens a terminal.
 */

let root: string;
let scriptDir: string;
const started: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(path: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    if (Date.now() > deadline) throw new Error("stub never started");
    await sleep(20);
  }
}

/** Writes an executable stub terminal with the given body. */
function stub(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function launcher(template: readonly string[], capMs = 400, detachGraceMs = 100) {
  return createCustomTemplateLauncher({
    spawner: createCommandSpawner(createExecFileCommandRunner()),
    scriptDir,
    template,
    capMs,
    detachGraceMs,
    isExecutable: isExecutableFile,
  });
}

function input(signal: AbortSignal = new AbortController().signal) {
  return { cwd: root, argv: ["/usr/bin/true"], signal };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-detached-")));
  scriptDir = ensureScriptDir(join(root, "runtime"));
});

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe("a directly-run terminal binary is handed off, never killed by the cap", () => {
  it("keeps running past the cap and the abort, and the launch reports handed-off", async () => {
    const pidFile = join(root, "pid");
    const envFile = join(root, "env");
    const terminal = stub(
      "long-running-terminal",
      `/usr/bin/env > '${envFile}'\necho $$ > '${pidFile}'\nexec /bin/sleep 30`,
    );
    const controller = new AbortController();
    const result = await launcher([terminal, "{script}"]).launch(input(controller.signal));
    expect(result).toEqual({ ok: true });

    await waitFor(pidFile);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    started.push(pid);
    // The pipeline's cap fires and then passes; the terminal lives on.
    controller.abort();
    await sleep(700);
    expect(alive(pid)).toBe(true);
    // The hand-off may still need the script: it is left for the script itself.
    expect(readdirSync(scriptDir)).toHaveLength(1);
    // The child's environment is the spawner's fixed allowlist, not the service's.
    const env = readFileSync(envFile, "utf8");
    expect(env).toContain("PATH=/usr/bin:/bin");
    expect(env).not.toContain("VITEST");
  });

  it("an executable that fails at once is spawn-failed and its script is removed", async () => {
    const terminal = stub("failing-terminal", "exit 3");
    // A generous grace, so a slow /bin/sh start on a loaded machine still exits inside it.
    await expect(launcher([terminal, "{script}"], 4000, 2000).launch(input())).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("an executable removed after the X_OK check is spawn-failed and its script is removed", async () => {
    const terminal = stub("vanishing-terminal", "exec /bin/sleep 30");
    const launch = createCustomTemplateLauncher({
      spawner: createCommandSpawner(createExecFileCommandRunner()),
      scriptDir,
      template: [terminal, "{script}"],
      detachGraceMs: 100,
      isExecutable: async (path) => {
        const ok = await isExecutableFile(path);
        rmSync(path);
        return ok;
      },
    });
    await expect(launch.launch(input())).resolves.toEqual({ ok: false, error: "spawn-failed" });
    expect(readdirSync(scriptDir)).toEqual([]);
  });
});
