// The owner-run Claude hook package (plan 05-09, SESS-01, D-13). Every test
// runs the real scripts under `scripts/claude-hooks/` as child processes with
// HOME, CLAUDE_CONFIG_DIR and CCC_RUNTIME_DIR all pointed at a throwaway
// directory under `~/.ccc-test/`, AND passes explicit `--claude-config-dir`
// and `--runtime-dir` flags. No test ever reads or writes the owner's real
// Claude config: installing there is the owner's step in 05-17 (T-05-34).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KNOWN_HOOK_EVENTS } from "@ccc/domain";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts", "claude-hooks");
const INSTALL = join(SCRIPTS_DIR, "install.mjs");
const INSTALL_SH = join(SCRIPTS_DIR, "install.sh");
const UNINSTALL = join(SCRIPTS_DIR, "uninstall.mjs");
const UNINSTALL_SH = join(SCRIPTS_DIR, "uninstall.sh");
const STATUS = join(SCRIPTS_DIR, "status.mjs");
const STATUS_SH = join(SCRIPTS_DIR, "status.sh");
const LIB = join(SCRIPTS_DIR, "lib.mjs");
const TEST_BASE = join(homedir(), ".ccc-test");

/** The foreign content every fixture starts with; none of it may change. */
const FOREIGN_PRE_TOOL_USE = {
  matcher: "Bash",
  hooks: [{ type: "command", command: "echo pre-tool-use" }],
};
const FOREIGN_SESSION_START = {
  hooks: [{ type: "command", command: "echo session-start" }],
};
const FOREIGN_STATUS_LINE = { type: "command", command: "echo hi", padding: 1 };

