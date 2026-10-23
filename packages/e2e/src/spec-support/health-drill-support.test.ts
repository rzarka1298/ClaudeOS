import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realClaudeConfigDir, realRuntimeDir, realStorePath } from "../isolation-guards.js";
import { REPO_ROOT } from "../repo-paths.js";
import { createRunRoot, pathsForRoot, type RunRootPaths } from "../run-root.js";
import { SQLITE_TOOL } from "../store-copy.js";
import {
  ageFileInRunRoot,
  DRILL_TIMEOUT_MS,
  type DrillRunner,
  hookInstallerArgv,
  makeDirInRunRoot,
  makeSecondVault,
  readTextInRunRoot,
  refuseOwnerLocations,
  removeEmptyDirInRunRoot,
  removeFileInRunRoot,
  removeLauncherRow,
  renameInRunRoot,
  replaceFileInRunRoot,
  runFixedArgv,
  runHookInstaller,
  seedLauncherRow,
  withMode,
  writeFakeExecutable,
  writeSpoolDrops,
} from "./health-drill-support.js";

/**
 * Plan 08-05 Task 3 (D-09, research Pitfall 7, T-08-11, T-08-11b): the drill helpers create their
 * break conditions inside a temporary run root only. Every test here uses a run root made by
 * `createRunRoot` under a temporary folder and a fake home folder; nothing touches the owner's
 * runtime folder, store, Claude config, vaults, Codex folders or Keychain.
 */

let scratch: string;
let home: string;
let base: string;
let outside: string;
let paths: RunRootPaths;
const deps = () => ({ home, base });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ccc-e2e-drill."));
  home = join(scratch, "home");
  base = join(scratch, "base");
  outside = join(scratch, "outside");
  for (const dir of [home, base, outside]) mkdirSync(dir, { recursive: true });
  paths = createRunRoot({ base, home });
});

