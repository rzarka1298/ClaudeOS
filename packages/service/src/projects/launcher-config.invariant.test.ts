import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCH_PATH,
  LAUNCHER_IDS,
  LAUNCHERS_SAVE_PATH,
  type LauncherId,
  LaunchResultSchema,
  PROJECT_REGISTER_PATH,
  type ProjectId,
  RegisterProjectResponseSchema,
  type TerminalChoice,
} from "@ccc/domain";
import { renderCommandTemplate, TERMINAL_PRESETS } from "@ccc/launchers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScriptedReply } from "../test-support/fake-command-runner.js";
import { type LauncherHarness, startLauncherHarness } from "../test-support/launcher-harness.js";

/**
 * The assumption-delta invariant (plan 04-01, D-19, D-27): launcher identity
 * IS the owner's stored configuration. For every launcher and, for Claude
 * Code, every terminal kind, a configuration saved through the real save
 * route is exactly what the real launch route spawns — bundle ID, executable
 * and template, element for element — and a second save changes the next
 * launch. A launcher with nothing saved is `launcher-not-configured` and
 * spawns nothing. Any hard-coded fallback (an app name, a default bundle, a
 * default claude path) anywhere in the launch path fails this test.
 *
 * Everything runs over the socket harness with the fake spawner and the fake
 * command runner: nothing opens, and the project is a throwaway folder.
 */

/** Bundle IDs this fake Mac has installed. None is a real app's ID, so no default can match. */
const INSTALLED_BUNDLES = ["org.example.first-editor", "org.example.second-editor"] as const;

function installedBundles(): ScriptedReply[] {
  const script: ScriptedReply[] = [];
  for (const bundleId of INSTALLED_BUNDLES) {
    const app = `/Applications/${bundleId}.app`;
    script.push({
      match: (file, args) =>
        file === "/usr/bin/mdfind" && args[0] === `kMDItemCFBundleIdentifier == '${bundleId}'`,
      outcome: { exitCode: 0, stdout: `${app}\n` },
    });
    script.push({
      match: (file, args) =>
        file === "/usr/bin/plutil" &&
        args[1] === "CFBundleIdentifier" &&
        args[args.length - 1] === `${app}/Contents/Info.plist`,
      outcome: { exitCode: 0, stdout: `${bundleId}\n` },
    });
  }
  return script;
}

/** Every terminal kind a Claude Code configuration can choose: the built-in adapter and every preset. */
type TerminalKind = { readonly name: string; readonly choice: (stubs: Stubs) => TerminalChoice };

interface Stubs {
  readonly claude: string;
  readonly otherClaude: string;
  readonly terminal: string;
}

const TERMINAL_KINDS: readonly TerminalKind[] = [
  { name: "terminal-app", choice: () => ({ kind: "terminal-app" }) },
  ...TERMINAL_PRESETS.map(
    (preset): TerminalKind => ({
      name: `preset ${preset.id}`,
      choice: (stubs) => ({
        kind: "custom",
        preset: preset.id,
        // The blank preset's empty executable is the owner's to fill in.
        argv: preset.argv.map((element) => (element === "" ? stubs.terminal : element)),
      }),
    }),
  ),
];

let harness: LauncherHarness;
let projectPath: string;
let projectId: ProjectId;
let stubs: Stubs;

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

beforeEach(async () => {
  harness = await startLauncherHarness({ script: installedBundles() });
  const home = harness.homeDir;
  stubs = {
    claude: executable(join(home, "bin", "claude")),
    otherClaude: executable(join(home, "other-bin", "claude")),
    terminal: executable(join(home, "terminals", "stub-terminal")),
  };
  const folder = join(home, "projects", "example-project");
  mkdirSync(folder, { recursive: true });
  projectPath = realpathSync.native(folder);
  const reply = await harness.post(PROJECT_REGISTER_PATH, { path: folder });
  const registered = RegisterProjectResponseSchema.parse(reply.body);
  if (registered.kind !== "registered") throw new Error(`registration answered ${registered.kind}`);
  projectId = registered.projectId;
});

afterEach(() => {
  harness.close();
});

async function save(body: unknown): Promise<void> {
  const reply = await harness.post(LAUNCHERS_SAVE_PATH, body);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
}

async function launch(launcherId: LauncherId) {
  const body =
    launcherId === "claude-desktop" ? { action: launcherId } : { action: launcherId, projectId };
  const reply = await harness.post(LAUNCH_PATH, body);
  expect(reply.status).toBe(200);
  return LaunchResultSchema.parse(reply.body);
}

/** The argv of the most recent hand-off, awaited (`run`) or detached. */
function lastHandOff(): readonly string[] {
  const detached = harness.spawner.detached.at(-1);
  const awaited = harness.spawner.calls.at(-1);
  return (detached ?? awaited)?.argv ?? [];
}

