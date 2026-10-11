import { basename, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Pure guards for the environment the live-UAT sandbox runs in (05.2 review HIGH-1,
 * MEDIUM-2; D-05, D-08, D-12, L-3). They never touch the filesystem and never echo the
 * offending value: every refusal is a fixed message.
 */

export const MSG_ISOLATION =
  "Refusing to run: the service, Claude, Codex and keychain isolation variables must all be " +
  "set to paths inside the run root and a ccc-uat- keychain account.";
export const MSG_SHOTS_DIR =
  "Refusing a screenshot directory that is relative or inside the repository.";
export const MSG_CACHE_DIR =
  "Refusing a cache directory inside the repository that is not the gitignored .obsidian-cache.";

const ACCOUNT_PREFIX = "ccc-uat-";

/** The environment variables whose values must be absolute paths strictly inside the run root. */
const ISOLATED_PATH_VARS = [
  "CCC_SOCKET_PATH",
  "CCC_RUNTIME_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const;

function isSameOrInside(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

function isStrictlyInside(outer: string, inner: string): boolean {
  return inner !== outer && isSameOrInside(outer, inner);
}

export interface IsolationContext {
  /** The short mode-700 run root. */
  runRoot: string;
  /** The real home directory, whose live service socket must never be used. */
  home: string;
}

/**
 * Throws unless every isolation variable is set and points inside the run root. Without
 * this the renderer's plugin falls back to the owner's live service socket and a spike
 * would write a real approval into the owner's store.
 */
export function assertIsolatedEnv(
  env: Readonly<Record<string, string | undefined>>,
  context: IsolationContext,
): void {
  const runRoot = resolve(context.runRoot);
  const liveSocket = join(resolve(context.home), ".claude-command-center", "svc.sock");

  for (const name of ISOLATED_PATH_VARS) {
    const value = env[name];
    if (value === undefined || value === "" || !isAbsolute(value)) throw new Error(MSG_ISOLATION);
    const path = resolve(value);
    if (!isStrictlyInside(runRoot, path) || path === liveSocket) throw new Error(MSG_ISOLATION);
  }

  const account = env.CCC_INSTALL_SECRET_ACCOUNT;
  if (
    account === undefined ||
    !account.startsWith(ACCOUNT_PREFIX) ||
    account.length === ACCOUNT_PREFIX.length
  ) {
    throw new Error(MSG_ISOLATION);
  }
}

/** Screenshots must be absolute and outside the repository (they may show owner data). */
export function assertShotsDir(path: string, repoRoot: string): void {
  if (!isAbsolute(path)) throw new Error(MSG_SHOTS_DIR);
  if (isSameOrInside(resolve(repoRoot), resolve(path))) throw new Error(MSG_SHOTS_DIR);
}

/** A cache inside the repository must be the gitignored `.obsidian-cache` directory. */
export function assertCacheDir(path: string, repoRoot: string): void {
  if (!isAbsolute(path)) throw new Error(MSG_CACHE_DIR);
  const cache = resolve(path);
  const root = resolve(repoRoot);
  if (isSameOrInside(root, cache) && basename(cache) !== ".obsidian-cache") {
    throw new Error(MSG_CACHE_DIR);
  }
}
