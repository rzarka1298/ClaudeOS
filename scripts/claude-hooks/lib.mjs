// Shared helpers for the owner-run Claude Code hook package (plan 05-09,
// SESS-01, D-13, ADR-0025). install.mjs, uninstall.mjs and status.mjs are
// thin commands over these functions.
//
// The installer edits a file that decides what Claude Code executes, so every
// helper here is conservative:
//   - it identifies its own entries only by the installed hook path, and never
//     rewrites an entry it did not create (the opt-in status-line wrap aside);
//   - the merge and removal functions are pure, so a dry run shows exactly
//     what a real run would write;
//   - every write is preceded by a timestamped backup and lands atomically.
//
// Node builtins only, plus the repository's own built `@ccc/vault-repo`
// (loaded lazily, fail loud when it is not built).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root: this file lives at scripts/claude-hooks/lib.mjs. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The compiled collectors output the installer copies (PR-08: tsc output, not a bundle). */
export const COLLECTORS_DIST = join(REPO_ROOT, "packages", "collectors", "dist");

/** The compiled hook entry; its presence proves the collectors package is built. */
export const DIST_HOOK_ENTRY = join(COLLECTORS_DIST, "hook", "entry.js");

/** Where atomicWriteFileSync is built. */
const VAULT_REPO_DIST = join(REPO_ROOT, "packages", "vault-repo", "dist", "index.js");

/**
 * The hook events this package subscribes to (D-11 plus D-04's tool events).
 * A literal copy of `KNOWN_HOOK_EVENTS` in `@ccc/domain`: the installer runs
 * without importing the domain package, and a test proves the two are equal.
 */
export const SUBSCRIBED_EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "UserPromptSubmit",
  "PermissionRequest",
  "PermissionDenied",
  "PostModelSwitch",
  "PostToolUse",
  "PostToolUseFailure",
]);

/** The oldest Claude Code whose hook payloads this package is built against (D-12, PR-09). */
export const MIN_CLAUDE_VERSION = "2.1.214";

/** The oldest Node major the compiled hook runs on. */
export const MIN_NODE_MAJOR = 24;

/** The hook timeout written into settings; kept at 5 s so SessionEnd never slows exit. */
export const HOOK_TIMEOUT_SECONDS = 5;

/** The backup suffix; `settings.json.ccc-backup-<UTC timestamp>`. */
export const BACKUP_PREFIX = "settings.json.ccc-backup-";

/** A refusal: the command prints `message` to stderr and exits non-zero, having written nothing. */
export class Refusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

// ---------------------------------------------------------------------------
// Arguments and paths

const VALUE_FLAGS = ["--claude-config-dir", "--runtime-dir", "--claude-bin"];

/**
 * Parses the shared flags. Unknown flags and a value flag with no value are
 * refused. Defaults: `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`, and
 * `CCC_RUNTIME_DIR`, else `$HOME/.claude-command-center`.
 *
 * @param {string[]} argv the arguments after the script path
 * @param {{ booleans?: string[] }} [options] the boolean flags this command accepts
 */
export function parseArgs(argv, options = {}) {
  const booleans = options.booleans ?? [];
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Set<string>} */
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_FLAGS.includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Refusal(`${arg} requires a path argument.`);
      }
      values[arg] = value;
      index += 1;
    } else if (booleans.includes(arg)) {
      flags.add(arg);
    } else {
      throw new Refusal(`unknown argument: ${arg}`);
    }
  }

  const home = process.env.HOME;
  const fromHome = (/** @type {string} */ name) => {
    if (home === undefined || home.length === 0) {
      throw new Refusal("HOME is not set; pass --claude-config-dir and --runtime-dir explicitly.");
    }
    return join(home, name);
  };
  const env = (/** @type {string} */ name) => {
    const value = process.env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
  };

  const claudeConfigDir = resolve(
    values["--claude-config-dir"] ?? env("CLAUDE_CONFIG_DIR") ?? fromHome(".claude"),
  );
  const runtimeDir = resolve(
    values["--runtime-dir"] ?? env("CCC_RUNTIME_DIR") ?? fromHome(".claude-command-center"),
  );
  const claudeBinFlag = values["--claude-bin"];
  return {
    claudeConfigDir,
    runtimeDir,
    settingsPath: join(claudeConfigDir, "settings.json"),
    claudeBin: claudeBinFlag === undefined ? undefined : resolve(claudeBinFlag),
    dryRun: flags.has("--dry-run"),
    withStatusline: flags.has("--with-statusline"),
  };
}

