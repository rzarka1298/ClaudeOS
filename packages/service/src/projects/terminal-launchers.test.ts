import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TerminalLaunchInput } from "@ccc/domain";
import { createRunIdMinter, TERMINAL_PRESETS } from "@ccc/launchers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coveringWindows, readBridgeStatus } from "../codex/bridge-state.js";
import { createBridgeFixture } from "../test-support/bridge-fixtures.js";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import {
  ANTIGRAVITY_IDE_BUNDLE_ID,
  type AntigravityTerminalDeps,
  defaultAgentChecks,
} from "./antigravity-terminal.js";
import { ensureScriptDir } from "./script-dir.js";
import {
  createCustomTemplateLauncher,
  createTerminalAppLauncher,
  isExecutableFile,
  selectTerminalLauncher,
} from "./terminal-launchers.js";

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
  it("answers null for { kind: antigravity-terminal } until its adapter is registered (D-07)", () => {
    const spawner = createFakeSpawner();
    expect(
      selectTerminalLauncher({ kind: "antigravity-terminal" }, { spawner, scriptDir }),
    ).toBeNull();
  });

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

// ---------------------------------------------------------------------------
// Task 3: the Custom terminal adapter (D-22, D-23, PR-07)
// ---------------------------------------------------------------------------

const WEZTERM = TERMINAL_PRESETS.find((preset) => preset.id === "wezterm")?.argv ?? [];
const ITERM2 = TERMINAL_PRESETS.find((preset) => preset.id === "iterm2")?.argv ?? [];

function customLauncher(
  spawner: ReturnType<typeof createFakeSpawner>,
  template: readonly string[],
  isExecutable: (path: string) => Promise<boolean> = () => Promise.resolve(true),
) {
  return createCustomTemplateLauncher({ spawner, scriptDir, template, isExecutable });
}

function expectNoPlaceholders(argv: readonly unknown[]): void {
  for (const element of argv) {
    expect(typeof element).toBe("string");
    expect(element as string).not.toContain("{script}");
    expect(element as string).not.toContain("{projectPath}");
  }
}

