import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only builder for the codex-bridge world (plan 05.1-13): a temporary HOME, a launcher file
 * at the fixed launcher path, the protocol marker, a project folder, two fake agent executables
 * and the plan 05.1-04 window simulator over the same state directory. Nothing here touches the
 * owner's real bridge directory, launcher or Antigravity: everything lives in a fresh temporary
 * directory that `cleanup` removes.
 */

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** A claimed request as the simulator reports it. */
export interface SimulatedClaim {
  readonly request: Readonly<Record<string, unknown>>;
  readonly terminal: Readonly<Record<string, unknown>>;
}

export type SimulatorMode = "current" | "outdated" | "closed";

export interface WindowSimulator {
  readonly mode: SimulatorMode;
  readonly key: string;
  readonly log: string[];
  setNow(ms: number): void;
  heartbeat(): void;
  tick(): SimulatedClaim[];
  close(): void;
}

interface SimulatorModule {
  createWindowSimulator(options: {
    stateDir: string;
    folders: string[];
    mode: SimulatorMode;
    now?: number | (() => number);
    key?: string;
    launcherInstalled?: boolean;
    containDelayMs?: number;
  }): WindowSimulator;
}

interface BridgeCoreModule {
  writeProtocolMarker(stateDir: string, kit: string): void;
  ensureDirs(stateDir: string): void;
}

const simulatorModule = require(
  join(REPO_ROOT, "scripts", "codex", "test-support", "bridge-window-simulator.cjs"),
) as SimulatorModule;
const bridgeCore = require(
  join(REPO_ROOT, "scripts", "codex", "antigravity-extension", "bridge-core.js"),
) as BridgeCoreModule;

export interface BridgeFixture {
  /** The realpath of the throwaway directory everything below lives in. */
  readonly base: string;
  readonly home: string;
  /** `<home>/.local/state/codex-bridge`, what the service finds with an empty environment. */
  readonly stateDir: string;
  readonly requestsDir: string;
  readonly claimedDir: string;
  readonly windowsDir: string;
  /** The fixed launcher path under `home`. */
  readonly launcherPath: string;
  /** The registered project folder. */
  readonly projectDir: string;
  /** Executable stand-ins named `claude` and `codex`. */
  readonly claudePath: string;
  readonly codexPath: string;
  installLauncher(): void;
  /** The marker `install-user-kit` writes; `protocol` and `capabilities` default to the current kit. */
  installMarker(marker?: { protocol?: number; capabilities?: string[]; kit?: string }): void;
  /** A simulated window; folders default to the project folder. */
  simulator(
    mode: SimulatorMode,
    options?: {
      folders?: string[];
      now?: number | (() => number);
      key?: string;
      containDelayMs?: number;
    },
  ): WindowSimulator;
  requestFiles(): string[];
  claimedFiles(): string[];
  cleanup(): void;
}

function makeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

function listOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function createBridgeFixture(): BridgeFixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-bridge-fx-")));
  const home = join(base, "home");
  const stateDir = join(home, ".local", "state", "codex-bridge");
  const launcherPath = join(home, ".local", "bin", "codex-bridge");
  const projectDir = join(base, "project");
  const claudePath = join(base, "bin", "claude");
  const codexPath = join(base, "bin", "codex");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  makeExecutable(claudePath);
  makeExecutable(codexPath);
  return {
    base,
    home,
    stateDir,
    requestsDir: join(stateDir, "requests"),
    claimedDir: join(stateDir, "claimed"),
    windowsDir: join(stateDir, "windows"),
    launcherPath,
    projectDir,
    claudePath,
    codexPath,
    installLauncher() {
      makeExecutable(launcherPath);
    },
    installMarker(marker = {}) {
      bridgeCore.ensureDirs(stateDir);
      if (
        marker.protocol === undefined &&
        marker.capabilities === undefined &&
        marker.kit === undefined
      ) {
        bridgeCore.writeProtocolMarker(stateDir, "test-kit");
        return;
      }
      writeFileSync(
        join(stateDir, "protocol.json"),
        `${JSON.stringify({
          protocol: marker.protocol ?? 2,
          capabilities: marker.capabilities ?? ["follow", "tui", "agent"],
          kit: marker.kit ?? "test-kit",
        })}\n`,
        { mode: 0o600 },
      );
    },
    simulator(mode, options = {}) {
      return simulatorModule.createWindowSimulator({
        stateDir,
        folders: options.folders ?? [projectDir],
        mode,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.containDelayMs === undefined ? {} : { containDelayMs: options.containDelayMs }),
      });
    },
    requestFiles: () => listOrEmpty(join(stateDir, "requests")),
    claimedFiles: () => listOrEmpty(join(stateDir, "claimed")),
    cleanup() {
      if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    },
  };
}