interface Fixture {
  root: string;
  home: string;
  configDir: string;
  settingsPath: string;
  runtimeDir: string;
  claudeBin: string;
  originalBytes: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const fixtures: string[] = [];

/** Writes an executable fake `claude` that prints `version` the way the real one does. */
function writeFakeClaude(dir: string, name: string, version: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function fixtureSettings(): Record<string, unknown> {
  return {
    model: "opus",
    hooks: {
      PreToolUse: [FOREIGN_PRE_TOOL_USE],
      SessionStart: [FOREIGN_SESSION_START],
    },
    statusLine: FOREIGN_STATUS_LINE,
  };
}

function makeFixture(settings: Record<string, unknown> | string = fixtureSettings()): Fixture {
  mkdirSync(TEST_BASE, { recursive: true });
  const root = mkdtempSync(join(TEST_BASE, "hooks-"));
  fixtures.push(root);
  const home = join(root, "home");
  const configDir = join(home, "claude");
  const runtimeDir = join(home, "runtime");
  mkdirSync(configDir, { recursive: true });
  const settingsPath = join(configDir, "settings.json");
  // Deliberately NOT the installer's own serialization (4-space indent), so
  // "byte-equal after uninstall" proves a restore, not a re-serialization.
  const originalBytes =
    typeof settings === "string" ? settings : `${JSON.stringify(settings, null, 4)}\n`;
  writeFileSync(settingsPath, originalBytes);
  const claudeBin = writeFakeClaude(root, "claude", "2.1.283");
  return { root, home, configDir, settingsPath, runtimeDir, claudeBin, originalBytes };
}

/** Owner-safety net: every path handed to a script must sit inside this test's temp root. */
function assertContained(fx: Fixture, ...paths: string[]): void {
  for (const path of paths) {
    expect(path.startsWith(`${fx.root}/`), `${path} escapes the fixture`).toBe(true);
  }
}

function childEnv(fx: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fx.home,
    CLAUDE_CONFIG_DIR: fx.configDir,
    CCC_RUNTIME_DIR: fx.runtimeDir,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
}

function baseArgs(fx: Fixture, claudeBin = fx.claudeBin): string[] {
  assertContained(fx, fx.configDir, fx.runtimeDir, claudeBin);
  return [
    "--claude-config-dir",
    fx.configDir,
    "--runtime-dir",
    fx.runtimeDir,
    "--claude-bin",
    claudeBin,
  ];
}

function runScript(script: string, fx: Fixture, args: string[]): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    env: childEnv(fx),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function install(fx: Fixture, extra: string[] = [], claudeBin?: string): RunResult {
  return runScript(INSTALL, fx, [...baseArgs(fx, claudeBin), ...extra]);
}

function readSettings(fx: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(fx.settingsPath, "utf8")) as Record<string, unknown>;
}

function entryPath(fx: Fixture): string {
  return join(fx.runtimeDir, "hooks", "hook", "entry.js");
}

function expectedHandler(fx: Fixture): Record<string, unknown> {
  return {
    type: "command",
    command: process.execPath,
    args: [entryPath(fx), "--runtime-dir", fx.runtimeDir],
    async: true,
    timeout: 5,
  };
}

type Group = { matcher?: string; hooks?: Array<Record<string, unknown>> };

function groupsOf(settings: Record<string, unknown>, event: string): Group[] {
  const hooks = settings.hooks as Record<string, Group[]> | undefined;
  return hooks?.[event] ?? [];
}

function ourGroups(fx: Fixture, settings: Record<string, unknown>, event: string): Group[] {
  return groupsOf(settings, event).filter((group) =>
    (group.hooks ?? []).some(
      (handler) =>
        Array.isArray(handler.args) &&
        typeof handler.args[0] === "string" &&
        handler.args[0].startsWith(`${fx.runtimeDir}/hooks/`),
    ),
  );
}

function backups(fx: Fixture): string[] {
  return readdirSync(fx.configDir).filter((name) => name.startsWith("settings.json.ccc-backup-"));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeAll(() => {
  for (const dist of [
    join(REPO_ROOT, "packages", "collectors", "dist", "hook", "entry.js"),
    join(REPO_ROOT, "packages", "vault-repo", "dist", "index.js"),
  ]) {
    if (!existsSync(dist)) {
      execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@ccc/collectors"], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
      break;
    }
  }
});

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("install.mjs merges the hook package (Task 1, SESS-01, D-13)", () => {
  it("adds exactly one exec-form group per subscribed event and leaves foreign content alone (Test 1)", () => {
    const fx = makeFixture();
    const before = readSettings(fx);
    const result = install(fx);
    expect(result.status, result.stderr).toBe(0);

    const after = readSettings(fx);
    for (const event of KNOWN_HOOK_EVENTS) {
      const ours = ourGroups(fx, after, event);
      expect(ours, event).toHaveLength(1);
      expect(ours[0]).toEqual({ hooks: [expectedHandler(fx)] });
    }
    expect(groupsOf(after, "PreToolUse")).toEqual([FOREIGN_PRE_TOOL_USE]);
    expect(groupsOf(after, "SessionStart")[0]).toEqual(FOREIGN_SESSION_START);
    expect(groupsOf(after, "SessionStart")).toHaveLength(2);
    expect(after.statusLine).toEqual(before.statusLine);
    expect(after.model).toBe("opus");
    expect(Object.keys(after)).toEqual(["model", "hooks", "statusLine"]);
  });

  it("copies the compiled hook (never tests) into a 0700 dir and records install.json 0600 (Test 2)", () => {
    const fx = makeFixture();
    const result = install(fx);
    expect(result.status, result.stderr).toBe(0);

    const hookDir = join(fx.runtimeDir, "hooks", "hook");
    const files = readdirSync(hookDir);
    for (const name of ["entry.js", "minimize.js", "deliver.js", "limits.js"]) {
      expect(files, name).toContain(name);
    }
    expect(files.filter((name) => name.endsWith(".test.js"))).toEqual([]);
    expect(mode(hookDir)).toBe(0o700);
    expect(mode(join(fx.runtimeDir, "hooks"))).toBe(0o700);
    expect(existsSync(join(fx.runtimeDir, "hooks", "statusline", "wrapper.js"))).toBe(true);

    const installJson = join(fx.runtimeDir, "hooks", "install.json");
    expect(mode(installJson)).toBe(0o600);
    const record = JSON.parse(readFileSync(installJson, "utf8")) as Record<string, unknown>;
    expect(record.nodePath).toBe(process.execPath);
    expect(record.claudeBin).toBe(fx.claudeBin);
    expect(record.claudeVersion).toBe("2.1.283");
    expect(record.withStatusline).toBe(false);
    expect(typeof record.installedAt).toBe("string");
  });

  it("the installed copy runs from its own location: silent, exit 0, record spooled", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    const payload = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "11111111-1111-4111-8111-111111111111",
      source: "startup",
      cwd: fx.root,
      model: "claude",
    });
    const handler = expectedHandler(fx) as { command: string; args: string[] };
    const run = spawnSync(handler.command, handler.args, {
      input: payload,
      env: childEnv(fx),
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    const spooled = readFileSync(join(fx.runtimeDir, "spool", "hooks.ndjson"), "utf8");
    expect(spooled).toContain('"hook_event_name":"SessionStart"');
  });

  it("is idempotent: a re-install yields byte-identical settings (Test 3)", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    const first = readFileSync(fx.settingsPath, "utf8");
    const again = install(fx);
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(first);
    const after = readSettings(fx);
    for (const event of KNOWN_HOOK_EVENTS) expect(ourGroups(fx, after, event)).toHaveLength(1);
  });

  it("refuses invalid JSON and writes nothing at all (Test 4)", () => {
    const broken = '{ "model": "opus", ';
    const fx = makeFixture(broken);
    const result = install(fx);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(broken);
    expect(backups(fx)).toEqual([]);
    expect(existsSync(join(fx.runtimeDir, "hooks"))).toBe(false);
  });

  it("--dry-run prints a diff and writes nothing (Test 5)", () => {
    const fx = makeFixture();
    const result = install(fx, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^\+.*"UserPromptSubmit"/m);
    expect(result.stdout).toMatch(/^\+.*entry\.js/m);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
    expect(existsSync(join(fx.runtimeDir, "hooks"))).toBe(false);
    expect(backups(fx)).toEqual([]);
  });

  it("writes a timestamped backup holding the pre-install bytes (Test 6)", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    const names = backups(fx);
    expect(names).toHaveLength(1);
    const backup = join(fx.configDir, names[0] as string);
    expect(readFileSync(backup, "utf8")).toBe(fx.originalBytes);
    expect(mode(backup)).toBe(0o600);
  });

