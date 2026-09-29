import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import { ensureScriptDir, SCRIPT_MAX_AGE_MS } from "./script-dir.js";
import { createTerminalAppLauncher } from "./terminal-launchers.js";

// Audit (04-09 Task 1): the per-launch stale sweep and the startup sweep
// wiring were only unit-tested on sweepStaleScripts itself.

let runtimeDir: string;
let scriptDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "ccc-tl-audit-"));
  scriptDir = ensureScriptDir(runtimeDir);
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function plant(name: string, ageMs: number): void {
  const path = join(scriptDir, name);
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o700 });
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

describe("audit: each Terminal.app launch sweeps stale scripts (D-20, Pitfall 5)", () => {
  it("deletes a leftover older than 10 minutes, keeps a recent one, and writes its own 0700 script", async () => {
    plant("old.command", SCRIPT_MAX_AGE_MS + 60_000);
    plant("recent.command", 30_000);
    const spawner = createFakeSpawner();
    const launcher = createTerminalAppLauncher({ spawner, scriptDir });
    await expect(
      launcher.launch({
        cwd: "/Users/USERNAME/code/example",
        argv: ["/usr/local/bin/claude"],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ ok: true });

    const handed = spawner.calls[0]?.argv[3] ?? "";
    const names = readdirSync(scriptDir).sort();
    expect(names).not.toContain("old.command");
    expect(names).toContain("recent.command");
    expect(names).toContain(basename(handed));
    expect(names).toHaveLength(2);
    expect(statSync(handed).mode & 0o777).toBe(0o700);
    expect(statSync(scriptDir).mode & 0o777).toBe(0o700);
  });
});

describe("audit: service startup removes leftover scripts before listening (D-20)", () => {
  it("main.ts ensures the script dir and sweeps with the short startup threshold before the socket server starts", () => {
    const src = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
    const ensure = src.indexOf("ensureScriptDir(runtimeDir");
    // Never `{ all: true }` at startup: a KeepAlive restart can follow a
    // hand-off within seconds, and Terminal may not have read that script.
    expect(src).not.toContain("sweepStaleScripts(scriptDir, { all: true })");
    const sweep = src.indexOf(
      "sweepStaleScripts(scriptDir, { olderThanMs: STARTUP_SCRIPT_MIN_AGE_MS })",
    );
    const listen = src.indexOf("startSocketServer(");
    expect(ensure).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(ensure);
    expect(listen).toBeGreaterThan(sweep);
  });
});
