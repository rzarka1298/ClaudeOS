import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { UatProfile } from "./profile.js";
import type { RunRootPaths } from "./run-root.js";

/**
 * Pure guards and env builders for the live-UAT sandbox (05.2-03, D-05, T-05.2-08/09/11).
 *
 * This is the ONLY source file in the package allowed to name the owner's real runtime
 * directory and Claude config location, because it exists to refuse them. Every location is
 * derived from a home directory at call time; none is a literal. Every refusal is a fixed
 * message naming only the category, never the offending path.
 */

export const UAT_ACCOUNT_PREFIX = "ccc-uat-";
export const DEFAULT_INSTALL_SECRET_ACCOUNT = "install-secret";
export const RUN_ROOT_PREFIX = "ccc-uat.";
export const DEFAULT_RUN_BASE = "/tmp";
export const SOCKET_PATH_MAX_BYTES = 104;

/** The Keychain safe-identifier character set (@ccc/keychain SAFE_IDENTIFIER_PATTERN). */
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const RUN_ROOT_NAME = /^ccc-uat\.[A-Za-z0-9]{6}$/;

/** The three test-only service variables; they exist only for the expiry kind (D-05). */
export const TEST_OVERRIDE_ENV = {
  enable: "CCC_ENABLE_TEST_OVERRIDES",
  approvalTtl: "CCC_APPROVAL_TEST_TTL_MS",
  sweep: "CCC_APPROVAL_SWEEP_MS",
} as const;

const EXPIRY_TTL_MS = "15000";
const EXPIRY_SWEEP_MS = "500";

export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationError";
  }
}

/** True when `inner` equals `outer` or sits below it (boundary-safe, never a prefix match). */
function isSameOrInside(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/**
 * The real location of `path` even when it does not exist yet: the deepest existing ancestor
 * is resolved through symlinks and the missing remainder is appended.
 */
function resolveReal(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute;
      missing.push(basename(probe));
      probe = parent;
    }
  }
}

// --- the owner's real locations (read-only path builders) --------------------------------

export function realRuntimeDir(home: string = homedir()): string {
  return join(home, ".claude-command-center");
}

export function realSocketPath(home: string = homedir()): string {
  return join(realRuntimeDir(home), "svc.sock");
}

export function realStorePath(home: string = homedir()): string {
  return join(realRuntimeDir(home), "operational.db");
}

export function realClaudeConfigDir(home: string = homedir()): string {
  return join(home, ".claude");
}

// --- Keychain account ---------------------------------------------------------------------

export function uatAccountFor(runId: string): string {
  return `${UAT_ACCOUNT_PREFIX}${runId}`;
}

/** Accepts only a ccc-uat account made of the Keychain safe-identifier characters. */
export function assertUatAccount(account: string): void {
  if (
    typeof account !== "string" ||
    account === DEFAULT_INSTALL_SECRET_ACCOUNT ||
    !account.startsWith(UAT_ACCOUNT_PREFIX) ||
    account.length === UAT_ACCOUNT_PREFIX.length ||
    !SAFE_IDENTIFIER.test(account)
  ) {
    throw new IsolationError("Refusing a Keychain account outside the ccc-uat family.");
  }
}

// --- run root -----------------------------------------------------------------------------

export interface RunRootShapeOptions {
  base?: string | undefined;
  home?: string | undefined;
}

/**
 * The run root must be a direct child of the allowed base named ccc-uat.XXXXXX, and must not
 * be (or hide behind a symlink to) anything else: real paths are compared when it exists.
 */
export function assertRunRootShape(path: string, options: RunRootShapeOptions = {}): void {
  const home = options.home ?? homedir();
  const base = resolve(options.base ?? DEFAULT_RUN_BASE);
  const refusal = (): IsolationError =>
    new IsolationError(
      "Refusing a run root that is not a ccc-uat.XXXXXX folder under the allowed base.",
    );
  if (typeof path !== "string" || !isAbsolute(path)) throw refusal();
  const root = resolve(path);
  if (dirname(root) !== base || !RUN_ROOT_NAME.test(basename(root))) throw refusal();
  if (
    isSameOrInside(resolveReal(realRuntimeDir(home)), resolveReal(base)) ||
    isSameOrInside(resolveReal(home), resolveReal(root)) ||
    resolveReal(root) === resolveReal(home)
  ) {
    throw refusal();
  }
  try {
    lstatSync(root);
  } catch {
    return; // not created yet: the lexical shape is all there is to check
  }
  if (resolveReal(root) !== join(resolveReal(base), basename(root))) throw refusal();
}

// --- real paths refused -------------------------------------------------------------------

export interface SandboxLocations {
  runtimeDir: string;
  socketPath: string;
  claudeConfigDir: string;
}