  it("refuses a Claude Code older than 2.1.214 before writing; a missing claude only warns (Test 7)", () => {
    const fx = makeFixture();
    const old = writeFakeClaude(fx.root, "claude-old", "2.1.100");
    const refused = install(fx, [], old);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/older than the minimum supported 2\.1\.214/);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
    expect(existsSync(join(fx.runtimeDir, "hooks"))).toBe(false);

    const missing = install(fx, [], join(fx.root, "no-such-claude"));
    expect(missing.status, missing.stderr).toBe(0);
    expect(missing.stderr).toMatch(/version unknown/);
    const record = JSON.parse(
      readFileSync(join(fx.runtimeDir, "hooks", "install.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record.claudeVersion).toBeNull();
  });

  it("install.sh is a thin shim over install.mjs (Test 8)", () => {
    const fx = makeFixture();
    const viaNode = install(fx, ["--dry-run"]);
    const viaSh = spawnSync("sh", [INSTALL_SH, "--dry-run", ...baseArgs(fx)], {
      cwd: REPO_ROOT,
      env: childEnv(fx),
      encoding: "utf8",
    });
    expect(viaSh.status, viaSh.stderr).toBe(0);
    expect(viaSh.stdout).toBe(viaNode.stdout);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
    expect(existsSync(join(fx.runtimeDir, "hooks"))).toBe(false);
  });

  it("subscribes exactly the domain's KNOWN_HOOK_EVENTS (Test 9)", async () => {
    const lib = (await import(pathToFileURL(LIB).href)) as { SUBSCRIBED_EVENTS: readonly string[] };
    expect([...lib.SUBSCRIBED_EVENTS]).toEqual([...KNOWN_HOOK_EVENTS]);
  });
});

/** POSIX single-quoting, as the installer must use for the status-line command (T-05-36). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function wrapperCommand(fx: Fixture): string {
  const wrapper = join(fx.runtimeDir, "hooks", "statusline", "wrapper.js");
  return `${shellQuote(process.execPath)} ${shellQuote(wrapper)} --runtime-dir ${shellQuote(fx.runtimeDir)}`;
}

function uninstall(fx: Fixture): RunResult {
  return runScript(UNINSTALL, fx, [
    "--claude-config-dir",
    fx.configDir,
    "--runtime-dir",
    fx.runtimeDir,
  ]);
}

function status(fx: Fixture): RunResult {
  return runScript(STATUS, fx, baseArgs(fx));
}

/** Every file under `dir`, relative, sorted: proves a read-only command wrote nothing. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

describe("uninstall.mjs, the status-line wrap and status.mjs (Task 2, D-02, D-13)", () => {
  it("uninstall after install restores the exact original bytes and removes the copies (Test 1)", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    expect(install(fx).status).toBe(0);
    const result = uninstall(fx);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
    expect(existsSync(join(fx.runtimeDir, "hooks"))).toBe(false);
  });

  it("--with-statusline saves the exact prior status line (0600) and wraps it; uninstall restores it (Test 2)", () => {
    const fx = makeFixture();
    const result = install(fx, ["--with-statusline"]);
    expect(result.status, result.stderr).toBe(0);

    const originalFile = join(fx.runtimeDir, "statusline", "original.json");
    expect(mode(originalFile)).toBe(0o600);
    expect(mode(join(fx.runtimeDir, "statusline"))).toBe(0o700);
    expect(mode(fx.runtimeDir)).toBe(0o700);
    expect(JSON.parse(readFileSync(originalFile, "utf8"))).toEqual({
      statusLine: FOREIGN_STATUS_LINE,
      command: "echo hi",
    });
    const after = readSettings(fx);
    expect(after.statusLine).toEqual({ ...FOREIGN_STATUS_LINE, command: wrapperCommand(fx) });
    expect(Object.keys(after.statusLine as object)).toEqual(["type", "command", "padding"]);
    const record = JSON.parse(
      readFileSync(join(fx.runtimeDir, "hooks", "install.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record.withStatusline).toBe(true);

    // The wrapped command still prints the owner's status line.
    const shown = spawnSync("/bin/sh", ["-c", wrapperCommand(fx)], {
      input: "{}",
      env: childEnv(fx),
      encoding: "utf8",
    });
    expect(shown.status).toBe(0);
    expect(shown.stdout).toBe("hi\n");

    // A re-install never records the wrapper itself as the original (wave 2 hand-off).
    const wrappedBytes = readFileSync(fx.settingsPath, "utf8");
    expect(install(fx, ["--with-statusline"]).status).toBe(0);
    expect(JSON.parse(readFileSync(originalFile, "utf8")).command).toBe("echo hi");
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(wrappedBytes);

    const removed = uninstall(fx);
    expect(removed.status, removed.stderr).toBe(0);
    expect(readSettings(fx).statusLine).toEqual(FOREIGN_STATUS_LINE);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
    expect(existsSync(originalFile)).toBe(false);
  });

  it("--with-statusline with no status line configured refuses and writes nothing (Test 3, Pitfall 11)", () => {
    const { statusLine: _none, ...withoutStatusLine } = fixtureSettings();
    const fx = makeFixture(withoutStatusLine);
    const result = install(fx, ["--with-statusline"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no status line/);
    expect(result.stderr).toMatch(/footer/);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
    expect(backups(fx)).toEqual([]);
    expect(existsSync(join(fx.runtimeDir, "hooks"))).toBe(false);
    expect(existsSync(join(fx.runtimeDir, "statusline"))).toBe(false);
  });

  it("a user edit made after install survives uninstall; only our groups go (Test 4)", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    const edited = readSettings(fx);
    const userStop = { hooks: [{ type: "command", command: "echo user-stop" }] };
    (edited.hooks as Record<string, Group[]>).Stop?.push(userStop);
    writeFileSync(fx.settingsPath, `${JSON.stringify(edited, null, 2)}\n`);

    const result = uninstall(fx);
    expect(result.status, result.stderr).toBe(0);
    const expected = {
      model: "opus",
      hooks: {
        PreToolUse: [FOREIGN_PRE_TOOL_USE],
        SessionStart: [FOREIGN_SESSION_START],
        Stop: [userStop],
      },
      statusLine: FOREIGN_STATUS_LINE,
    };
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("status reports the install, the build match, Claude, disableAllHooks, the wrapper and the spool (Test 5)", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    const settingsBefore = readFileSync(fx.settingsPath, "utf8");
    const runtimeBefore = tree(fx.runtimeDir);

    const report = status(fx);
    expect(report.status, report.stderr).toBe(0);
    for (const line of [
      "hooks: installed (15 events)",
      "node: present",
      "installed files: match build",
      "claude: 2.1.283 (supported)",
      "disableAllHooks: false",
      "status-line wrapper: not installed",
      "spool: 0 bytes pending, 0 dropped",
    ]) {
      expect(report.stdout).toContain(line);
    }
    // Read-only: nothing changed on disk.
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(settingsBefore);
    expect(tree(fx.runtimeDir)).toEqual(runtimeBefore);

    // A copy that no longer matches the build, and dropped spool records, are both reported.
    writeFileSync(join(fx.runtimeDir, "hooks", "hook", "limits.js"), "// edited\n");
    mkdirSync(join(fx.runtimeDir, "spool"), { recursive: true });
    writeFileSync(join(fx.runtimeDir, "spool", "hooks.dropped"), "xxx");
    const stale = status(fx);
    expect(stale.stdout).toContain("installed files: stale — re-run install");
    expect(stale.stdout).toContain("spool: 0 bytes pending, 3 dropped");

    expect(uninstall(fx).status).toBe(0);
    const after = status(fx);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toContain("hooks: not installed");
  });

  it("status reports node: missing when the recorded node path is gone (Test 6, Pitfall 13)", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    const gone = join(fx.root, "old-node", "bin", "node");
    const text = readFileSync(fx.settingsPath, "utf8").replaceAll(
      JSON.stringify(process.execPath),
      JSON.stringify(gone),
    );
    writeFileSync(fx.settingsPath, text);
    const report = status(fx);
    expect(report.status, report.stderr).toBe(0);
    expect(report.stdout).toContain("node: missing");
    expect(report.stdout).toContain("hooks: installed (15 events)");
  });

  it("uninstall.sh and status.sh are thin shims", () => {
    const fx = makeFixture();
    expect(install(fx).status).toBe(0);
    const shStatus = spawnSync("sh", [STATUS_SH, ...baseArgs(fx)], {
      cwd: REPO_ROOT,
      env: childEnv(fx),
      encoding: "utf8",
    });
    expect(shStatus.status, shStatus.stderr).toBe(0);
    expect(shStatus.stdout).toContain("hooks: installed (15 events)");
    const shUninstall = spawnSync(
      "sh",
      [UNINSTALL_SH, "--claude-config-dir", fx.configDir, "--runtime-dir", fx.runtimeDir],
      { cwd: REPO_ROOT, env: childEnv(fx), encoding: "utf8" },
    );
    expect(shUninstall.status, shUninstall.stderr).toBe(0);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
  });
});

describe("installer write safety (wave 3 review)", () => {
  it("refuses to overwrite a settings edit made while it was probing Claude Code", () => {
    const fx = makeFixture();
    const concurrent = `${JSON.stringify({ model: "sonnet", edited: true }, null, 2)}\n`;
    // A `claude` whose --version run edits settings.json: the read-modify-write
    // window the installer spans while it probes the version.
    const racer = join(fx.root, "claude-racer");
    writeFileSync(
      racer,
      `#!/bin/sh\nprintf '%s' '${concurrent}' > '${fx.settingsPath}'\necho "2.1.283 (Claude Code)"\n`,
    );
    chmodSync(racer, 0o755);
    const result = install(fx, [], racer);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/changed while the installer was running/);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(concurrent);
    expect(backups(fx)).toEqual([]);
  });

  it("never chmods an existing directory it did not create: a shared --runtime-dir is refused", () => {
    const fx = makeFixture();
    const shared = join(fx.root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    assertContained(fx, shared);
    const result = runScript(INSTALL, fx, [
      "--claude-config-dir",
      fx.configDir,
      "--runtime-dir",
      shared,
      "--claude-bin",
      fx.claudeBin,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/only tightens directories it creates/);
    expect(mode(shared)).toBe(0o755);
    expect(readdirSync(shared)).toEqual([]);
    expect(readFileSync(fx.settingsPath, "utf8")).toBe(fx.originalBytes);
  });

  it("still installs into a private runtime dir that already exists", () => {
    const fx = makeFixture();
    mkdirSync(fx.runtimeDir, { mode: 0o700 });
    chmodSync(fx.runtimeDir, 0o700);
    const result = install(fx);
    expect(result.status, result.stderr).toBe(0);
    expect(mode(fx.runtimeDir)).toBe(0o700);
  });
});
