import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BundleIdSchema } from "@ccc/domain";
import {
  assertNoSymlinkBelow,
  canonicalPath,
  foldedPath,
  isSameOrInside,
  isSameOrInsideFolded,
  isStrictlyInside,
  MSG_PATH_LINK,
} from "../canonical-path.js";
import {
  assertRunRootShape,
  DEFAULT_RUN_BASE,
  realClaudeConfigDir,
  realRuntimeDir,
  refuseRealPaths,
} from "../isolation-guards.js";
import { REPO_ROOT } from "../repo-paths.js";
import { pathsForRoot, type RunRootPaths } from "../run-root.js";
import { SQLITE_TOOL } from "../store-copy.js";

/**
 * Drill helpers for the Phase 8 health specs (plan 08-05, D-09, research Pitfall 7, threats
 * T-08-11 and T-08-11b). Each one creates a break condition INSIDE the run root and nowhere
 * else: a second throwaway vault, a fake `claude` or `codex` executable, the hook installer run
 * against scratch folders, dropped-records bytes in the sandbox spool, one launcher row in the
 * stopped sandbox store, and a permission change that is always undone.
 *
 * Every helper first runs the same guard (`guardRoot`, then `guardTarget`): the run root must
 * be a `ccc-uat.XXXXXX` folder directly under the real base (`/tmp`), exist, belong to the
 * current user and be mode 700, the passed paths must be exactly that root's own layout, no
 * location may be the owner's real runtime folder, Claude config folder or sit below the home
 * folder at all, every target must lie strictly inside the root both textually and after
 * symlinks are resolved, and no component below the root may be a symbolic link. Every refusal
 * is a fixed message that names the category, never the offending path.
 *
 * Files are written through one descriptor opened with `O_NOFOLLOW` (and `O_EXCL` for a new
 * executable); the mode is set on that descriptor, and a file that has a second hard link is
 * refused, so neither a link swapped in after the check nor a link made beforehand can carry a
 * write or a mode change to a file outside the run root.
 *
 * Processes are started with a fixed argv, `shell: false`, an explicit minimal environment and a
 * 30 second cap that ends the child with SIGKILL; nothing here waits without a deadline. This
 * module imports no database binding: the one seed write goes through the `sqlite3` command-line
 * tool, as `store-copy.ts` does for reads. Nothing here starts the runner, the service or an app.
 */

/** The cap on every helper-started process (T-08-11b). */
export const DRILL_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SPOOL_DROP_BYTES = 65_536;
const FIXED_PATH = "/usr/bin:/bin";

const MSG_OUTSIDE_ROOT = "Refusing a path outside the run root.";
const MSG_OWNER_LOCATION = "Refusing a path in the owner's real folders.";
const MSG_FORGED_PATHS = "Refusing run root paths that are not the run root's own layout.";
const MSG_BAD_MODE = "Refusing a mode that is not plain permission bits.";
const MSG_ROOT_NOT_PRIVATE =
  "Refusing a run root that does not exist or is not a private folder of the current user.";
const MSG_SHARED_FILE =
  "Refusing a file that is shared through a hard link or is not a plain file.";
const MSG_ALREADY_HELD = "Refusing a permission change on a path another change already holds.";

/** Injection points. Tests pass a fake home and a fake runner; production passes nothing. */
export interface DrillDeps {
  /** The owner's home, for the real-folder refusals; defaults to the process's home. */
  home?: string | undefined;
  /** The process cap in milliseconds; defaults to {@link DRILL_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /** The process runner; defaults to {@link runFixedArgv}. */
  run?: DrillRunner | undefined;
  /** The service fixture: seeding needs one, and is refused while it runs. */
  fixture?: { isRunning(): boolean } | undefined;
  /** The allowed run-root base; defaults to the real one. A parameter for tests only. */
  base?: string | undefined;
}

export type DrillRunner = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

// --- the guard ----------------------------------------------------------------------------

/**
 * The owner's locations a drill may never reach: the real runtime folder (and so the real store
 * and socket), the Claude config folder, and the whole home folder, which holds the vaults, the
 * Codex install and its bridge folder. The path is resolved through symlinks first.
 */