function clearSpawns(): void {
  harness.spawner.calls.length = 0;
  harness.spawner.detached.length = 0;
}

/** The script path a hand-off argv carries (the element under the scriptDir). */
function scriptOf(argv: readonly string[]): string {
  const script = argv.find((element) => element.startsWith(`${harness.scriptDir}/`));
  if (script === undefined) throw new Error("no launch script in the hand-off");
  return script;
}

/** The argv line of a written launch script: each element single-quoted. */
function scriptArgvLine(argv: readonly string[]): string {
  return argv.map((element) => `'${element.replaceAll("'", "'\\''")}'`).join(" ");
}

describe("every launcher launches exactly its stored configuration", () => {
  it("iterates every launcher id", () => {
    expect([...LAUNCHER_IDS].sort()).toEqual(["antigravity", "claude-code", "claude-desktop"]);
  });

  for (const launcherId of LAUNCHER_IDS) {
    it(`${launcherId}: nothing saved is launcher-not-configured and spawns nothing`, async () => {
      expect(await launch(launcherId)).toEqual({ ok: false, error: "launcher-not-configured" });
      expect(harness.spawner.calls).toHaveLength(0);
      expect(harness.spawner.detached).toHaveLength(0);
    });
  }

  for (const launcherId of LAUNCHER_IDS.filter((id) => id !== "claude-code")) {
    it(`${launcherId}: spawns the saved bundle ID, and the next save changes it`, async () => {
      const [first, second] = INSTALLED_BUNDLES;
      const expected = (bundleId: string): readonly string[] =>
        launcherId === "antigravity"
          ? ["/usr/bin/open", "-b", bundleId, projectPath]
          : ["/usr/bin/open", "-b", bundleId];

      await save({ launcherId, bundleId: first });
      expect(await launch(launcherId)).toEqual({ ok: true });
      expect(lastHandOff()).toEqual(expected(first));

      await save({ launcherId, bundleId: second });
      clearSpawns();
      expect(await launch(launcherId)).toEqual({ ok: true });
      expect(lastHandOff()).toEqual(expected(second));
      expect(lastHandOff()).not.toContain(first);
    });
  }
});

describe("Claude Code launches its stored executable, arguments and terminal, for every terminal kind", () => {
  for (const kind of TERMINAL_KINDS) {
    it(`${kind.name}: the saved template is the hand-off, and the next save changes it`, async () => {
      const terminal = kind.choice(stubs);
      const runs: { executable: string; args: readonly string[] }[] = [
        { executable: stubs.claude, args: ["--model", "opus", "{projectPath}"] },
        { executable: stubs.otherClaude, args: ["--permission-mode", "plan"] },
      ];
      const scripts: string[] = [];

      for (const run of runs) {
        await save({
          launcherId: "claude-code",
          executable: { kind: "path", path: run.executable },
          args: run.args,
          terminal,
        });
        clearSpawns();
        expect(await launch("claude-code")).toEqual({ ok: true });

        const handOff = lastHandOff();
        const script = scriptOf(handOff);
        if (terminal.kind === "terminal-app") {
          expect(handOff).toEqual(["/usr/bin/open", "-b", "com.apple.Terminal", script]);
        } else {
          expect(handOff).toEqual(renderCommandTemplate(terminal.argv, { script, projectPath }));
        }
        const body = readFileSync(script, "utf8");
        const claudeArgv = renderCommandTemplate([run.executable, ...run.args], { projectPath });
        expect(body.split("\n")).toContain(scriptArgvLine(claudeArgv));
        scripts.push(body);
      }

      // The second save changed what the next launch ran.
      expect(scripts[1]).not.toEqual(scripts[0]);
      expect(scripts[1]).not.toContain(stubs.claude);
    });
  }

  it("a changed terminal choice changes the next hand-off", async () => {
    const [first, second] = TERMINAL_KINDS;
    if (first === undefined || second === undefined) throw new Error("need two terminal kinds");
    for (const kind of [first, second]) {
      await save({
        launcherId: "claude-code",
        executable: { kind: "path", path: stubs.claude },
        args: [],
        terminal: kind.choice(stubs),
      });
      clearSpawns();
      expect(await launch("claude-code")).toEqual({ ok: true });
    }
    const terminal = second.choice(stubs);
    const handOff = lastHandOff();
    expect(terminal.kind).toBe("custom");
    if (terminal.kind === "custom") {
      expect(handOff).toEqual(
        renderCommandTemplate(terminal.argv, { script: scriptOf(handOff), projectPath }),
      );
    }
    expect(handOff).not.toContain("com.apple.Terminal");
  });
});
