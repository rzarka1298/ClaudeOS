import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { scrubInheritedEnv } from "./isolation-guards.js";
import type { SandboxHandle, Stoppable } from "./sandbox.js";

/**
 * The wdio spawn wrapper (05.2-03, D-05, D-06): an argv array with no shell, the wdio entry
 * located through the package's own binary entry (never npx or pnpm exec), an environment that
 * is the scrubbed inherited one plus buildWdioEnv, the child ledgered with role wdio, and the
 * runner's SIGINT or SIGTERM forwarded to it as SIGTERM through the child handle.
 */

/** The scrubbed inherited environment with the runner-built wdio variables on top. */
export function buildWdioProcessEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  wdioEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(scrubInheritedEnv(inherited))) {
    if (value !== undefined) merged[key] = value;
  }
  return { ...merged, ...wdioEnv };
}

export function buildWdioArgv(
  wdioBin: string,
  configPath: string,
  extraArgs: readonly string[],
): string[] {
  return [wdioBin, "run", configPath, ...extraArgs];
}

export interface LocateDeps {
  /** Resolves the @wdio/cli main file. */
  resolveMain: () => string;
  /** Reads and parses a JSON file; undefined when it is missing. */
  readJson: (file: string) => unknown;
}

const defaultLocateDeps: LocateDeps = {
  resolveMain: () => createRequire(import.meta.url).resolve("@wdio/cli"),
  readJson: (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  },
};

/**
 * The wdio bin file of the installed @wdio/cli: walk up from its resolved main file to the
 * package folder and read the package's own `bin` entry (its exports map hides deep paths).
 */
export function locateWdioBin(deps: LocateDeps = defaultLocateDeps): string {
  let dir = dirname(deps.resolveMain());
  for (let depth = 0; depth < 6; depth += 1) {
    const pkg = deps.readJson(join(dir, "package.json")) as
      | { name?: string; bin?: string | Record<string, string> }
      | undefined;
    if (pkg?.name === "@wdio/cli") {
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.wdio;
      if (typeof bin !== "string") break;
      return join(dir, bin);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the @wdio/cli binary entry.");
}

export interface SignalSource {
  on(signal: string, handler: () => void): unknown;
  off(signal: string, handler: () => void): unknown;
}

/** Forwards the runner's SIGINT and SIGTERM to the child as SIGTERM; returns a disposer. */
export function forwardSignals(
  child: { kill(signal?: NodeJS.Signals): boolean },
  source: SignalSource = process,
): () => void {
  const handler = (): void => {
    child.kill("SIGTERM");
  };
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) source.on(signal, handler);
  return () => {
    for (const signal of signals) source.off(signal, handler);
  };
}

/** A stop and kill pair over a ChildProcess, for the sandbox's teardown. */
export function childAsStoppable(child: ChildProcess): Stoppable {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const waitForExit = (signal: NodeJS.Signals): Promise<void> =>
    new Promise((resolve) => {
      if (exited()) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill(signal);
    });
  return {
    pid: child.pid,
    stop: () => waitForExit("SIGTERM"),
    kill: () => waitForExit("SIGKILL"),
  };
}

export interface WdioResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnWdioOptions {
  sandbox: Pick<SandboxHandle, "registerChild">;
  configPath: string;
  cwd: string;
  /** buildWdioEnv output. */
  wdioEnv: Readonly<Record<string, string>>;
  extraArgs?: readonly string[];
  inherited?: Readonly<Record<string, string | undefined>>;
  spawnFn?: typeof spawn;
  locate?: () => string;
}

/** Runs wdio to completion; the child is ledgered before this resolves. */
export async function spawnWdio(options: SpawnWdioOptions): Promise<WdioResult> {
  const wdioBin = (options.locate ?? locateWdioBin)();
  const argv = buildWdioArgv(wdioBin, options.configPath, options.extraArgs ?? []);
  const env = buildWdioProcessEnv(options.inherited ?? process.env, options.wdioEnv);
  const child = (options.spawnFn ?? spawn)(process.execPath, argv, {
    env,
    cwd: options.cwd,
    stdio: "inherit",
    shell: false,
  });
  const done = new Promise<WdioResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await options.sandbox.registerChild("wdio", childAsStoppable(child), wdioBin);
  const dispose = forwardSignals(child);
  try {
    return await done;
  } finally {
    dispose();
  }
}