describe("the Custom terminal adapter (D-22, D-23)", () => {
  it("renders the WezTerm preset into one argv, each placeholder a whole element", async () => {
    const spawner = createFakeSpawner();
    await expect(customLauncher(spawner, WEZTERM).launch(input())).resolves.toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    const argv = spawner.calls[0]?.argv ?? [];
    expectNoPlaceholders(argv);
    const [script] = readdirSync(scriptDir);
    const scriptPath = join(scriptDir, script ?? "");
    expect(argv).toEqual([
      "/usr/bin/open",
      "-na",
      "WezTerm",
      "--args",
      "start",
      "--cwd",
      "/Users/USERNAME/code/example project",
      "--",
      scriptPath,
    ]);
    const body = readFileSync(scriptPath, "utf8");
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).toContain("'/usr/local/bin/claude' '--flag'");
  });

  it("passes the pipeline's abort signal and the cap to the spawn", async () => {
    const spawner = createFakeSpawner();
    const controller = new AbortController();
    await createCustomTemplateLauncher({
      spawner,
      scriptDir,
      template: WEZTERM,
      isExecutable: () => Promise.resolve(true),
      capMs: 1234,
    }).launch(input({ signal: controller.signal }));
    expect(spawner.calls[0]?.opts.signal).toBe(controller.signal);
    expect(spawner.calls[0]?.opts.timeoutMs).toBe(1234);
  });

  it("re-checks the executable before every spawn, asking only about argv[0]", async () => {
    const spawner = createFakeSpawner();
    const asked: string[] = [];
    const launcher = customLauncher(spawner, WEZTERM, (path) => {
      asked.push(path);
      return Promise.resolve(true);
    });
    await launcher.launch(input());
    await launcher.launch(input());
    expect(asked).toEqual(["/usr/bin/open", "/usr/bin/open"]);
    expect(spawner.calls).toHaveLength(2);
  });

  it("an executable that no longer passes X_OK is not configured: no spawn, no script", async () => {
    const spawner = createFakeSpawner();
    await expect(
      customLauncher(spawner, WEZTERM, () => Promise.resolve(false)).launch(input()),
    ).resolves.toEqual({ ok: false, error: "launcher-not-configured" });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("refuses an embedded placeholder: no spawn, no script", async () => {
    const spawner = createFakeSpawner();
    const template = [
      "/usr/bin/open",
      "-na",
      "Ghostty",
      "--args",
      "--cwd={projectPath}",
      "{script}",
    ];
    await expect(customLauncher(spawner, template).launch(input())).resolves.toEqual({
      ok: false,
      error: "launcher-not-configured",
    });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("refuses a template without {script}, and a relative executable", async () => {
    const spawner = createFakeSpawner();
    for (const template of [
      ["/usr/bin/open", "-na", "WezTerm"],
      ["open", "-na", "WezTerm", "--args", "-e", "{script}"],
    ]) {
      await expect(customLauncher(spawner, template).launch(input())).resolves.toEqual({
        ok: false,
        error: "launcher-not-configured",
      });
    }
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("refuses every permission-bypass form in the terminal template (D-22)", async () => {
    const spawner = createFakeSpawner();
    const forms = [
      ["--dangerously-skip-permissions"],
      ["--dangerously_skip_permissions"],
      ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=bypassPermissions"],
      ["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}'],
    ];
    for (const form of forms) {
      const template = ["/usr/bin/open", "-na", "WezTerm", "--args", ...form, "-e", "{script}"];
      await expect(customLauncher(spawner, template).launch(input())).resolves.toEqual({
        ok: false,
        error: "launcher-not-configured",
      });
    }
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("maps an osascript preset's -1743 refusal to automation-denied and removes the unsent script", async () => {
    const spawner = createFakeSpawner({
      kind: "fail",
      outcome: { exitCode: 1, stderrClass: "automation-denied" },
    });
    await expect(customLauncher(spawner, ITERM2).launch(input())).resolves.toEqual({
      ok: false,
      error: "automation-denied",
    });
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv[0]).toBe("/usr/bin/osascript");
    expectNoPlaceholders(argv);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("exports the env inside the script and never through the spawn (PR-07, Pitfall 11)", async () => {
    const spawner = createFakeSpawner();
    await customLauncher(spawner, WEZTERM).launch(input({ env: { CCC_RUN_ID: "r1" } }));
    const call = spawner.calls[0];
    const script = call?.argv[call.argv.length - 1] ?? "";
    expect(readFileSync(script, "utf8")).toContain("export CCC_RUN_ID='r1'");
    expect(JSON.stringify(call?.opts ?? {})).not.toContain("CCC_RUN_ID");
    expect(JSON.stringify(call?.opts ?? {})).not.toContain("r1");
  });

  it("an env key outside ^CCC_[A-Z0-9_]+$ is spawn-failed, with no spawn and no script", async () => {
    const spawner = createFakeSpawner();
    const launcher = customLauncher(spawner, WEZTERM);
    for (const key of ["PATH", "ccc_run_id", "CCC_", "CCC_RUN-ID", "DYLD_INSERT_LIBRARIES"]) {
      await expect(launcher.launch(input({ env: { [key]: "x" } }))).resolves.toEqual({
        ok: false,
        error: "spawn-failed",
      });
    }
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("an already-aborted signal opens nothing and leaves no script", async () => {
    const spawner = createFakeSpawner();
    const controller = new AbortController();
    controller.abort();
    await expect(
      customLauncher(spawner, WEZTERM).launch(input({ signal: controller.signal })),
    ).resolves.toEqual({ ok: false, error: "timeout" });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("a cap that fires during the executable check opens nothing and leaves no script", async () => {
    const spawner = createFakeSpawner();
    const controller = new AbortController();
    const launcher = customLauncher(spawner, WEZTERM, () => {
      controller.abort();
      return Promise.resolve(true);
    });
    await expect(launcher.launch(input({ signal: controller.signal }))).resolves.toEqual({
      ok: false,
      error: "timeout",
    });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("leaves a possibly handed-off script for the sweep when the hand-off timed out", async () => {
    const spawner = createFakeSpawner({
      kind: "fail",
      outcome: { exitCode: null, timedOut: true },
    });
    await expect(customLauncher(spawner, WEZTERM).launch(input())).resolves.toEqual({
      ok: false,
      error: "timeout",
    });
    expect(readdirSync(scriptDir)).toHaveLength(1);
  });
});

describe("selectTerminalLauncher picks the custom adapter (PROJ-10, D-23)", () => {
  it("returns the custom adapter for { kind: custom, preset, argv }", async () => {
    const spawner = createFakeSpawner();
    const launcher = selectTerminalLauncher(
      { kind: "custom", preset: "wezterm", argv: [...WEZTERM] },
      { spawner, scriptDir, isExecutable: () => Promise.resolve(true) },
    );
    expect(launcher).not.toBeNull();
    await expect(launcher?.launch(input())).resolves.toEqual({ ok: true });
    expect(spawner.calls[0]?.argv.slice(0, 3)).toEqual(["/usr/bin/open", "-na", "WezTerm"]);
  });

  it("defaults the executable check to the real X_OK test", async () => {
    const spawner = createFakeSpawner();
    const missing = selectTerminalLauncher(
      { kind: "custom", preset: "blank", argv: ["/nonexistent/terminal", "{script}"] },
      { spawner, scriptDir },
    );
    await expect(missing?.launch(input())).resolves.toEqual({
      ok: false,
      error: "launcher-not-configured",
    });
    expect(spawner.calls).toHaveLength(0);
  });
});

describe("isExecutableFile (D-22): a regular file with X_OK, nothing else", () => {
  it("accepts an executable regular file", async () => {
    const file = join(runtimeDir, "terminal");
    writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    await expect(isExecutableFile(file)).resolves.toBe(true);
  });

  it("refuses a directory, even though a directory passes X_OK (search permission)", async () => {
    const dir = join(runtimeDir, "Example.app");
    mkdirSync(dir, { mode: 0o755 });
    await expect(isExecutableFile(dir)).resolves.toBe(false);
  });

  it("refuses a regular file without the execute bit, and a missing path", async () => {
    const file = join(runtimeDir, "not-executable");
    writeFileSync(file, "x", { mode: 0o644 });
    await expect(isExecutableFile(file)).resolves.toBe(false);
    await expect(isExecutableFile(join(runtimeDir, "absent"))).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A template whose argv[0] is the terminal binary itself (wave-4b review):
// spawned detached and never killed by the cap.
// ---------------------------------------------------------------------------

const DIRECT = ["/Applications/Example.app/Contents/MacOS/example", "start", "--", "{script}"];

/** An abort signal that reads as aborted as soon as a script exists in `dir`. */
function abortedOnceWritten(dir: string): AbortSignal {
  const controller = new AbortController();
  return new Proxy(controller.signal, {
    get(target, property) {
      if (property === "aborted") return readdirSync(dir).length > 0;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("the Custom terminal adapter with a directly-run terminal binary", () => {
  it("spawns it detached (not through the awaited run) and reports handed-off while it runs", async () => {
    const spawner = createFakeSpawner();
    await expect(customLauncher(spawner, DIRECT).launch(input())).resolves.toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(0);
    expect(spawner.detached).toHaveLength(1);
    const argv = spawner.detached[0]?.argv ?? [];
    expectNoPlaceholders(argv);
    expect(argv.slice(0, 3)).toEqual(DIRECT.slice(0, 3));
    // The detach call carries no signal and no deadline: nothing can kill it.
    expect(Object.keys(spawner.detached[0]?.opts ?? {})).toEqual(["graceMs"]);
    expect(spawner.detached[0]?.opts.graceMs).toBeLessThan(4000);
    expect(readdirSync(scriptDir)).toHaveLength(1);
  });

  it("an exit 0 within the grace is handed-off and the script is left for itself", async () => {
    const spawner = createFakeSpawner();
    spawner.detachOutcome = { kind: "exited", exitCode: 0 };
    await expect(customLauncher(spawner, DIRECT).launch(input())).resolves.toEqual({ ok: true });
    expect(readdirSync(scriptDir)).toHaveLength(1);
  });

  it("a non-zero exit within the grace is spawn-failed and removes the script", async () => {
    const spawner = createFakeSpawner();
    spawner.detachOutcome = { kind: "exited", exitCode: 3 };
    await expect(customLauncher(spawner, DIRECT).launch(input())).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("a spawn errno (argv[0] removed after the X_OK check) is spawn-failed and removes the script", async () => {
    const spawner = createFakeSpawner();
    spawner.detachOutcome = { kind: "not-started", errno: "ENOENT" };
    await expect(customLauncher(spawner, DIRECT).launch(input())).resolves.toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it("the open/osascript presets stay on the awaited run path", async () => {
    const spawner = createFakeSpawner();
    await customLauncher(spawner, WEZTERM).launch(input());
    await customLauncher(spawner, ITERM2).launch(input());
    expect(spawner.detached).toHaveLength(0);
    expect(spawner.calls.map((call) => call.argv[0])).toEqual([
      "/usr/bin/open",
      "/usr/bin/osascript",
    ]);
  });
});

describe("an abort between the script write and the spawn removes the script", () => {
  it("Terminal.app adapter", async () => {
    const spawner = createFakeSpawner();
    await expect(
      createTerminalAppLauncher({ spawner, scriptDir }).launch(
        input({ signal: abortedOnceWritten(scriptDir) }),
      ),
    ).resolves.toEqual({ ok: false, error: "timeout" });
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });

  it.each([
    ["an open-routed preset", WEZTERM],
    ["a directly-run terminal binary", DIRECT],
  ])("Custom adapter, %s", async (_label, template) => {
    const spawner = createFakeSpawner();
    await expect(
      customLauncher(spawner, template).launch(input({ signal: abortedOnceWritten(scriptDir) })),
    ).resolves.toEqual({ ok: false, error: "timeout" });
    expect(spawner.calls).toHaveLength(0);
    expect(spawner.detached).toHaveLength(0);
    expect(readdirSync(scriptDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Plan 05.1-13: the third case of the exhaustive switch, the Antigravity terminal
// ---------------------------------------------------------------------------

describe("selectTerminalLauncher and the Antigravity terminal (plan 05.1-13, D-07)", () => {
  const antigravityDeps = (
    extra: Partial<AntigravityTerminalDeps> = {},
  ): AntigravityTerminalDeps => ({
    readStatus: () => {
      throw new Error("not used");
    },
    windowsCovering: () => [],
    savedBundleId: () => null,
    savedExecutables: () => ({}),
    spawner: createFakeSpawner(),
    now: () => 0,
    sleep: () => Promise.resolve(),
    mintRunId: () => "20261010T120000000Z",
    isExecutable: () => false,
    realDir: () => null,
    ...extra,
  });

  it("returns an adapter for { kind: antigravity-terminal } when the Antigravity deps are present", () => {
    const spawner = createFakeSpawner();
    const launcher = selectTerminalLauncher(
      { kind: "antigravity-terminal" },
      { spawner, scriptDir, antigravity: antigravityDeps() },
    );
    expect(launcher).not.toBeNull();
    expect(typeof launcher?.launch).toBe("function");
  });

  it("still answers null when the Antigravity deps are absent", () => {
    const spawner = createFakeSpawner();
    expect(
      selectTerminalLauncher({ kind: "antigravity-terminal" }, { spawner, scriptDir }),
    ).toBeNull();
  });

  it("the Terminal.app and custom cases ignore the Antigravity deps", async () => {
    const spawner = createFakeSpawner();
    const antigravity = antigravityDeps();
    const app = selectTerminalLauncher(
      { kind: "terminal-app" },
      { spawner, scriptDir, antigravity },
    );
    await expect(app?.launch(input())).resolves.toEqual({ ok: true });
    expect(spawner.calls[0]?.argv.slice(0, 3)).toEqual([
      "/usr/bin/open",
      "-b",
      "com.apple.Terminal",
    ]);
    const custom = selectTerminalLauncher(
      { kind: "custom", preset: "wezterm", argv: [...WEZTERM] },
      { spawner, scriptDir, antigravity, isExecutable: () => Promise.resolve(true) },
    );
    expect(custom).not.toBeNull();
  });

  it("the pipeline cap reaches the adapter so its deadline stays below it", async () => {
    const fx = createBridgeFixture();
    try {
      fx.installLauncher();
      fx.installMarker();
      const clock = { t: Date.now() };
      const started = clock.t;
      fx.simulator("current", { now: () => clock.t }).heartbeat();
      const spawner = createFakeSpawner();
      const launcher = selectTerminalLauncher(
        { kind: "antigravity-terminal" },
        {
          spawner,
          scriptDir,
          capMs: 1500,
          antigravity: antigravityDeps({
            readStatus: () => readBridgeStatus({ env: {}, home: fx.home, now: clock.t }),
            windowsCovering: (status, root) => coveringWindows(status, root),
            savedBundleId: () => ANTIGRAVITY_IDE_BUNDLE_ID,
            savedExecutables: () => ({ claude: fx.claudePath }),
            spawner,
            now: () => clock.t,
            sleep: (ms) => {
              clock.t += ms;
              return Promise.resolve();
            },
            mintRunId: createRunIdMinter(() => clock.t),
            ...defaultAgentChecks,
          }),
        },
      );
      const result = await launcher?.launch({
        cwd: fx.projectDir,
        argv: [fx.claudePath],
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ ok: false, error: "window-not-ready" });
      expect(clock.t - started).toBe(1000);
      expect(fx.requestFiles()).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
