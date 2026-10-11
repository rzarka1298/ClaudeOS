import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertRunRootShape,
  DEFAULT_RUN_BASE,
  IsolationError,
  RUN_ROOT_PREFIX,
  SOCKET_PATH_MAX_BYTES,
} from "./isolation-guards.js";

/**
 * The single short run root every live-UAT run happens inside (05.2-03, D-05, T-05.2-08):
 * `/tmp/ccc-uat.XXXXXX`, mode 0700, holding the throwaway service's runtime directory and
 * socket, scratch Claude and Codex config folders, vaults, the staged plugin, the ledger
 * and the results. Later plans share the names returned here.
 */

export interface RunRootPaths {
  /** Eight lowercase hex characters, independent of the directory suffix. */
  runId: string;
  root: string;
  runtimeDir: string;
  socketPath: string;
  dbPath: string;
  claudeConfigDir: string;
  codexHome: string;
  vaultsDir: string;
  pluginStageDir: string;
  tmpDir: string;
  wdioDir: string;
  /** The files below are created lazily by their writers. */
  ledgerPath: string;
  resultsPath: string;
  lookPendingPath: string;
  versionsPath: string;
}

export interface RunRootOptions {
  /** Allowed parent folder; defaults to /tmp. A parameter for tests only. */
  base?: string | undefined;
  home?: string | undefined;
}

const GROUP_OTHER_BITS = 0o077;

function makePrivateDir(path: string): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  chmodSync(path, 0o700);
  assertPrivate(path);
}

function assertPrivate(path: string): void {
  if ((statSync(path).mode & GROUP_OTHER_BITS) !== 0) {
    throw new IsolationError("Refusing a run folder that is readable by group or others.");
  }
}

export function createRunRoot(options: RunRootOptions = {}): RunRootPaths {
  const base = options.base ?? DEFAULT_RUN_BASE;
  const root = mkdtempSync(join(base, RUN_ROOT_PREFIX));
  try {
    assertRunRootShape(root, { base, home: options.home });
    chmodSync(root, 0o700);
    assertPrivate(root);
    const paths: RunRootPaths = {
      runId: randomBytes(4).toString("hex"),
      root,
      runtimeDir: join(root, "rt"),
      socketPath: join(root, "rt", "svc.sock"),
      dbPath: join(root, "rt", "operational.db"),
      claudeConfigDir: join(root, "claude"),
      codexHome: join(root, "codex"),
      vaultsDir: join(root, "vaults"),
      pluginStageDir: join(root, "plugin-stage"),
      tmpDir: join(root, "tmp"),
      wdioDir: join(root, "wdio"),
      ledgerPath: join(root, "ledger.jsonl"),
      resultsPath: join(root, "results.jsonl"),
      lookPendingPath: join(root, "look-pending.jsonl"),
      versionsPath: join(root, "versions.json"),
    };
    for (const dir of [
      paths.runtimeDir,
      paths.claudeConfigDir,
      paths.codexHome,
      paths.vaultsDir,
      paths.pluginStageDir,
      paths.tmpDir,
      paths.wdioDir,
    ]) {
      makePrivateDir(dir);
    }
    // The 104-byte cap is only meaningful against the real /tmp base; a test base may be longer.
    if (base === DEFAULT_RUN_BASE && Buffer.byteLength(paths.socketPath) >= SOCKET_PATH_MAX_BYTES) {
      throw new IsolationError("Refusing a socket path of 104 bytes or more.");
    }
    return paths;
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** Removes a run root completely; anything failing the shape check is refused and left alone. */
export function removeRunRoot(root: string, options: RunRootOptions = {}): void {
  assertRunRootShape(root, { base: options.base ?? DEFAULT_RUN_BASE, home: options.home });
  rmSync(root, { recursive: true, force: true });
}