afterEach(() => {
  // A test that failed mid-way must not leave a mode-000 folder behind.
  try {
    for (const dir of [join(paths.root, "locked"), paths.vaultsDir]) {
      if (existsSync(dir)) chmodSync(dir, 0o700);
    }
  } catch {
    // Best effort; the removal below reports anything left.
  }
  rmSync(scratch, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("withMode (Test 1)", () => {
  it("applies the mode while fn runs and restores the original mode afterwards", async () => {
    const target = join(paths.root, "locked");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    let seen = -1;
    const value = await withMode(
      paths,
      target,
      0o000,
      () => {
        seen = mode(target);
        return 42;
      },
      deps(),
    );
    expect(seen).toBe(0o000);
    expect(value).toBe(42);
    expect(mode(target)).toBe(0o755);
  });

  it("restores the original mode even when fn throws, and rethrows the same error", async () => {
    const target = join(paths.root, "locked");
    mkdirSync(target, { mode: 0o750 });
    chmodSync(target, 0o750);
    const boom = new Error("boom");
    await expect(
      withMode(
        paths,
        target,
        0o000,
        async () => {
          expect(mode(target)).toBe(0o000);
          throw boom;
        },
        deps(),
      ),
    ).rejects.toBe(boom);
    expect(mode(target)).toBe(0o750);
  });

  it("refuses a path outside the run root before any chmod and never calls fn", async () => {
    chmodSync(outside, 0o755);
    let called = false;
    await expect(
      withMode(
        paths,
        outside,
        0o000,
        () => {
          called = true;
        },
        deps(),
      ),
    ).rejects.toThrow(/outside the run root/);
    expect(called).toBe(false);
    expect(mode(outside)).toBe(0o755);
    // A sibling that merely shares the root's name as a prefix is outside as well.
    const sibling = `${paths.root}-sibling`;
    mkdirSync(sibling, { mode: 0o755 });
    await expect(withMode(paths, sibling, 0o000, () => 1, deps())).rejects.toThrow(
      /outside the run root/,
    );
    expect(mode(sibling)).toBe(0o755);
  });

  it("refuses the run root itself, a relative path, a NUL path and a missing target", async () => {
    for (const bad of [paths.root, "locked", `${paths.root}/x\0y`, join(paths.root, "nope")]) {
      await expect(withMode(paths, bad, 0o000, () => 1, deps())).rejects.toThrow();
    }
    expect(mode(paths.root)).toBe(0o700);
  });

  it("refuses a symlink inside the run root that points at a folder outside it", async () => {
    chmodSync(outside, 0o755);
    const link = join(paths.root, "link");
    symlinkSync(outside, link);
    await expect(withMode(paths, link, 0o000, () => 1, deps())).rejects.toThrow(/symbolic link/);
    // A child below a symlinked parent is refused as well.
    await expect(withMode(paths, join(link, "child"), 0o000, () => 1, deps())).rejects.toThrow();
    expect(mode(outside)).toBe(0o755);
  });

  it("does not chmod through a link swapped in while fn ran", async () => {
    chmodSync(outside, 0o755);
    const target = join(paths.root, "locked");
    writeFileSync(target, "x", { mode: 0o644 });
    await expect(
      withMode(
        paths,
        target,
        0o000,
        () => {
          rmSync(target);
          symlinkSync(outside, target);
        },
        deps(),
      ),
    ).rejects.toThrow(/symbolic link/);
    expect(mode(outside)).toBe(0o755);
  });

  it("refuses a mode that is not plain permission bits", async () => {
    const target = join(paths.root, "locked");
    mkdirSync(target, { mode: 0o700 });
    for (const bad of [-1, 0o1000, 1.5, Number.NaN]) {
      await expect(withMode(paths, target, bad, () => 1, deps())).rejects.toThrow(/mode/i);
    }
    expect(mode(target)).toBe(0o700);
  });

  it("refuses run-root paths that do not match the run root's own layout", async () => {
    const forged = { ...paths, vaultsDir: join(outside, "vaults") };
    mkdirSync(forged.vaultsDir);
    await expect(withMode(forged, forged.vaultsDir, 0o000, () => 1, deps())).rejects.toThrow();
    expect(() => makeSecondVault(forged, "second", deps())).toThrow();
    const notARunRoot = { ...paths, root: outside };
    await expect(
      withMode(notARunRoot, join(outside, "x"), 0o000, () => 1, deps()),
    ).rejects.toThrow();
  });
});

describe("withMode keeps the original error and refuses a second hold (B-MINOR 2)", () => {
  it("rethrows the original error when the restore also fails, with the restore error attached", async () => {
    chmodSync(outside, 0o755);
    const target = join(paths.root, "locked");
    writeFileSync(target, "x", { mode: 0o644 });
    const boom = new Error("boom");
    const caught = await withMode(
      paths,
      target,
      0o000,
      () => {
        // The restore step will find a link here and refuse; the caller must still see "boom".
        rmSync(target);
        symlinkSync(outside, target);
        throw boom;
      },
      deps(),
    ).catch((error: unknown) => error);
    expect(caught).toBe(boom);
    expect((caught as { restoreError?: Error }).restoreError?.message).toMatch(/symbolic link/);
    expect(mode(outside)).toBe(0o755);
  });

  it("refuses a target that another withMode still holds, by any spelling, then frees it", async () => {
    const target = join(paths.root, "locked");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    let inner: unknown;
    await withMode(
      paths,
      target,
      0o700,
      async () => {
        inner = await withMode(paths, join(target, "..", "locked"), 0o000, () => 1, deps()).catch(
          (error: unknown) => error,
        );
      },
      deps(),
    );
    expect((inner as Error).message).toMatch(/already/);
    expect(mode(target)).toBe(0o755);
    // Released after a normal finish and after a throw, so the same target can be used again.
    await expect(withMode(paths, target, 0o700, () => 1, deps())).resolves.toBe(1);
    await expect(
      withMode(
        paths,
        target,
        0o700,
        () => {
          throw new Error("x");
        },
        deps(),
      ),
    ).rejects.toThrow("x");
    await expect(withMode(paths, target, 0o700, () => 2, deps())).resolves.toBe(2);
  });
});

describe("writes never follow or share a link (B-MINOR 3)", () => {
  it("writes a fake executable as a new file, leaving a hard-linked outside file untouched", () => {
    const victim = join(outside, "victim.sh");
    writeFileSync(victim, "keep", { mode: 0o644 });
    mkdirSync(join(paths.root, "fake-bin"), { mode: 0o700 });
    linkSync(victim, join(paths.root, "fake-bin", "claude"));
    const file = writeFakeExecutable(paths, "claude", { versionLine: "9.9.9" }, deps());
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(mode(victim)).toBe(0o644);
    expect(readFileSync(file, "utf8")).toContain("9.9.9");
    expect(mode(file)).toBe(0o700);
  });

  it("refuses to append to a spool file that has a second hard link", () => {
    const victim = join(outside, "victim.dropped");
    writeFileSync(victim, "keep", { mode: 0o644 });
    mkdirSync(join(paths.runtimeDir, "spool"), { mode: 0o700 });
    linkSync(victim, join(paths.runtimeDir, "spool", "hooks.dropped"));
    expect(() => writeSpoolDrops(paths, 3, deps())).toThrow(/link/);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(mode(victim)).toBe(0o644);
  });

  it("opens every written file without following a final link", () => {
    const source = readFileSync(new URL("./health-drill-support.ts", import.meta.url), "utf8");
    expect(source).toMatch(/O_NOFOLLOW/);
    expect(source).toMatch(/O_EXCL/);
    expect(source).toMatch(/fchmodSync/);
    expect(source).not.toMatch(/\bwriteFileSync\b|\bappendFileSync\b/);
  });
});

describe("the run root guard (B-MINOR 4)", () => {
  it("is pinned to the real base: a run root under another base is refused unless a test names it", () => {
    expect(() => makeSecondVault(paths, "second", { home })).toThrow(/run root/);
    expect(() => makeSecondVault(paths, "second", { home, base })).not.toThrow();
  });

  it("requires the run root to exist, belong to the current user and be mode 700", () => {
    chmodSync(paths.root, 0o750);
    expect(() => makeSecondVault(paths, "second", deps())).toThrow(/private|mode/i);
    chmodSync(paths.root, 0o700);
    expect(() => makeSecondVault(paths, "second", deps())).not.toThrow();
    const gone = pathsForRoot(join(base, "ccc-uat.zzzzzz"), paths.runId);
    expect(() => makeSecondVault(gone, "second", deps())).toThrow(/run root/);
  });
});

describe("the owner-location check is load-bearing in the guard (test weakness)", () => {
  // A fake home placed INSIDE the run root passes every other check: the root is not below the
  // home, and the targets are strictly inside the root with no link on the way. Only the
  // owner-location refusal can stop a drill from touching it.
  it("refuses a target in an owner folder that sits inside the run root, naming the owner category", async () => {
    const fakeHome = join(paths.root, "home");
    mkdirSync(realRuntimeDir(fakeHome), { recursive: true });
    mkdirSync(realClaudeConfigDir(fakeHome), { recursive: true });
    for (const target of [realRuntimeDir(fakeHome), realClaudeConfigDir(fakeHome), fakeHome]) {
      await expect(
        withMode(paths, target, 0o700, () => 1, { home: fakeHome, base }),
        target.slice(paths.root.length),
      ).rejects.toThrow(/owner's real folders/);
    }
    expect(mode(realClaudeConfigDir(fakeHome))).not.toBe(0o000);
    // The same target is fine once it is not the owner's.
    await expect(
      withMode(paths, realClaudeConfigDir(fakeHome), 0o700, () => 1, {
        home: join(scratch, "other"),
        base,
      }),
    ).resolves.toBe(1);
  });

  it("refuses a hook installer binary in such an owner folder", () => {
    const fakeHome = join(paths.root, "home");
    mkdirSync(join(realClaudeConfigDir(fakeHome), "bin"), { recursive: true });
    expect(() =>
      hookInstallerArgv(
        paths,
        { claudeBin: join(realClaudeConfigDir(fakeHome), "bin", "claude") },
        { home: fakeHome, base },
      ),
    ).toThrow(/owner's real folders/);
  });

  it("matches the owner's folders whatever the letter case", () => {
    expect(() =>
      refuseOwnerLocations(join(home, ".CLAUDE-COMMAND-CENTER", "operational.db"), home),
    ).toThrow(/owner's/);
    expect(() => refuseOwnerLocations(join(home, ".Claude", "settings.json"), home)).toThrow(
      /owner's/,
    );
  });
});

describe("makeSecondVault and writeFakeExecutable (Test 2)", () => {
  it("creates a vault folder with an .obsidian marker under the run root's vaults folder", () => {
    const vault = makeSecondVault(paths, "second", deps());
    expect(vault).toBe(join(paths.vaultsDir, "second"));
    expect(statSync(join(vault, ".obsidian")).isDirectory()).toBe(true);
    expect(mode(vault)).toBe(0o700);
    expect(makeSecondVault(paths, undefined, deps())).toBe(vault);
    expect(readdirSync(paths.vaultsDir)).toEqual(["second"]);
  });

  it("refuses names that could collide with the primary vaults or leave the vaults folder", () => {
    for (const name of ["live", "big", "", "../x", "a/b", ".", "..", "UP", "x".repeat(40)]) {
      expect(() => makeSecondVault(paths, name, deps()), `name ${JSON.stringify(name)}`).toThrow();
    }
    expect(readdirSync(paths.vaultsDir)).toEqual([]);
  });

  it("refuses to create a vault below a vaults folder that was replaced by a symlink", () => {
    rmSync(paths.vaultsDir, { recursive: true });
    symlinkSync(outside, paths.vaultsDir);
    expect(() => makeSecondVault(paths, "second", deps())).toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("writes a fake claude as a mode-700 script that prints only the given version line", () => {
    const file = writeFakeExecutable(
      paths,
      "claude",
      { versionLine: "1.0.3 (Claude Code)" },
      deps(),
    );
    expect(file).toBe(join(paths.root, "fake-bin", "claude"));
    expect(mode(file)).toBe(0o700);
    expect(execFileSync(file, ["--version"], { encoding: "utf8" })).toBe("1.0.3 (Claude Code)\n");
    expect(execFileSync(file, ["anything", "else"], { encoding: "utf8" })).toBe(
      "1.0.3 (Claude Code)\n",
    );
  });

  it("writes a fake codex into the sandbox candidates folder the service reads", () => {
    const file = writeFakeExecutable(paths, "codex", { versionLine: "codex-cli 0.1.0" }, deps());
    expect(file).toBe(join(paths.codexCandidatesDir, "codex"));
    expect(mode(file)).toBe(0o700);
    expect(execFileSync(file, [], { encoding: "utf8" })).toBe("codex-cli 0.1.0\n");
  });

  it("refuses a version line that could carry shell syntax, and a symlinked target", () => {
    for (const line of ["", "a'b", 'a"b', "a\nb", "$(id)", "`id`", "a;b", "x".repeat(200)]) {
      expect(() => writeFakeExecutable(paths, "claude", { versionLine: line }, deps())).toThrow();
    }
    mkdirSync(join(paths.root, "fake-bin"), { mode: 0o700 });
    symlinkSync(join(outside, "target"), join(paths.root, "fake-bin", "claude"));
    expect(() =>
      writeFakeExecutable(paths, "claude", { versionLine: "1.0.0 (Claude Code)" }, deps()),
    ).toThrow(/symbolic link/);
    expect(existsSync(join(outside, "target"))).toBe(false);
    expect(() =>
      writeFakeExecutable(paths, "other" as never, { versionLine: "1.0.0" }, deps()),
    ).toThrow();
  });
});

describe("writeSpoolDrops (Test 3)", () => {
  it("appends one byte per dropped record to the sandbox spool's dropped file only", () => {
    const file = writeSpoolDrops(paths, 3, deps());
    expect(file).toBe(join(paths.runtimeDir, "spool", "hooks.dropped"));
    expect(statSync(file).size).toBe(3);
    writeSpoolDrops(paths, 2, deps());
    expect(readFileSync(file, "utf8")).toBe("xxxxx");
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(join(paths.runtimeDir, "spool"))).toEqual(["hooks.dropped"]);
  });

  it("refuses counts that are not a small positive integer, and a symlinked spool folder", () => {
    for (const bad of [0, -1, 1.5, 70_000, Number.NaN]) {
      expect(() => writeSpoolDrops(paths, bad, deps()), `bytes ${bad}`).toThrow();
    }
    symlinkSync(outside, join(paths.runtimeDir, "spool"));
    expect(() => writeSpoolDrops(paths, 1, deps())).toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("runHookInstaller (Test 4)", () => {
  it("builds the argv of the repository installer with scratch config and runtime folders", () => {
    const argv = hookInstallerArgv(paths, undefined, deps());
    const installer = join(REPO_ROOT, "scripts", "claude-hooks", "install.mjs");
    expect(existsSync(installer)).toBe(true);
    expect(argv.file).toBe(process.execPath);
    expect(argv.args).toEqual([
      installer,
      "--claude-config-dir",
      paths.claudeConfigDir,
      "--runtime-dir",
      paths.runtimeDir,
      "--claude-bin",
      join(paths.root, "fake-bin", "claude"),
    ]);
    // A minimal environment: no inherited HOME, no secrets, and the two isolation variables.
    expect(argv.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: paths.tmpDir,
      CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
      CCC_RUNTIME_DIR: paths.runtimeDir,
    });
  });

  it("accepts a fake claude inside the run root and refuses one outside it", () => {
    const fake = writeFakeExecutable(
      paths,
      "claude",
      { versionLine: "1.0.3 (Claude Code)" },
      deps(),
    );
    expect(hookInstallerArgv(paths, { claudeBin: fake }, deps()).args.slice(-2)).toEqual([
      "--claude-bin",
      fake,
    ]);
    expect(() => hookInstallerArgv(paths, { claudeBin: join(outside, "claude") }, deps())).toThrow(
      /outside the run root/,
    );
    expect(() => hookInstallerArgv(paths, { claudeBin: "claude" }, deps())).toThrow();
  });

  it("refuses to run when the config or runtime folder resolves to a real folder", async () => {
    const calls: unknown[] = [];
    const run: DrillRunner = async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };
    // The owner's real folders, as the fake home sees them, reached through a link in the root.
    const realClaude = realClaudeConfigDir(home);
    const realRuntime = realRuntimeDir(home);
    mkdirSync(realClaude);
    mkdirSync(realRuntime);
    rmSync(paths.claudeConfigDir, { recursive: true });
    symlinkSync(realClaude, paths.claudeConfigDir);
    await expect(runHookInstaller(paths, undefined, { home, base, run })).rejects.toThrow();
    rmSync(paths.claudeConfigDir);
    mkdirSync(paths.claudeConfigDir, { mode: 0o700 });
    rmSync(paths.runtimeDir, { recursive: true });
    symlinkSync(realRuntime, paths.runtimeDir);
    await expect(runHookInstaller(paths, undefined, { home, base, run })).rejects.toThrow();
    // Paths that name the real folders directly are not the run root's own layout.
    await expect(
      runHookInstaller({ ...paths, claudeConfigDir: realClaude }, undefined, { home, base, run }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(readdirSync(realClaude)).toEqual([]);
    expect(readdirSync(realRuntime)).toEqual([]);
  });

  it("runs the installer once with fixed argv and the 30 second cap, and reports failure plainly", async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const ok: DrillRunner = async (file, args, options) => {
      calls.push({ file, args, timeoutMs: options.timeoutMs });
      return { stdout: "", stderr: "" };
    };
    await runHookInstaller(paths, undefined, { home, base, run: ok });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(DRILL_TIMEOUT_MS);
    expect(calls[0]?.timeoutMs).toBe(30_000);
    expect(calls[0]?.args).toEqual(hookInstallerArgv(paths, undefined, deps()).args);
    const failing: DrillRunner = async () => {
      throw new Error("exit 1");
    };
    await expect(runHookInstaller(paths, undefined, { home, base, run: failing })).rejects.toThrow(
      /hook installer/i,
    );
  });
});

describe("seedLauncherRow (Test 5)", () => {
  const hasSqlite = existsSync("/usr/bin/sqlite3");
  const SEED_ANTIGRAVITY =
    "INSERT OR REPLACE INTO launcher_config (launcher_id, config_json, tested, updated_at) VALUES ('antigravity', '{\"bundleId\":\"com.example.not-installed\"}', 'false', '2000-01-01T00:00:00.000Z');";

  function capture(): {
    calls: Array<{
      file: string;
      args: readonly string[];
      timeoutMs: number;
      env: Record<string, string>;
    }>;
    run: DrillRunner;
  } {
    const calls: Array<{
      file: string;
      args: readonly string[];
      timeoutMs: number;
      env: Record<string, string>;
    }> = [];
    return {
      calls,
      run: async (file, args, options) => {
        calls.push({ file, args, timeoutMs: options.timeoutMs, env: options.env });
        return { stdout: "", stderr: "" };
      },
    };
  }

  function makeStore(): void {
    execFileSync(SQLITE_TOOL, [
      paths.dbPath,
      "create table launcher_config (launcher_id text primary key, config_json text not null, tested text not null default 'false', updated_at text not null);",
    ]);
  }

  const stopped = { isRunning: () => false };
  const input = {
    launcher: "antigravity",
    bundleId: "com.example.not-installed",
    fixtureState: "stopped",
  } as const;

  it("runs one fixed statement through the sqlite3 tool with an argv array and a 30 second cap", async () => {
    writeFileSync(paths.dbPath, "", { mode: 0o600 });
    const { calls, run } = capture();
    await seedLauncherRow(paths, input, { ...deps(), run, fixture: stopped });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(SQLITE_TOOL);
    expect(calls[0]?.args).toEqual(["-bail", paths.dbPath, SEED_ANTIGRAVITY]);
    expect(calls[0]?.timeoutMs).toBe(30_000);
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(["LC_ALL", "PATH"]);
    await seedLauncherRow(
      paths,
      { ...input, launcher: "claude-desktop" },
      { ...deps(), run, fixture: stopped },
    );
    expect(calls[1]?.args[2]).toBe(SEED_ANTIGRAVITY.replace("'antigravity'", "'claude-desktop'"));
  });

  it("refuses unless the target is exactly the run root's store and the fixture is stopped", async () => {
    writeFileSync(paths.dbPath, "", { mode: 0o600 });
    const { calls, run } = capture();
    await expect(
      seedLauncherRow(paths, { ...input, fixtureState: "running" } as never, {
        home,
        base,
        run,
        fixture: stopped,
      }),
    ).rejects.toThrow(/stopped/);
    await expect(
      seedLauncherRow(paths, { launcher: input.launcher, bundleId: input.bundleId } as never, {
        home,
        base,
        run,
        fixture: stopped,
      }),
    ).rejects.toThrow(/stopped/);
    // No fixture handle at all: the caller cannot show the service is down, so it is refused (B-MINOR 5).
    await expect(
      // @ts-expect-error the fixture handle is a required dependency
      seedLauncherRow(paths, input, { home, base, run }),
    ).rejects.toThrow(/stopped/);
    await expect(
      seedLauncherRow(paths, input, { home, base, run, fixture: { isRunning: () => true } }),
    ).rejects.toThrow(/stopped/);
    // A db path that is not the run root's own store.
    const other = join(paths.root, "tmp", "other.db");
    writeFileSync(other, "");
    await expect(
      seedLauncherRow({ ...paths, dbPath: other }, input, { home, base, run, fixture: stopped }),
    ).rejects.toThrow();
    await expect(
      seedLauncherRow({ ...paths, dbPath: join(outside, "operational.db") }, input, {
        home,
        base,
        run,
        fixture: stopped,
      }),
    ).rejects.toThrow();
    // No store yet: sqlite3 would create an empty one, so the helper refuses instead.
    rmSync(paths.dbPath);
    await expect(
      seedLauncherRow(paths, input, { home, base, run, fixture: stopped }),
    ).rejects.toThrow(/store/i);
    // A store that is a symlink to a file outside the root.
    const elsewhere = join(outside, "operational.db");
    writeFileSync(elsewhere, "");
    symlinkSync(elsewhere, paths.dbPath);
    await expect(
      seedLauncherRow(paths, input, { home, base, run, fixture: stopped }),
    ).rejects.toThrow(/symbolic link/);
    expect(calls).toEqual([]);
  });

  it("checks the bundle id against the bundle id pattern and the launcher against the two app launchers", async () => {
    writeFileSync(paths.dbPath, "", { mode: 0o600 });
    const { calls, run } = capture();
    for (const bundleId of [
      "",
      "a b",
      "a'b",
      "a;b",
      'a"b',
      "a--'); drop table x; --",
      "com.example/x",
      "é",
      "a".repeat(256),
      "a\nb",
    ]) {
      await expect(
        seedLauncherRow(paths, { ...input, bundleId }, { home, base, run, fixture: stopped }),
        JSON.stringify(bundleId),
      ).rejects.toThrow();
    }
    for (const launcher of ["claude-code", "codex", "terminal", "", "x'y"]) {
      await expect(
        seedLauncherRow(paths, { ...input, launcher } as never, {
          home,
          base,
          run,
          fixture: stopped,
        }),
      ).rejects.toThrow();
    }
    expect(calls).toEqual([]);
    await seedLauncherRow(
      paths,
      { ...input, bundleId: "A".repeat(255) },
      { home, base, run, fixture: stopped },
    );
    expect(calls).toHaveLength(1);
  });

  it.runIf(hasSqlite)(
    "writes the row into a real sandbox store copy and replaces it on a second seed",
    async () => {
      makeStore();
      await seedLauncherRow(paths, input, { ...deps(), fixture: stopped });
      await seedLauncherRow(
        paths,
        { ...input, bundleId: "com.example.also-missing" },
        { ...deps(), fixture: stopped },
      );
      const rows = JSON.parse(
        execFileSync(
          SQLITE_TOOL,
          ["-readonly", "-json", paths.dbPath, "select * from launcher_config;"],
          { encoding: "utf8" },
        ),
      ) as Array<Record<string, string>>;
      expect(rows).toEqual([
        {
          launcher_id: "antigravity",
          config_json: '{"bundleId":"com.example.also-missing"}',
          tested: "false",
          updated_at: "2000-01-01T00:00:00.000Z",
        },
      ]);
    },
  );
});

describe("removeLauncherRow (FIX6A M2)", () => {
  const hasSqlite = existsSync("/usr/bin/sqlite3");
  const DELETE_ANTIGRAVITY = "DELETE FROM launcher_config WHERE launcher_id = 'antigravity';";
  const stopped = { isRunning: () => false };
  const input = { launcher: "antigravity", fixtureState: "stopped" } as const;

  function makeStore(): void {
    execFileSync(SQLITE_TOOL, [
      paths.dbPath,
      "create table launcher_config (launcher_id text primary key, config_json text not null, tested text not null default 'false', updated_at text not null);",
    ]);
  }

  it("runs one fixed DELETE through the sqlite3 tool with an argv array", async () => {
    writeFileSync(paths.dbPath, "", { mode: 0o600 });
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const run: DrillRunner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };
    await removeLauncherRow(paths, input, { ...deps(), run, fixture: stopped });
    expect(calls).toEqual([
      { file: SQLITE_TOOL, args: ["-bail", paths.dbPath, DELETE_ANTIGRAVITY] },
    ]);
  });

  it("refuses unless the fixture is stopped, the launcher is an app launcher and the store is the run root's own", async () => {
    writeFileSync(paths.dbPath, "", { mode: 0o600 });
    const calls: unknown[] = [];
    const run: DrillRunner = async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };
    await expect(
      removeLauncherRow(paths, input, { home, base, run, fixture: { isRunning: () => true } }),
    ).rejects.toThrow(/stopped/);
    await expect(
      removeLauncherRow(paths, { launcher: "antigravity" } as never, {
        home,
        base,
        run,
        fixture: stopped,
      }),
    ).rejects.toThrow(/stopped/);
    for (const launcher of ["claude-code", "codex", "", "x'y"]) {
      await expect(
        removeLauncherRow(paths, { ...input, launcher } as never, {
          home,
          base,
          run,
          fixture: stopped,
        }),
      ).rejects.toThrow();
    }
    rmSync(paths.dbPath);
    await expect(
      removeLauncherRow(paths, input, { home, base, run, fixture: stopped }),
    ).rejects.toThrow(/store/i);
    expect(calls).toEqual([]);
  });

  it.runIf(hasSqlite)(
    "removes the seeded row from a real sandbox store copy and leaves other rows",
    async () => {
      makeStore();
      await seedLauncherRow(
        paths,
        { launcher: "antigravity", bundleId: "com.example.not-installed", fixtureState: "stopped" },
        { ...deps(), fixture: stopped },
      );
      await seedLauncherRow(
        paths,
        { launcher: "claude-desktop", bundleId: "com.example.other", fixtureState: "stopped" },
        { ...deps(), fixture: stopped },
      );
      await removeLauncherRow(paths, input, { ...deps(), fixture: stopped });
      const rows = JSON.parse(
        execFileSync(
          SQLITE_TOOL,
          ["-readonly", "-json", paths.dbPath, "select launcher_id from launcher_config;"],
          { encoding: "utf8" },
        ),
      ) as Array<Record<string, string>>;
      expect(rows).toEqual([{ launcher_id: "claude-desktop" }]);
    },
  );
});

describe("runFixedArgv (T-08-11b)", () => {
  it("passes arguments literally (no shell) and only the given environment", async () => {
    const { stdout } = await runFixedArgv(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify([process.argv[1], Object.keys(process.env)]))",
        "$(echo hi); `id` | cat",
      ],
      { env: { ONLY: "1" }, timeoutMs: 5_000 },
    );
    const [arg, keys] = JSON.parse(stdout) as [string, string[]];
    expect(arg).toBe("$(echo hi); `id` | cat");
    // macOS itself may add a locale variable to a child; nothing of the runner's own comes along.
    expect(keys).toContain("ONLY");
    for (const inherited of ["HOME", "PATH", "USER", "TMPDIR", "CCC_RUNTIME_DIR"]) {
      expect(keys).not.toContain(inherited);
    }
  });

  it("kills a child that outlives the cap and rejects without waiting for it", async () => {
    const started = Date.now();
    await expect(
      runFixedArgv(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: {},
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("rejects with a plain message for a non-zero exit", async () => {
    await expect(
      runFixedArgv(process.execPath, ["-e", "process.exit(3)"], { env: {}, timeoutMs: 5_000 }),
    ).rejects.toThrow(/exited/i);
  });
});

describe("refuseOwnerLocations", () => {
  it("refuses the owner's runtime folder, store, Claude config, vaults, Codex folders and home", () => {
    for (const target of [
      realRuntimeDir(home),
      realStorePath(home),
      join(realClaudeConfigDir(home), "settings.json"),
      join(home, "Obsidian", "Main", "note.md"),
      join(home, ".codex", "config.toml"),
      join(home, "Documents"),
    ]) {
      expect(() => refuseOwnerLocations(target, home), target.slice(home.length)).toThrow(
        /owner's/,
      );
    }
    expect(() => refuseOwnerLocations(home, home)).toThrow(/owner's/);
    expect(() =>
      refuseOwnerLocations(join(realClaudeConfigDir(homedir()), "settings.json")),
    ).toThrow(/owner's/);
    expect(() => refuseOwnerLocations(join(paths.root, "tmp", "x"), home)).not.toThrow();
  });

  it("refuses a path that reaches the owner's folders through a symlink", () => {
    mkdirSync(realClaudeConfigDir(home));
    const link = join(scratch, "link-to-claude");
    symlinkSync(realClaudeConfigDir(home), link);
    expect(() => refuseOwnerLocations(join(link, "settings.json"), home)).toThrow(/owner's/);
  });
});

describe("source discipline", () => {
  const source = readFileSync(new URL("./health-drill-support.ts", import.meta.url), "utf8");

  it("imports no database binding, uses no shell and no blanket git or tree operation", () => {
    expect(source).not.toMatch(/better-sqlite3|node:sqlite|drizzle/);
    // The patterns are assembled from parts so this file holds no literal shell option.
    expect(source).not.toMatch(new RegExp(["shell", ":\\s*true"].join("")));
    expect(source).toMatch(new RegExp(["shell", ":\\s*false"].join("")));
    expect(source).not.toMatch(/\bexecSync\b|\bspawnSync\b|\bexec\(/);
    expect(source).not.toMatch(/git (clean|stash|reset)/);
    expect(source).not.toMatch(/rmSync\([^)]*recursive/);
  });
});

describe("scratch file and folder operations (plan 08-20)", () => {
  const settings = (): string => join(paths.claudeConfigDir, "settings.json");

  it("replaces a plain file with new text, mode 0600, and creates it when missing", () => {
    mkdirSync(paths.claudeConfigDir, { recursive: true });
    replaceFileInRunRoot(paths, settings(), '{"a":1}', deps());
    expect(readFileSync(settings(), "utf8")).toBe('{"a":1}');
    expect(mode(settings())).toBe(0o600);
    replaceFileInRunRoot(paths, settings(), "{}", deps());
    expect(readTextInRunRoot(paths, settings(), deps())).toBe("{}");
    expect(readdirSync(paths.claudeConfigDir)).toEqual(["settings.json"]);
  });

  it("refuses a folder at the target, a missing parent, a symlink and a path outside the run root", () => {
    mkdirSync(paths.claudeConfigDir, { recursive: true });
    mkdirSync(settings());
    expect(() => replaceFileInRunRoot(paths, settings(), "x", deps())).toThrow(/plain file/);
    expect(() =>
      replaceFileInRunRoot(paths, join(paths.root, "no-such", "x.json"), "x", deps()),
    ).toThrow();
    const link = join(paths.root, "linked");
    symlinkSync(outside, link);
    expect(() => replaceFileInRunRoot(paths, join(link, "x.json"), "x", deps())).toThrow(
      /symbolic link/,
    );
    expect(() => replaceFileInRunRoot(paths, join(outside, "x.json"), "x", deps())).toThrow(
      /outside the run root/,
    );
    expect(() => replaceFileInRunRoot(paths, join(home, "x.json"), "x", deps())).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("removes a plain file and reports whether it was there; a folder is refused", () => {
    mkdirSync(paths.claudeConfigDir, { recursive: true });
    replaceFileInRunRoot(paths, settings(), "{}", deps());
    expect(removeFileInRunRoot(paths, settings(), deps())).toBe(true);
    expect(removeFileInRunRoot(paths, settings(), deps())).toBe(false);
    mkdirSync(join(paths.root, "folder"));
    expect(() => removeFileInRunRoot(paths, join(paths.root, "folder"), deps())).toThrow(
      /plain file/,
    );
  });

  it("sets a file's times back by the given age, on a sandbox file only", () => {
    const file = writeSpoolDrops(paths, 2, deps());
    const day = 24 * 60 * 60 * 1000;
    ageFileInRunRoot(paths, file, 25 * 60 * 60 * 1000, deps());
    const age = Date.now() - statSync(file).mtimeMs;
    expect(age).toBeGreaterThan(25 * 60 * 60 * 1000 - 60_000);
    expect(age).toBeLessThan(26 * 60 * 60 * 1000);
    for (const bad of [-1, 1.5, 31 * day, Number.NaN]) {
      expect(() => ageFileInRunRoot(paths, file, bad, deps()), `age ${bad}`).toThrow();
    }
    const real = join(outside, "real.txt");
    writeFileSync(real, "x");
    expect(() => ageFileInRunRoot(paths, real, 1000, deps())).toThrow(/outside the run root/);
    const link = join(paths.root, "link.txt");
    symlinkSync(real, link);
    expect(() => ageFileInRunRoot(paths, link, 1000, deps())).toThrow(/symbolic link/);
    expect(Date.now() - statSync(real).mtimeMs).toBeLessThan(60_000);
  });

  it("makes and removes an empty folder; a folder with content or a file is refused", () => {
    const folder = join(paths.root, "dir-as-settings");
    expect(makeDirInRunRoot(paths, folder, deps())).toBe(folder);
    expect(mode(folder)).toBe(0o700);
    writeFileSync(join(folder, "x"), "x");
    expect(() => removeEmptyDirInRunRoot(paths, folder, deps())).toThrow();
    rmSync(join(folder, "x"));
    expect(removeEmptyDirInRunRoot(paths, folder, deps())).toBe(true);
    expect(removeEmptyDirInRunRoot(paths, folder, deps())).toBe(false);
    writeFileSync(join(paths.root, "file"), "x");
    expect(() => removeEmptyDirInRunRoot(paths, join(paths.root, "file"), deps())).toThrow(
      /plain folder/,
    );
  });

  it("moves a folder to a name that is free and refuses an existing name or an outside path", () => {
    const vault = makeSecondVault(paths, "second", deps());
    const away = join(paths.vaultsDir, "second-away");
    renameInRunRoot(paths, vault, away, deps());
    expect(existsSync(vault)).toBe(false);
    expect(existsSync(join(away, ".obsidian"))).toBe(true);
    renameInRunRoot(paths, away, vault, deps());
    expect(existsSync(vault)).toBe(true);
    mkdirSync(away);
    expect(() => renameInRunRoot(paths, vault, away, deps())).toThrow(/already exists/);
    expect(() => renameInRunRoot(paths, vault, join(outside, "moved"), deps())).toThrow(
      /outside the run root/,
    );
    expect(existsSync(vault)).toBe(true);
  });

  it("reads only a plain text file of a sensible size inside the run root", () => {
    const big = join(paths.root, "big.txt");
    writeFileSync(big, "x".repeat(2 * 1024 * 1024));
    expect(() => readTextInRunRoot(paths, big, deps())).toThrow(/plain file/);
    expect(() => readTextInRunRoot(paths, join(outside, "x"), deps())).toThrow(/outside/);
    expect(() => readTextInRunRoot(paths, join(paths.root, "folder-none"), deps())).toThrow();
  });
});
