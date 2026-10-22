import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonicalPath,
  foldedPath,
  isSameOrInside,
  isSameOrInsideFolded,
} from "./canonical-path.js";
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

/**
 * The real location of `path` even when it does not exist yet: the deepest existing ancestor is
 * resolved through symlinks with `realpath.native`, which reports the on-disk spelling on a
 * case-insensitive volume, and the missing remainder is appended. A path that cannot be resolved
 * for any other reason is refused rather than guessed (the shared canonical-path module).
 */
function resolveReal(path: string): string {
  return canonicalPath(path);
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
    isSameOrInsideFolded(resolveReal(realRuntimeDir(home)), resolveReal(base)) ||
    isSameOrInsideFolded(resolveReal(home), resolveReal(root))
  ) {
    throw refusal();
  }
  try {
    lstatSync(root);
  } catch {
    return; // not created yet: the lexical shape is all there is to check
  }
  if (foldedPath(resolveReal(root)) !== foldedPath(join(resolveReal(base), basename(root)))) {
    throw refusal();
  }
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
  if (isSameOrInsideFolded(realRuntime, resolveReal(locations.runtimeDir))) {
    throw new IsolationError("Refusing the owner's real runtime directory.");
  }
  if (isSameOrInsideFolded(realRuntime, resolveReal(locations.socketPath))) {
    throw new IsolationError("Refusing the owner's real socket.");
  }
  if (isSameOrInsideFolded(realClaude, resolveReal(locations.claudeConfigDir))) {
    throw new IsolationError("Refusing the owner's real Claude config directory.");
  }
  if (Buffer.byteLength(locations.socketPath) >= SOCKET_PATH_MAX_BYTES) {
    throw new IsolationError("Refusing a socket path of 104 bytes or more.");
  }
}

// --- environment builders -----------------------------------------------------------------

export type ServiceKind = "normal" | "expiry";

/**
 * Everything the throwaway service receives, all inside the run root (D-05). The run root itself
 * must have the `ccc-uat.XXXXXX` shape under the allowed base; `shape` names another base or home
 * for tests only.
 */
export function buildServiceEnv(
  paths: RunRootPaths,
  account: string,
  kind: ServiceKind,
  shape: RunRootShapeOptions = {},
): Record<string, string> {
  assertUatAccount(account);
  assertRunRootShape(paths.root, shape);
  const root = resolve(paths.root);
  const realRoot = resolveReal(root);
  for (const inside of [
    paths.runtimeDir,
    paths.socketPath,
    paths.claudeConfigDir,
    paths.codexHome,
    paths.codexCandidatesDir,
    paths.codexBridgeHome,
  ]) {
    // Absolute and NUL-free: the service ignores a relative or malformed Codex folder and falls
    // back to the owner's real home, so such a value must never get as far as the environment.
    // The lexical check refuses a sibling or the root itself; the resolved check refuses a
    // symlink inside the run root that points out of it (D-42, T-08-10).
    if (
      typeof inside !== "string" ||
      !isAbsolute(inside) ||
      inside.includes("\0") ||
      !isSameOrInside(root, resolve(inside)) ||
      resolve(inside) === root ||
      !isSameOrInside(realRoot, resolveReal(inside)) ||
      resolveReal(inside) === realRoot
    ) {
      throw new IsolationError("Refusing a service location outside the run root.");
    }
  }
  const env: Record<string, string> = {
    CCC_RUNTIME_DIR: paths.runtimeDir,
    CCC_SOCKET_PATH: paths.socketPath,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    CODEX_HOME: paths.codexHome,
    // The service reads CCC_CODEX_HOME before CODEX_HOME and derives the Codex bridge state from
    // XDG_STATE_HOME, so both are set here and neither is left to the inherited environment.
    CCC_CODEX_HOME: paths.codexHome,
    XDG_STATE_HOME: paths.codexBridgeHome,
    CCC_INSTALL_SECRET_ACCOUNT: account,
    // A sandboxed service never probes the owner's Codex install or bridge folder (D-42,
    // research Pitfall 4). "Disabled" wins in detection; the folders are the fallback for a
    // drill that lifts it and the stand-in for the home folder when bridge state is derived.
    CCC_CODEX_CANDIDATES_DISABLED: "1",
    CCC_CODEX_CANDIDATES_DIR: paths.codexCandidatesDir,
    CCC_CODEX_BRIDGE_HOME: paths.codexBridgeHome,
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
  "CCC_CODEX_HOME",
  "XDG_STATE_HOME",
  "CCC_INSTALL_SECRET_ACCOUNT",
  "CCC_SPOOL_PATH",
  "CCC_CODEX_CANDIDATES_DISABLED",
  "CCC_CODEX_CANDIDATES_DIR",
  "CCC_CODEX_BRIDGE_HOME",
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