export function refuseOwnerLocations(path: string, home: string = homedir()): void {
  let canonical: string;
  try {
    canonical = canonicalPath(path);
  } catch {
    throw new Error(MSG_OWNER_LOCATION);
  }
  for (const owner of [realRuntimeDir(home), realClaudeConfigDir(home), home]) {
    // Folded: the default macOS volume reads `.Claude` and `.claude` as one folder.
    if (isSameOrInsideFolded(canonicalPath(owner), canonical)) {
      throw new Error(MSG_OWNER_LOCATION);
    }
  }
}

/** The fields of a run root that must equal the layout `pathsForRoot` derives from the root. */
const LAYOUT_FIELDS = [
  "runtimeDir",
  "socketPath",
  "dbPath",
  "claudeConfigDir",
  "codexHome",
  "codexCandidatesDir",
  "codexBridgeHome",
  "vaultsDir",
  "pluginStageDir",
  "tmpDir",
  "wdioDir",
] as const satisfies readonly (keyof RunRootPaths)[];

/** Validates the run root itself and returns its resolved path. */
function guardRoot(paths: RunRootPaths, home: string, base: string): string {
  if (typeof paths?.root !== "string" || !isAbsolute(paths.root) || paths.root.includes("\0")) {
    throw new Error(MSG_OUTSIDE_ROOT);
  }
  const root = resolve(paths.root);
  // Throws for anything that is not a direct child ccc-uat.XXXXXX of the PINNED base (not of
  // whatever parent the caller's paths happen to name), that sits below the home folder, or that
  // is (or hides behind) a symlink.
  assertRunRootShape(root, { base, home });
  requirePrivateRoot(root);
  const expected = pathsForRoot(root, paths.runId);
  for (const field of LAYOUT_FIELDS) {
    if (paths[field] !== expected[field]) throw new Error(MSG_FORGED_PATHS);
  }
  refuseRealPaths(
    {
      runtimeDir: paths.runtimeDir,
      socketPath: paths.socketPath,
      claudeConfigDir: paths.claudeConfigDir,
    },
    { home },
  );
  refuseOwnerLocations(root, home);
  return root;
}

/** The run root exists as a real folder, is the current user's and is mode 700. */
function requirePrivateRoot(root: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(root);
  } catch {
    throw new Error(MSG_ROOT_NOT_PRIVATE);
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new Error(MSG_ROOT_NOT_PRIVATE);
  }
}

/**
 * Validates one target and returns its resolved path: absolute, NUL-free, strictly inside the
 * run root as text and after symlinks, with no symbolic link on any component below the root,
 * and not in the owner's folders.
 */
function guardTarget(root: string, target: string, home: string): string {
  if (typeof target !== "string" || !isAbsolute(target) || target.includes("\0")) {
    throw new Error(MSG_OUTSIDE_ROOT);
  }
  const absolute = resolve(target);
  if (!isStrictlyInside(root, absolute)) throw new Error(MSG_OUTSIDE_ROOT);
  assertNoSymlinkBelow(root, relative(root, absolute));
  if (!isStrictlyInside(canonicalPath(root), canonicalPath(absolute))) {
    throw new Error(MSG_OUTSIDE_ROOT);
  }
  refuseOwnerLocations(absolute, home);
  return absolute;
}

/** The run root and a function that guards each target against it. */
function guarded(
  paths: RunRootPaths,
  deps: DrillDeps,
): { root: string; check: (target: string) => string } {
  const home = deps.home ?? homedir();
  const root = guardRoot(paths, home, deps.base ?? DEFAULT_RUN_BASE);
  return { root, check: (target) => guardTarget(root, target, home) };
}