/** The installed-copies root, `<runtime>/hooks`. */
export function hooksDir(/** @type {string} */ runtimeDir) {
  return join(runtimeDir, "hooks");
}

/** The installed hook entry that settings point at. */
export function installedEntryPath(/** @type {string} */ runtimeDir) {
  return join(runtimeDir, "hooks", "hook", "entry.js");
}

/** The installed status-line wrapper. */
export function installedWrapperPath(/** @type {string} */ runtimeDir) {
  return join(runtimeDir, "hooks", "statusline", "wrapper.js");
}

/** The install record the service reads for the version probe and hook-runtime check (05-12). */
export function installRecordPath(/** @type {string} */ runtimeDir) {
  return join(runtimeDir, "hooks", "install.json");
}

/** Where the owner's original status line is kept while the wrapper is installed. */
export function originalStatusLinePath(/** @type {string} */ runtimeDir) {
  return join(runtimeDir, "statusline", "original.json");
}

/** Throws a Refusal unless Node is at least {@link MIN_NODE_MAJOR}. */
export function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= MIN_NODE_MAJOR)) {
    throw new Refusal(
      `node ${process.versions.node} at ${process.execPath} is older than Node ${MIN_NODE_MAJOR}; ` +
        "install Node.js 24 LTS and re-run with it on PATH.",
    );
  }
}

