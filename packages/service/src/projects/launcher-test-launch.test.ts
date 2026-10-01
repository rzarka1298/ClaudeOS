import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_TEST_AUTOMATION_CAP_MS,
  type LaunchResult,
  SYSTEM_SETTINGS_OPEN_PATH,
} from "@ccc/domain";
import { TERMINAL_PRESETS } from "@ccc/launchers";
import {
  applyMigrations,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import { type LauncherHarness, startLauncherHarness } from "../test-support/launcher-harness.js";
import { VAULT_ROOT_META_KEY } from "./approved-roots.js";
import { LAUNCH_CAP_MS } from "./launch-service.js";
import { SYSTEM_SETTINGS_URLS, type TestLaunchDeps, testLaunch } from "./launcher-test-launch.js";
import { ensureScriptDir } from "./script-dir.js";

/**
 * The Test step (D-28, RR-14, RR-15): one real launch of the SAVED
 * configuration through the same argv builders and terminal adapters a real
 * launch uses. Every spawn lands in a fake spawner; nothing opens.
 */

const TEST_BASE = join(homedir(), ".ccc-test");

let dir: string;
let store: OperationalStore;
let spawner: FakeSpawner;
let scriptDir: string;
let homeDir: string;
let vaultRoot: string;
let claude: string;

function deps(overrides: Partial<TestLaunchDeps> = {}): TestLaunchDeps {
  return { store, spawner, scriptDir, homeDir, ...overrides };
}

function saveClaudeCode(terminal: unknown, args: readonly string[] = []): void {
  saveLauncherConfig(store.db, "claude-code", { executablePath: claude, args, terminal });
}

const ITERM2 = TERMINAL_PRESETS.find((preset) => preset.id === "iterm2");
if (ITERM2 === undefined) throw new Error("the iTerm2 preset is missing");
const ITERM2_TERMINAL = { kind: "custom", preset: "iterm2", argv: [...ITERM2.argv] };

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = realpathSync.native(mkdtempSync(join(TEST_BASE, "tl-")));
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  spawner = createFakeSpawner();
  const runtimeDir = join(dir, "rt");
  mkdirSync(runtimeDir, { mode: 0o700 });
  scriptDir = ensureScriptDir(runtimeDir);
  homeDir = join(dir, "home");
  mkdirSync(homeDir);
  vaultRoot = join(dir, "vault");
  mkdirSync(vaultRoot);
  claude = join(dir, "bin", "claude");
  mkdirSync(join(dir, "bin"));
  writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  chmodSync(claude, 0o755);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("what each Test launches (RR-15)", () => {
  it("Antigravity: opens the saved bundle with no project", async () => {
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.google.antigravity-ide" });
    expect(await testLaunch("antigravity", deps())).toEqual({ ok: true });
    expect(spawner.calls.map((call) => call.argv)).toEqual([
      ["/usr/bin/open", "-b", "com.google.antigravity-ide"],
    ]);
  });

  it("Claude Desktop: brings the saved bundle to the front", async () => {
    saveLauncherConfig(store.db, "claude-desktop", { bundleId: "com.anthropic.claudefordesktop" });
    expect(await testLaunch("claude-desktop", deps())).toEqual({ ok: true });
    expect(spawner.calls.map((call) => call.argv)).toEqual([
      ["/usr/bin/open", "-b", "com.anthropic.claudefordesktop"],
    ]);
  });

  it("Finder: reveals the managed vault folder", async () => {
    store.writeServiceMeta(VAULT_ROOT_META_KEY, vaultRoot);
    expect(await testLaunch("finder", deps())).toEqual({ ok: true });
    expect(spawner.calls.map((call) => call.argv)).toEqual([["/usr/bin/open", "-R", vaultRoot]]);
  });

  it("Finder: reveals the owner's home when no vault is set up", async () => {
    expect(await testLaunch("finder", deps())).toEqual({ ok: true });
    expect(spawner.calls.map((call) => call.argv)).toEqual([["/usr/bin/open", "-R", homeDir]]);
  });

  it("GitHub: opens https://github.com", async () => {
    expect(await testLaunch("github", deps())).toEqual({ ok: true });
    expect(spawner.calls.map((call) => call.argv)).toEqual([
      ["/usr/bin/open", "https://github.com"],
    ]);
  });

  it("Claude Code in Terminal: a script at the vault running `claude --version`, then the login shell", async () => {
    store.writeServiceMeta(VAULT_ROOT_META_KEY, vaultRoot);
    saveClaudeCode({ kind: "terminal-app" }, ["--model", "opus", "{projectPath}"]);

    expect(await testLaunch("claude-code", deps())).toEqual({ ok: true });

    expect(spawner.calls).toHaveLength(1);
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/open", "-b", "com.apple.Terminal"]);
    const script = readFileSync(argv[3] ?? "", "utf8");
    const lines = script.split("\n");
    expect(lines).toContain(`'${claude}' '--version'`);
    expect(script).toContain(`cd -- '${vaultRoot}' ||`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text the script must contain.
    expect(lines).toContain('exec "${SHELL:-/bin/zsh}" -l');
    // The stored arguments are a launch's, not the Test's.
    expect(script).not.toContain("opus");
  });

  it("Claude Code in Terminal: the owner's home when no vault is set up", async () => {
    saveClaudeCode({ kind: "terminal-app" });
    expect(await testLaunch("claude-code", deps())).toEqual({ ok: true });
    const script = readFileSync(spawner.calls[0]?.argv[3] ?? "", "utf8");
    expect(script).toContain(`cd -- '${homeDir}' ||`);
  });

  it("Claude Code in a custom terminal: the saved template with the script", async () => {
    store.writeServiceMeta(VAULT_ROOT_META_KEY, vaultRoot);
    const wezterm = TERMINAL_PRESETS.find((preset) => preset.id === "wezterm");
    saveClaudeCode({ kind: "custom", preset: "wezterm", argv: [...(wezterm?.argv ?? [])] });
    expect(await testLaunch("claude-code", deps())).toEqual({ ok: true });
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv.slice(0, 7)).toEqual([
      "/usr/bin/open",
      "-na",
      "WezTerm",
      "--args",
      "start",
      "--cwd",
      vaultRoot,
    ]);
    expect(argv[8]?.startsWith(scriptDir)).toBe(true);
  });

  for (const launcherId of ["antigravity", "claude-desktop", "claude-code"] as const) {
    it(`${launcherId}: an unsaved launcher is launcher-not-configured and spawns nothing`, async () => {
      expect(await testLaunch(launcherId, deps())).toEqual({
        ok: false,
        error: "launcher-not-configured",
      });
      expect(spawner.calls).toHaveLength(0);
    });
  }

  it("a stored Claude Code template that no longer validates is launcher-not-configured", async () => {
    saveClaudeCode({ kind: "terminal-app" }, ["--dangerously-skip-permissions"]);
    expect(await testLaunch("claude-code", deps())).toEqual({
      ok: false,
      error: "launcher-not-configured",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("maps a failed open to its D-26 kind", async () => {
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.example.gone" });
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "bundle-not-found" } };
    expect(await testLaunch("antigravity", deps())).toEqual({ ok: false, error: "app-not-found" });
  });
});

describe("the first Automation prompt (ADR-0024, wave-4b review)", () => {
  /** Shortened caps: the normal cap is 40 ms, the Automation cap 600 ms. */
  const caps = { capMs: 40, automationCapMs: 600 };

  it("waits past the normal cap for an osascript terminal still waiting on the prompt", async () => {
    saveClaudeCode(ITERM2_TERMINAL);
    // osascript sleeps past the normal cap while the owner reads the prompt.
    spawner.mode = { kind: "succeed", delayMs: 200 };

    const result = await testLaunch("claude-code", deps(caps));

    expect(result).toEqual({ ok: true });
    expect(spawner.calls[0]?.argv[0]).toBe("/usr/bin/osascript");
    expect(spawner.calls[0]?.opts.timeoutMs).toBe(600);
    expect(spawner.abortsObserved).toBe(0);
  });

  it("explains an unanswered prompt as automation-denied, never a bare timeout", async () => {
    saveClaudeCode(ITERM2_TERMINAL);
    spawner.mode = { kind: "hang" };

    const started = Date.now();
    const result: LaunchResult = await testLaunch("claude-code", deps(caps));

    expect(result).toEqual({ ok: false, error: "automation-denied" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(spawner.abortsObserved).toBe(1);
  });

  it("keeps the normal cap and a plain timeout for the default Terminal hand-off", async () => {
    saveClaudeCode({ kind: "terminal-app" });
    spawner.mode = { kind: "succeed", delayMs: 200 };
    expect(await testLaunch("claude-code", deps(caps))).toEqual({ ok: false, error: "timeout" });
    expect(spawner.calls[0]?.opts.timeoutMs).toBe(40);
  });

  it("keeps the normal cap for an app launcher", async () => {
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.google.antigravity" });
    spawner.mode = { kind: "hang" };
    expect(await testLaunch("antigravity", deps(caps))).toEqual({ ok: false, error: "timeout" });
  });

  it("uses the domain's Automation cap and the launch cap by default", async () => {
    saveClaudeCode(ITERM2_TERMINAL);
    await testLaunch("claude-code", deps());
    expect(spawner.calls[0]?.opts.timeoutMs).toBe(LAUNCHER_TEST_AUTOMATION_CAP_MS);
    saveLauncherConfig(store.db, "antigravity", { bundleId: "com.google.antigravity" });
    await testLaunch("antigravity", deps());
    expect(spawner.calls[1]?.opts.timeoutMs).toBe(LAUNCH_CAP_MS);
    expect(LAUNCHER_TEST_AUTOMATION_CAP_MS).toBeGreaterThan(LAUNCH_CAP_MS);
  });

  it("still reports a refused Apple Event (-1743) as automation-denied at once", async () => {
    saveClaudeCode(ITERM2_TERMINAL);
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "automation-denied" } };
    expect(await testLaunch("claude-code", deps(caps))).toEqual({
      ok: false,
      error: "automation-denied",
    });
  });
});

describe("the System Settings panes (RR-16, PR-10, T-04-22)", () => {
  let harness: LauncherHarness;

  beforeEach(async () => {
    harness = await startLauncherHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("holds exactly two constant URLs", () => {
    expect(SYSTEM_SETTINGS_URLS).toEqual({
      automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      "privacy-security": "x-apple.systempreferences:com.apple.preference.security",
    });
  });

  it("opens the Automation pane by enum", async () => {
    const reply = await harness.post(SYSTEM_SETTINGS_OPEN_PATH, { pane: "automation" });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(harness.spawner.calls.map((call) => call.argv)).toEqual([
      [
        "/usr/bin/open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      ],
    ]);
  });

  it("opens the Privacy & Security pane by enum", async () => {
    const reply = await harness.post(SYSTEM_SETTINGS_OPEN_PATH, { pane: "privacy-security" });
    expect(reply.status).toBe(200);
    expect(harness.spawner.calls.map((call) => call.argv)).toEqual([
      ["/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security"],
    ]);
  });

  for (const body of [
    { pane: "files-and-folders" },
    { pane: "automation", url: "x-apple.systempreferences:com.apple.preference.general" },
    { url: "https://example.com" },
    {},
  ]) {
    it(`answers 400 and spawns nothing for ${JSON.stringify(body)}`, async () => {
      const reply = await harness.post(SYSTEM_SETTINGS_OPEN_PATH, body);
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: "invalid request body" });
      expect(harness.spawner.calls).toHaveLength(0);
    });
  }

  it("rejects an unauthenticated request with 401 and spawns nothing", async () => {
    const reply = await harness.post(
      SYSTEM_SETTINGS_OPEN_PATH,
      { pane: "automation" },
      { token: null },
    );
    expect(reply.status).toBe(401);
    expect(harness.spawner.calls).toHaveLength(0);
  });
});
