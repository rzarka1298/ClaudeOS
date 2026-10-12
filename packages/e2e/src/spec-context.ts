import { assertRunRootShape, assertUatAccount } from "./isolation-guards.js";
import { appendPidOnce, type LedgerEntry } from "./ledger.js";
import { readProcessTable } from "./process-table.js";
import { parseProfile, type UatProfile } from "./profile.js";
import { pathsForRoot, type RunRootPaths } from "./run-root.js";
import type { Stoppable } from "./sandbox.js";
import { createServiceFixture, type ServiceFixture } from "./service-fixture.js";

/**
 * The spec-side view of the run (05.2-03): specs run inside the wdio worker, started by the CLI
 * parent, which owns the sandbox and its teardown. loadRunContext reads the environment the
 * runner built (buildWdioEnv), validates its shape with the same guards the config uses, and
 * returns the paths a spec needs. It throws a fixed message when run outside the runner.
 */

export interface RunContext {
  runRoot: string;
  runId: string;
  profile: UatProfile;
  account: string;
  socketPath: string;
  vaultLive: string;
  vaultBig: string | undefined;
  pluginStage: string;
  shotsDir: string | undefined;
  paths: RunRootPaths;
}

export interface ContextOptions {
  base?: string | undefined;
  home?: string | undefined;
}

const NOT_RUNNER = "Specs run only through the UAT runner: the run environment is missing.";

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(NOT_RUNNER);
  return value;
}

export function loadRunContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: ContextOptions = {},
): RunContext {
  const runRoot = required(env, "CCC_UAT_RUN_ROOT");
  assertRunRootShape(runRoot, { base: options.base, home: options.home });
  const runId = required(env, "CCC_UAT_RUN_ID");
  const account = required(env, "CCC_UAT_ACCOUNT");
  assertUatAccount(account);
  const paths = pathsForRoot(runRoot, runId);
  if (required(env, "CCC_SOCKET_PATH") !== paths.socketPath) {
    throw new Error("Refusing a socket path that is not the run root's own.");
  }
  if (account !== `ccc-uat-${runId}`) {
    throw new Error("Refusing a run id that does not match the Keychain account.");
  }
  return {
    runRoot,
    runId,
    profile: parseProfile(required(env, "CCC_UAT_PROFILE")),
    account,
    socketPath: paths.socketPath,
    vaultLive: required(env, "CCC_UAT_VAULT_LIVE"),
    vaultBig: env.CCC_UAT_VAULT_BIG === "" ? undefined : env.CCC_UAT_VAULT_BIG,
    pluginStage: required(env, "CCC_UAT_PLUGIN_STAGE"),
    shotsDir: env.CCC_UAT_SHOTS_DIR === "" ? undefined : env.CCC_UAT_SHOTS_DIR,
    paths,
  };
}

/**
 * A service fixture for a spec: a ledger-only sandbox handle (the CLI parent owns teardown, so
 * this one only records the pids it starts for the parent's leak check and next-start sweep).
 */
export function serviceFixtureFor(context: RunContext): ServiceFixture {
  const sandbox = {
    paths: context.paths,
    account: context.account,
    async registerService(handle: Stoppable, marker?: string): Promise<void> {
      if (handle.pid === undefined) return;
      const row = (await readProcessTable()).find((entry) => entry.pid === handle.pid);
      const entry: LedgerEntry = {
        kind: "pid",
        role: "service",
        pid: handle.pid,
        start: row?.start ?? "",
        ...(marker === undefined ? {} : { marker }),
      };
      appendPidOnce(context.paths.ledgerPath, entry as Extract<LedgerEntry, { kind: "pid" }>);
    },
    async recordSpawn(pid: number, marker?: string): Promise<void> {
      const row = (await readProcessTable()).find((entry) => entry.pid === pid);
      appendPidOnce(context.paths.ledgerPath, {
        kind: "pid",
        role: "service",
        pid,
        start: row?.start ?? "",
        ...(marker === undefined ? {} : { marker }),
      });
    },
    unregister(): void {},
  };
  return createServiceFixture(sandbox);
}