/** Throws a Refusal unless the compiled hook exists. */
export function assertHookBuilt() {
  if (!existsSync(DIST_HOOK_ENTRY)) {
    throw new Refusal(
      `missing build output at ${DIST_HOOK_ENTRY}\n` +
        "Build the hook first, then re-run:\n\n" +
        "  pnpm exec turbo run build --filter=@ccc/collectors --filter=@ccc/vault-repo\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Settings: read, merge, remove, serialize

/**
 * Reads `settings.json`. Returns `{ exists: false }` when there is none.
 * Refuses invalid JSON and any top-level value that is not an object, and a
 * `hooks` value whose shape the installer cannot edit safely.
 *
 * @param {string} settingsPath
 * @returns {{ exists: boolean, text: string, settings: Record<string, any> }}
 */
export function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return { exists: false, text: "", settings: {} };
  const text = readFileSync(settingsPath, "utf8");
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (cause) {
    throw new Refusal(
      `${settingsPath} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "fix it by hand first. Nothing was changed.",
    );
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Refusal(`${settingsPath} is not a JSON object; refusing to edit it.`);
  }
  const hooks = settings.hooks;
  if (hooks !== undefined) {
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
      throw new Refusal(`${settingsPath}: "hooks" is not an object; refusing to edit it.`);
    }
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) {
        throw new Refusal(
          `${settingsPath}: "hooks.${event}" is not an array; refusing to edit it.`,
        );
      }
    }
  }
  return { exists: true, text, settings };
}

/** Two-space JSON with a trailing newline: the one serialization every write uses. */
export function serializeSettings(/** @type {unknown} */ settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * True when `handler` is one of this package's hook handlers for `runtimeDir`:
 * its first argument points into `<runtime>/hooks/`. Nothing else identifies
 * an entry as ours, so a foreign hook is never touched.
 */
export function isOurHandler(/** @type {unknown} */ handler, /** @type {string} */ runtimeDir) {
  if (typeof handler !== "object" || handler === null) return false;
  const args = /** @type {{ args?: unknown }} */ (handler).args;
  if (!Array.isArray(args) || typeof args[0] !== "string") return false;
  return args[0].startsWith(`${hooksDir(runtimeDir)}/`);
}

/** True when a matcher group holds at least one of our handlers. */
function groupHasOurs(/** @type {any} */ group, /** @type {string} */ runtimeDir) {
  return (
    typeof group === "object" &&
    group !== null &&
    Array.isArray(group.hooks) &&
    group.hooks.some((/** @type {unknown} */ handler) => isOurHandler(handler, runtimeDir))
  );
}

/**
 * Removes our handlers from one event's groups. A group left with no handler
 * by our removal is dropped; every other group comes back as the same object.
 * Returns the new list and the index where the first of ours sat (or -1).
 */
function withoutOurs(/** @type {any[]} */ groups, /** @type {string} */ runtimeDir) {
  /** @type {any[]} */
  const kept = [];
  let firstIndex = -1;
  for (const group of groups) {
    if (!groupHasOurs(group, runtimeDir)) {
      kept.push(group);
      continue;
    }
    if (firstIndex === -1) firstIndex = kept.length;
    const remaining = group.hooks.filter(
      (/** @type {unknown} */ handler) => !isOurHandler(handler, runtimeDir),
    );
    if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
  }
  return { kept, firstIndex };
}

/** The single handler this package writes for every event (D-05, exec form). */
export function ourHandler(
  /** @type {string} */ entryPath,
  /** @type {string} */ nodePath,
  /** @type {string} */ runtimeDir,
) {
  return {
    type: "command",
    command: nodePath,
    args: [entryPath, "--runtime-dir", runtimeDir],
    async: true,
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

/**
 * Pure: returns a copy of `settings` in which every subscribed event holds
 * exactly one of our matcher groups (no matcher, so every tool and every
 * notification type is covered). An existing group of ours is replaced where
 * it stands, so a re-install is byte-identical; a new one is appended after
 * the owner's groups. Every other key keeps its value and its position.
 *
 * @param {Record<string, any>} settings
 * @param {string} entryPath
 * @param {string} nodePath
 * @param {string} runtimeDir
 */
export function mergeHooks(settings, entryPath, nodePath, runtimeDir) {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of SUBSCRIBED_EVENTS) {
    const { kept, firstIndex } = withoutOurs(hooks[event] ?? [], runtimeDir);
    const group = { hooks: [ourHandler(entryPath, nodePath, runtimeDir)] };
    const at = firstIndex === -1 ? kept.length : firstIndex;
    hooks[event] = [...kept.slice(0, at), group, ...kept.slice(at)];
  }
  return { ...settings, hooks };
}

/**
 * Pure: returns a copy of `settings` with every one of our handlers removed,
 * across every event (not only the subscribed ones, so an older install's
 * leftovers go too). An event key is dropped only when our removal emptied
 * it, and `hooks` only when that emptied it.
 *
 * @param {Record<string, any>} settings
 * @param {string} runtimeDir
 */
export function removeOurHooks(settings, runtimeDir) {
  if (settings.hooks === undefined) return { ...settings };
  const hooks = { ...settings.hooks };
  let removedAny = false;
  for (const [event, groups] of Object.entries(hooks)) {
    const { kept, firstIndex } = withoutOurs(groups, runtimeDir);
    if (firstIndex === -1) continue;
    removedAny = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removedAny && Object.keys(hooks).length === 0) {
    const { hooks: _dropped, ...rest } = settings;
    return rest;
  }
  return { ...settings, hooks };
}

/** Events that currently hold at least one of our handlers. */
export function ourEvents(
  /** @type {Record<string, any>} */ settings,
  /** @type {string} */ runtimeDir,
) {
  const hooks = settings.hooks ?? {};
  return Object.keys(hooks).filter((event) =>
    (hooks[event] ?? []).some((/** @type {any} */ group) => groupHasOurs(group, runtimeDir)),
  );
}

/** The first of our handlers found, or undefined. */
export function findOurHandler(
  /** @type {Record<string, any>} */ settings,
  /** @type {string} */ runtimeDir,
) {
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups) {
      if (!groupHasOurs(group, runtimeDir)) continue;
      return group.hooks.find((/** @type {unknown} */ handler) =>
        isOurHandler(handler, runtimeDir),
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Diff

/**
 * A unified line diff (three lines of context) between two texts, for
 * `--dry-run`. Settings files are small, so a plain LCS table is fine.
 * Returns "" when the texts are equal.
 *
 * @param {string} before
 * @param {string} after
 * @param {{ fromLabel?: string, toLabel?: string }} [labels]
 */
export function lineDiff(before, after, labels = {}) {
  if (before === after) return "";
  const a = before.length === 0 ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.length === 0 ? [] : after.replace(/\n$/, "").split("\n");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  /** @type {Array<{ op: " " | "-" | "+", text: string, ai: number, bi: number }>} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", text: a[i], ai: i, bi: j });
      i += 1;
      j += 1;
    } else if (
      j < b.length &&
      (i === a.length || lcs[i * cols + j + 1] >= lcs[(i + 1) * cols + j])
    ) {
      ops.push({ op: "+", text: b[j], ai: i, bi: j });
      j += 1;
    } else {
      ops.push({ op: "-", text: a[i], ai: i, bi: j });
      i += 1;
    }
  }

  const context = 3;
  const changed = [];
  for (let index = 0; index < ops.length; index += 1)
    if (ops[index].op !== " ") changed.push(index);
  // Group changes whose gap is small enough that their context would overlap.
  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const index of changed) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && index - last[1] <= context * 2 + 1) last[1] = index;
    else ranges.push([index, index]);
  }
  const lines = [`--- ${labels.fromLabel ?? "before"}`, `+++ ${labels.toLabel ?? "after"}`];
  for (const [first, last] of ranges) {
    const hunk = ops.slice(Math.max(0, first - context), Math.min(ops.length, last + context + 1));
    const aCount = hunk.filter((op) => op.op !== "+").length;
    const bCount = hunk.filter((op) => op.op !== "-").length;
    const aStart = hunk[0].ai + (aCount === 0 ? 0 : 1);
    const bStart = hunk[0].bi + (bCount === 0 ? 0 : 1);
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) lines.push(`${op.op}${op.text}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Writes

/** A sortable UTC stamp, e.g. 20260929T052341123Z. */
function stamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

/** The backups next to `settingsPath`, newest first. */
export function listBackups(/** @type {string} */ settingsPath) {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

/**
 * Copies the current settings bytes to `settings.json.ccc-backup-<stamp>`
 * (0600, never overwriting an earlier backup). Returns the backup path, or
 * undefined when there was no settings file to back up.
 */
export function backupSettings(/** @type {string} */ settingsPath) {
  if (!existsSync(settingsPath)) return undefined;
  const base = join(dirname(settingsPath), `${BACKUP_PREFIX}${stamp()}`);
  let target = base;
  for (let n = 1; existsSync(target); n += 1) target = `${base}-${n}`;
  writeFileSync(target, readFileSync(settingsPath), { mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  return target;
}

/** @type {((path: string, content: string) => void) | undefined} */
let atomicWrite;

async function loadAtomicWrite() {
  if (atomicWrite !== undefined) return atomicWrite;
  if (!existsSync(VAULT_REPO_DIST)) {
    throw new Refusal(
      `missing build output at ${VAULT_REPO_DIST}\n` +
        "Build it first, then re-run:\n\n" +
        "  pnpm exec turbo run build --filter=@ccc/collectors --filter=@ccc/vault-repo\n",
    );
  }
  const module = await import(pathToFileURL(VAULT_REPO_DIST).href);
  atomicWrite = module.atomicWriteFileSync;
  if (typeof atomicWrite !== "function") {
    throw new Refusal(`${VAULT_REPO_DIST} does not export atomicWriteFileSync; rebuild it.`);
  }
  return atomicWrite;
}

/**
 * Backs the current file up, then replaces it atomically (temp file in the
 * same directory, fsync, rename) with `text`. A symlinked settings file is
 * followed, so the link survives and its target is what changes. The file's
 * permission bits are kept; a new file is created 0600.
 *
 * @param {string} settingsPath
 * @param {string} text
 * @returns {Promise<string | undefined>} the backup path
 */
export async function writeSettingsAtomic(settingsPath, text) {
  const write = await loadAtomicWrite();
  const exists = existsSync(settingsPath);
  const target = exists ? realpathSync(settingsPath) : settingsPath;
  const keepMode = exists ? statSync(target).mode & 0o777 : 0o600;
  const backup = backupSettings(settingsPath);
  write(target, text);
  chmodSync(target, keepMode);
  return backup;
}

/**
 * Creates `dir` (recursively) and forces it to 0700, repairing wider bits on
 * an existing directory.
 */
export function ensurePrivateDir(/** @type {string} */ dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Copies the compiled `.js` files of `distDir` (never `*.test.js`, never
 * maps or declarations) into `destDir`, swapped in whole: the new copy is
 * built beside the old one and renamed into place, so a hook firing during a
 * re-install never sees a half-copied directory. Directories 0700, files 0600.
 *
 * @param {string} distDir
 * @param {string} destDir
 * @returns {string[]} the copied file names
 */
export function copyHookFiles(distDir, destDir) {
  const names = readdirSync(distDir)
    .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
    .sort();
  const parent = dirname(destDir);
  ensurePrivateDir(parent);
  const staging = `${destDir}.new`;
  const retired = `${destDir}.old`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(retired, { recursive: true, force: true });
  ensurePrivateDir(staging);
  for (const name of names) {
    const target = join(staging, name);
    copyFileSync(join(distDir, name), target);
    chmodSync(target, 0o600);
  }
  if (existsSync(destDir)) renameSync(destDir, retired);
  renameSync(staging, destDir);
  rmSync(retired, { recursive: true, force: true });
  return names;
}

/**
 * Installs the compiled hook and status-line files under `<runtime>/hooks`,
 * plus a `package.json` declaring ES modules, so Node never has to guess the
 * module type from whatever `package.json` sits above the runtime dir.
 *
 * @param {string} runtimeDir
 */
export function installHookFiles(runtimeDir) {
  ensurePrivateDir(runtimeDir);
  const root = hooksDir(runtimeDir);
  ensurePrivateDir(root);
  const hook = copyHookFiles(join(COLLECTORS_DIST, "hook"), join(root, "hook"));
  const statusline = copyHookFiles(join(COLLECTORS_DIST, "statusline"), join(root, "statusline"));
  writePrivateFile(join(root, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  return { hook, statusline };
}

/** Writes `text` to `path` with mode 0600 (replacing any existing file). */
export function writePrivateFile(/** @type {string} */ path, /** @type {string} */ text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * The sha256 of every installable `.js` file, keyed "hook/entry.js" etc.
 * @param {string} root a directory holding `hook/` and `statusline/`
 */
export function hashHookFiles(root) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const sub of ["hook", "statusline"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
      hashes[`${sub}/${name}`] = createHash("sha256")
        .update(readFileSync(join(dir, name)))
        .digest("hex");
    }
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// Claude Code version

/** Finds an executable `name` on PATH, or undefined. */
export function whichOnPath(/** @type {string} */ name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Compares dotted numeric versions: negative, zero or positive. */
export function compareVersions(/** @type {string} */ left, /** @type {string} */ right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Runs `<bin> --version` (5 s timeout) and parses "X.Y.Z (Claude Code)".
 * Returns `{ version: null, reason }` when the binary is missing, fails or
 * prints something else: the version is then unknown, never guessed.
 *
 * @param {string | undefined} bin
 * @returns {{ version: string | null, reason?: string }}
 */
export function probeClaudeVersion(bin) {
  if (bin === undefined) return { version: null, reason: "no claude binary on PATH" };
  if (!existsSync(bin)) return { version: null, reason: `${bin} does not exist` };
  let output;
  try {
    output = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { version: null, reason: `${bin} --version failed` };
  }
  const match = /^\s*(\d+\.\d+\.\d+)\s+\(Claude Code\)/.exec(output);
  if (match === null)
    return { version: null, reason: `${bin} --version printed no Claude Code version` };
  return { version: match[1] };
}

/** True when `version` meets {@link MIN_CLAUDE_VERSION}. */
export function isSupportedClaudeVersion(/** @type {string} */ version) {
  return compareVersions(version, MIN_CLAUDE_VERSION) >= 0;
}

/**
 * Runs a command's `main`, turning a Refusal into "<name>: <message>" on
 * stderr and exit code 1; anything else is a crash with exit code 2.
 *
 * @param {string} name
 * @param {() => Promise<void> | void} main
 */
export async function runCommand(name, main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`${name}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `${name}: unexpected failure: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