/** Creates `dir` (mode 0700) when missing, after the guard; an existing folder is used as is. */
function ensureDir(check: (target: string) => string, dir: string): string {
  const checked = check(dir);
  if (!existsSync(checked)) mkdirSync(checked, { recursive: true, mode: 0o700 });
  // The mode goes on the descriptor of the folder itself, opened without following a final link.
  let fd: number;
  try {
    fd = openSync(
      check(checked),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new Error(MSG_PATH_LINK);
  }
  try {
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
  return checked;
}

/**
 * Writes `text` to `file` through one descriptor: `O_NOFOLLOW`, never truncating, and either
 * `O_EXCL` (a new file) or `O_APPEND` (an existing one). A file with another hard link, or one
 * that is not a plain file, is refused before anything is written or its mode changed; the mode
 * is then set on the descriptor.
 */
function writeThroughDescriptor(
  file: string,
  text: string,
  options: { mode: number; kind: "create" | "append" },
): void {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (options.kind === "create" ? constants.O_EXCL : constants.O_APPEND);
  let fd: number;
  try {
    fd = openSync(file, flags, options.mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(MSG_PATH_LINK);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error(MSG_SHARED_FILE);
    fchmodSync(fd, options.mode);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

// --- permission change --------------------------------------------------------------------

/**
 * Runs `fn` with `target` (a file or folder inside the run root) set to `mode`, and puts the
 * original mode back in a finally block, also when `fn` throws. The guard runs again before the
 * restore, so a link swapped in while `fn` ran is never chmodded through.
 */
/** Targets a `withMode` currently holds, by folded canonical path. */
const heldTargets = new Set<string>();

/** Attaches `restoreError` to `error` without changing what is thrown. */
function attachRestoreError(error: unknown, restoreError: unknown): void {
  if (typeof error !== "object" || error === null) return;
  try {
    Object.defineProperty(error, "restoreError", {
      value: restoreError,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // A frozen error cannot carry it; the original is still what the caller sees.
  }
}

export async function withMode<T>(
  paths: RunRootPaths,
  target: string,
  mode: number,
  fn: () => T | Promise<T>,
  deps: DrillDeps = {},
): Promise<T> {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error(MSG_BAD_MODE);
  const { check } = guarded(paths, deps);
  const checked = check(target);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(checked);
  } catch {
    throw new Error("Refusing a permission change on a path that is not there.");
  }
  if (info.isSymbolicLink()) throw new Error(MSG_PATH_LINK);
  const key = foldedPath(canonicalPath(checked));
  if (heldTargets.has(key)) throw new Error(MSG_ALREADY_HELD);
  heldTargets.add(key);
  const original = info.mode & 0o777;
  // Put the original mode back: the guard runs again and the entry must still be the one that
  // was changed (same device and inode), so a link or a replacement is never chmodded through.
  const restore = (): void => {
    const again = check(checked);
    const now = lstatSync(again);
    if (now.isSymbolicLink()) throw new Error(MSG_PATH_LINK);
    if (now.dev !== info.dev || now.ino !== info.ino) {
      throw new Error("Refusing to restore a mode on a path that was replaced.");
    }
    chmodSync(again, original);
  };
  try {
    chmodSync(checked, mode);
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      try {
        restore();
      } catch (restoreError) {
        // The caller must see what actually went wrong, not the clean-up failure behind it.
        attachRestoreError(error, restoreError);
      }
      throw error;
    }
    restore();
    return result;
  } finally {
    heldTargets.delete(key);
  }
}

// --- throwaway vault ----------------------------------------------------------------------

/** The primary sandbox vaults; a second vault may not take their names. */
const RESERVED_VAULT_NAMES: readonly string[] = ["live", "big"];
const VAULT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Creates `<vaultsDir>/<name>` with an `.obsidian` marker folder, so the service can be set up
 * against it as a second, different vault. Returns the vault path.
 */
export function makeSecondVault(
  paths: RunRootPaths,
  name = "second",
  deps: DrillDeps = {},
): string {
  if (!VAULT_NAME_PATTERN.test(name) || RESERVED_VAULT_NAMES.includes(name)) {
    throw new Error("Refusing a second vault name that is not a plain, unused folder name.");
  }
  const { check } = guarded(paths, deps);
  ensureDir(check, paths.vaultsDir);
  const vault = ensureDir(check, join(paths.vaultsDir, name));
  ensureDir(check, join(vault, ".obsidian"));
  return vault;
}

// --- fake executables ---------------------------------------------------------------------

export type FakeExecutableKind = "claude" | "codex";

/** Letters, digits, space and a few separators: nothing a shell could read as syntax. */
const VERSION_LINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,79}$/;

/**
 * Writes a mode-700 shell script that prints only `versionLine`, whatever it is asked. A fake
 * `claude` goes to `<root>/fake-bin/claude`; a fake `codex` goes to the sandbox candidates
 * folder (`<root>/codex-candidates/codex`) that `CCC_CODEX_CANDIDATES_DIR` names. Returns the
 * script path.
 */
export function writeFakeExecutable(
  paths: RunRootPaths,
  kind: FakeExecutableKind,
  options: { versionLine: string },
  deps: DrillDeps = {},
): string {
  if (kind !== "claude" && kind !== "codex") {
    throw new Error("Refusing a fake executable other than claude or codex.");
  }
  if (typeof options.versionLine !== "string" || !VERSION_LINE_PATTERN.test(options.versionLine)) {
    throw new Error("Refusing a version line that is not plain text.");
  }
  const { root, check } = guarded(paths, deps);
  const directory = kind === "claude" ? join(root, "fake-bin") : paths.codexCandidatesDir;
  ensureDir(check, directory);
  const file = check(join(directory, kind));
  // A fresh file every time: an earlier fake (or a hard link planted in its place) is unlinked,
  // not written through, and the new one is created exclusively without following a link.
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeThroughDescriptor(file, `#!/bin/sh\nprintf '%s\\n' '${options.versionLine}'\n`, {
    mode: 0o700,
    kind: "create",
  });
  return file;
}

// --- spool drops --------------------------------------------------------------------------

/**
 * Appends `bytes` bytes to the sandbox spool's dropped-records file, `<runtimeDir>/spool/
 * hooks.dropped`: the hook writes one byte per record it dropped at the spool cap, so the size
 * is the drop count (D-37). Returns the file path.
 */
export function writeSpoolDrops(paths: RunRootPaths, bytes: number, deps: DrillDeps = {}): string {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_SPOOL_DROP_BYTES) {
    throw new Error("Refusing a drop count that is not a small positive whole number.");
  }
  const { check } = guarded(paths, deps);
  const spool = ensureDir(check, join(paths.runtimeDir, "spool"));
  const file = check(join(spool, "hooks.dropped"));
  writeThroughDescriptor(file, "x".repeat(bytes), { mode: 0o600, kind: "append" });
  return file;
}

// --- hook installer -----------------------------------------------------------------------

export interface HookInstallerArgv {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export interface HookInstallerOptions {
  /** A fake `claude` inside the run root; defaults to `<root>/fake-bin/claude` (may be absent). */
  claudeBin?: string;
}

/**
 * The command that runs the repository's owner-run installer against the scratch Claude config
 * and runtime folders. `--claude-bin` always points inside the run root, so the installer never
 * searches the owner's PATH and never runs the owner's real `claude`. The environment is built
 * from scratch (no inherited HOME or secrets).
 */
export function hookInstallerArgv(
  paths: RunRootPaths,
  options: HookInstallerOptions = {},
  deps: DrillDeps = {},
): HookInstallerArgv {
  const { root, check } = guarded(paths, deps);
  const claudeBin = check(options.claudeBin ?? join(root, "fake-bin", "claude"));
  check(paths.claudeConfigDir);
  check(paths.runtimeDir);
  return {
    file: process.execPath,
    args: [
      join(REPO_ROOT, "scripts", "claude-hooks", "install.mjs"),
      "--claude-config-dir",
      paths.claudeConfigDir,
      "--runtime-dir",
      paths.runtimeDir,
      "--claude-bin",
      claudeBin,
    ],
    env: {
      PATH: FIXED_PATH,
      HOME: paths.tmpDir,
      CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
      CCC_RUNTIME_DIR: paths.runtimeDir,
    },
  };
}

/** Runs the installer once (fixed argv, no shell, 30 second cap). Rejects on any failure. */
export async function runHookInstaller(
  paths: RunRootPaths,
  options: HookInstallerOptions = {},
  deps: DrillDeps = {},
): Promise<void> {
  const command = hookInstallerArgv(paths, options, deps);
  const run = deps.run ?? runFixedArgv;
  try {
    await run(command.file, command.args, {
      env: command.env,
      timeoutMs: deps.timeoutMs ?? DRILL_TIMEOUT_MS,
    });
  } catch {
    throw new Error("The hook installer did not finish successfully in the sandbox.");
  }
}

// --- launcher row seed --------------------------------------------------------------------

/** The two launchers whose stored config is only a bundle id. */
export type SeedLauncher = "antigravity" | "claude-desktop";

export interface SeedLauncherRowInput {
  launcher: SeedLauncher;
  /** Checked against the domain bundle id pattern before it is placed in the statement. */
  bundleId: string;
  /** The caller states that the service fixture is stopped; anything else is refused. */
  fixtureState: "stopped";
}

/**
 * One fixed statement per launcher kind. The only variable part is the bundle id, which has
 * passed the domain pattern (letters, digits, dots, hyphens, at most 255), so it can carry no
 * quote or separator. The timestamp is a constant. The row shape is `launcher_config`
 * (launcher id, config JSON, tested flag, updated-at).
 */
const SEED_STATEMENTS: Record<SeedLauncher, (bundleId: string) => string> = {
  antigravity: (bundleId) =>
    `INSERT OR REPLACE INTO launcher_config (launcher_id, config_json, tested, updated_at) VALUES ('antigravity', '{"bundleId":"${bundleId}"}', 'false', '2000-01-01T00:00:00.000Z');`,
  "claude-desktop": (bundleId) =>
    `INSERT OR REPLACE INTO launcher_config (launcher_id, config_json, tested, updated_at) VALUES ('claude-desktop', '{"bundleId":"${bundleId}"}', 'false', '2000-01-01T00:00:00.000Z');`,
};

/**
 * Seeds one app-launcher row into the STOPPED sandbox store, so the launcher health drill can
 * show a bundle that is not installed (the save route would refuse such a bundle). The target is
 * exactly the run root's own store file, which must already exist, and the write goes through
 * the `sqlite3` command-line tool with an argv array.
 */
export async function seedLauncherRow(
  paths: RunRootPaths,
  input: SeedLauncherRowInput,
  deps: DrillDeps & { fixture: { isRunning(): boolean } },
): Promise<void> {
  // The fixture handle is required: without it nothing shows the service is down, and a service
  // that holds the store open would race the write.
  if (
    input?.fixtureState !== "stopped" ||
    typeof deps?.fixture?.isRunning !== "function" ||
    deps.fixture.isRunning() === true
  ) {
    throw new Error("Refusing to seed a store unless the service fixture is stopped.");
  }
  const statement = Object.hasOwn(SEED_STATEMENTS, input.launcher)
    ? SEED_STATEMENTS[input.launcher]
    : undefined;
  if (statement === undefined) {
    throw new Error("Refusing a launcher other than antigravity or claude-desktop.");
  }
  if (typeof input.bundleId !== "string" || !BundleIdSchema.safeParse(input.bundleId).success) {
    throw new Error("Refusing a bundle id that does not match the bundle id pattern.");
  }
  const { root, check } = guarded(paths, deps);
  if (paths.dbPath !== join(paths.runtimeDir, "operational.db")) {
    throw new Error(MSG_FORGED_PATHS);
  }
  const store = check(paths.dbPath);
  if (!isSameOrInside(root, store) || !existsSync(store) || !statSync(store).isFile()) {
    throw new Error("Refusing to seed: the sandbox store is not present.");
  }
  const run = deps.run ?? runFixedArgv;
  try {
    await run(SQLITE_TOOL, ["-bail", store, statement(input.bundleId)], {
      env: { PATH: FIXED_PATH, LC_ALL: "C" },
      timeoutMs: deps.timeoutMs ?? DRILL_TIMEOUT_MS,
    });
  } catch {
    throw new Error("Seeding the sandbox store did not finish successfully.");
  }
}

// --- process runner -----------------------------------------------------------------------

/**
 * Runs `file` with a fixed argv: no shell, exactly the given environment, an output cap and a
 * deadline after which the child is killed with SIGKILL. Rejects with a plain message for a
 * timeout or a non-zero exit; output is returned only on success and never echoed in an error.
 */
export function runFixedArgv(
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        env: options.env,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ stdout, stderr });
          return;
        }
        const killed = (error as { killed?: boolean }).killed === true;
        reject(
          new Error(
            killed
              ? `The helper process timed out after ${options.timeoutMs} ms and was killed.`
              : "The helper process exited with an error.",
          ),
        );
      },
    );
  });
}