/**
 * Refuses a runtime directory, socket or Claude config directory that resolves (through
 * symlinks) to the owner's real ones or below them, and a socket path of 104 bytes or more.
 */
export function refuseRealPaths(
  locations: SandboxLocations,
  options: { home?: string | undefined } = {},
): void {
  const home = options.home ?? homedir();
  const realRuntime = resolveReal(realRuntimeDir(home));
  const realClaude = resolveReal(realClaudeConfigDir(home));
  if (isSameOrInside(realRuntime, resolveReal(locations.runtimeDir))) {
    throw new IsolationError("Refusing the owner's real runtime directory.");
  }
  if (isSameOrInside(realRuntime, resolveReal(locations.socketPath))) {
    throw new IsolationError("Refusing the owner's real socket.");
  }
  if (isSameOrInside(realClaude, resolveReal(locations.claudeConfigDir))) {
    throw new IsolationError("Refusing the owner's real Claude config directory.");
  }
  if (Buffer.byteLength(locations.socketPath) >= SOCKET_PATH_MAX_BYTES) {
    throw new IsolationError("Refusing a socket path of 104 bytes or more.");
  }
}

// --- environment builders -----------------------------------------------------------------

export type ServiceKind = "normal" | "expiry";

/** Everything the throwaway service receives, all inside the run root (D-05). */
export function buildServiceEnv(
  paths: RunRootPaths,
  account: string,
  kind: ServiceKind,
): Record<string, string> {
  assertUatAccount(account);
  for (const inside of [
    paths.runtimeDir,
    paths.socketPath,
    paths.claudeConfigDir,
    paths.codexHome,
  ]) {
    if (
      !isSameOrInside(resolve(paths.root), resolve(inside)) ||
      resolve(inside) === resolve(paths.root)
    ) {
      throw new IsolationError("Refusing a service location outside the run root.");
    }
  }
  const env: Record<string, string> = {
    CCC_RUNTIME_DIR: paths.runtimeDir,
    CCC_SOCKET_PATH: paths.socketPath,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    CODEX_HOME: paths.codexHome,
    CCC_INSTALL_SECRET_ACCOUNT: account,
  };
  if (kind === "expiry") {
    env[TEST_OVERRIDE_ENV.enable] = "1";
    env[TEST_OVERRIDE_ENV.approvalTtl] = EXPIRY_TTL_MS;
    env[TEST_OVERRIDE_ENV.sweep] = EXPIRY_SWEEP_MS;
  }
  return env;
}

const SCRUBBED_ENV_KEYS: readonly string[] = [
  TEST_OVERRIDE_ENV.enable,
  TEST_OVERRIDE_ENV.approvalTtl,
  TEST_OVERRIDE_ENV.sweep,
  "CCC_RUNTIME_DIR",
  "CCC_SOCKET_PATH",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CCC_INSTALL_SECRET_ACCOUNT",
  "CCC_SPOOL_PATH",
];

/** A copy of `env` without the overrides and isolation variables; the caller assigns it back. */
export function scrubInheritedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...env };
  for (const key of SCRUBBED_ENV_KEYS) delete copy[key];
  return copy;
}

export interface WdioEnvOptions {
  account: string;
  profile: UatProfile;
  /** A mode-700 folder for page screenshots (D-12); omitted when the caller has none yet. */
  shotsDir?: string;
}

/**
 * The environment the wdio process (and so the sandbox Obsidian) receives. It never carries a
 * test-override variable: those belong to the throwaway service only (D-05).
 */
export function buildWdioEnv(paths: RunRootPaths, options: WdioEnvOptions): Record<string, string> {
  assertUatAccount(options.account);
  const env: Record<string, string> = {
    CCC_SOCKET_PATH: paths.socketPath,
    // The launch guard (assertIsolatedEnv) checks these in the wdio process, and anything the
    // sandbox Obsidian spawns inherits them, so it can only ever reach run-root locations.
    CCC_RUNTIME_DIR: paths.runtimeDir,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    CODEX_HOME: paths.codexHome,
    CCC_INSTALL_SECRET_ACCOUNT: options.account,
    CCC_UAT_RUN_ROOT: paths.root,
    CCC_UAT_RUN_ID: paths.runId,
    CCC_UAT_PROFILE: options.profile,
    CCC_UAT_ACCOUNT: options.account,
    CCC_UAT_VAULT_LIVE: join(paths.vaultsDir, "live"),
    CCC_UAT_PLUGIN_STAGE: paths.pluginStageDir,
    TMPDIR: paths.tmpDir,
  };
  if (options.profile === "full") env.CCC_UAT_VAULT_BIG = join(paths.vaultsDir, "big");
  if (options.shotsDir !== undefined) env.CCC_UAT_SHOTS_DIR = options.shotsDir;
  return env;
}
