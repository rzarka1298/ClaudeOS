// Shared helpers for the owner-run Codex hook package (plan 05.1-24, CODEX-06,
// D-19). install.mjs, uninstall.mjs and status.mjs are thin commands over
// these functions. They mirror scripts/claude-hooks (merge-only, backup before
// every write, atomic landing, dry-run diff, byte-identical re-install,
// exact-bytes restore) and differ where Codex differs: the hooks file is
// hooks.json, a handler's command is ONE string that a login shell parses, and
// trust in a new hook is granted only by the owner, on Codex's own screen.
//
// The installer edits ONE file that decides what Codex executes, so every
// helper here is conservative:
//   - it identifies its own handlers only by the exact installed entry path
//     and runtime directory inside the quoted command, and never rewrites an
//     entry it did not create;
//   - the merge and removal functions are pure, so a dry run shows exactly what
//     a real run would write;
//   - every write is preceded by a timestamped backup and lands atomically;
//   - nothing here opens Codex's configuration, its notify setting or its trust
//     state. Those belong to Codex and to another client on the owner's machine
//     (T-05.1-09); a test records every path the scripts write and scans their
//     sources to prove it.
//
// Node builtins only, plus generic helpers imported (not copied) from the
// Claude hook installer's lib.

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNodeVersion,
  assertPrivateOrAbsent,
  ensurePrivateDir,
  lineDiff,
  Refusal,
  runCommand,
  shellQuote,
  writePrivateFile,
} from "../claude-hooks/lib.mjs";

export {
  assertNodeVersion,
  assertPrivateOrAbsent,
  ensurePrivateDir,
  lineDiff,
  Refusal,
  runCommand,
  shellQuote,
  writePrivateFile,
};

/** The repository root: this file lives at scripts/codex-hooks/lib.mjs. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The compiled collectors output the installer copies (tsc output, not a bundle). */
export const COLLECTORS_DIST = join(REPO_ROOT, "packages", "collectors", "dist");

/** The build command a refusal prints when the compiled hook is missing. */
export const BUILD_COMMAND = "pnpm exec turbo run build --filter=@ccc/collectors";

/**
 * The hook events this package subscribes to (research R1: lifecycle only, no
 * per-tool events). A literal copy of `CODEX_HOOK_EVENTS` in `@ccc/domain`: the
 * installer runs without importing the domain package, and a test proves the
 * two are equal.
 */
export const SUBSCRIBED_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "SessionEnd",
]);

/** The oldest Node major the compiled hook runs on. */
export const MIN_NODE_MAJOR = 24;

/** Timeout (seconds) for the asynchronous handlers; they never block Codex. */
export const ASYNC_TIMEOUT_SECONDS = 5;

/**
 * Timeout (seconds) for SessionEnd, the one event Codex runs synchronously
 * (documented default 1 s, maximum 3 s): short, so Codex exit is never slowed.
 */
export const SESSION_END_TIMEOUT_SECONDS = 3;

/** The one hooks file this package may write inside the Codex home. */
export const HOOKS_FILE_NAME = "hooks.json";

/** The backup name prefix; `hooks.json.ccc-backup-<UTC timestamp>`. */
export const BACKUP_PREFIX = "hooks.json.ccc-backup-";

/** The temp-file prefix of an atomic write; renamed over the hooks file. */
export const TEMP_PREFIX = ".hooks.json.ccc-tmp-";

/** Written as `description` only when this package creates the hooks file. */
export const FILE_DESCRIPTION = "Hooks added by the Claude Command Center hook package.";

/** Printed last after an install: trust is the owner's step, never the installer's. */
export const TRUST_REMINDER =
  "Next, in Codex: type /hooks and trust the new hook. Codex skips a hook until you do.";

/** The files that make up the installed layout, relative to `<runtime>/codex-hooks`. */
export const INSTALLED_FILES = Object.freeze([
  "codex-hook/entry.js",
  "codex-hook/limits.js",
  "codex-hook/minimize.js",
  "hook/deliver.js",
  "hook/limits.js",
  "package.json",
]);

/** The shared modules the Codex entry imports from `../hook/`; nothing else of `dist/hook` is copied. */
const SHARED_HOOK_FILES = Object.freeze(["deliver.js", "limits.js"]);

// ---------------------------------------------------------------------------
// Arguments and paths

const VALUE_FLAGS = ["--codex-home", "--runtime-dir"];

/**
 * Parses the shared flags. Unknown flags and a value flag with no value are
 * refused. Defaults: `CODEX_HOME`, else `$HOME/.codex`, and `CCC_RUNTIME_DIR`,
 * else `$HOME/.claude-command-center`.
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
      throw new Refusal("HOME is not set; pass --codex-home and --runtime-dir explicitly.");
    }
    return join(home, name);
  };
  const env = (/** @type {string} */ name) => {
    const value = process.env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
  };

  const codexHome = resolve(values["--codex-home"] ?? env("CODEX_HOME") ?? fromHome(".codex"));
  const runtimeDir = resolve(
    values["--runtime-dir"] ?? env("CCC_RUNTIME_DIR") ?? fromHome(".claude-command-center"),
  );
  return {
    codexHome,
    runtimeDir,
    hooksPath: join(codexHome, HOOKS_FILE_NAME),
    dryRun: flags.has("--dry-run"),
  };
}

/** The installed-copies root, `<runtime>/codex-hooks`. */
export function codexHooksDir(/** @type {string} */ runtimeDir) {
  return join(runtimeDir, "codex-hooks");
}

/** The installed hook entry that the hooks file points at. */
export function installedEntryPath(/** @type {string} */ runtimeDir) {
  return join(codexHooksDir(runtimeDir), "codex-hook", "entry.js");
}

/** The ES module marker, the last file an install writes (the service reads its time). */
export function installedMarkerPath(/** @type {string} */ runtimeDir) {
  return join(codexHooksDir(runtimeDir), "package.json");
}

/** Throws a Refusal unless the compiled hook and the two shared modules it imports exist. */
export function assertHookBuilt() {
  const needed = [
    join(COLLECTORS_DIST, "codex-hook", "entry.js"),
    ...SHARED_HOOK_FILES.map((name) => join(COLLECTORS_DIST, "hook", name)),
  ];
  const missing = needed.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Refusal(
      `missing build output: ${missing.join(", ")}\n` +
        "Build the hook first, then re-run:\n\n" +
        `  ${BUILD_COMMAND}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// The command string a login shell parses

/**
 * The handler command: the node binary, the installed entry and the runtime
 * directory, each POSIX single-quoted (T-05.1-01). Codex hands this string to
 * `$SHELL -lc`, so an unquoted path with a space or a `;` would be an
 * injection point.
 */
export function hookCommand(
  /** @type {string} */ nodePath,
  /** @type {string} */ entryPath,
  /** @type {string} */ runtimeDir,
) {
  return [
    shellQuote(nodePath),
    shellQuote(entryPath),
    "--runtime-dir",
    shellQuote(runtimeDir),
  ].join(" ");
}

/** Characters allowed OUTSIDE quotes in a command we recognise; anything else means it is not ours. */
const BARE_WORD_CHARACTER = /^[A-Za-z0-9_./:=@%+,-]$/;

/**
 * Splits a command string the way a POSIX shell would for the only forms this
 * package writes: bare words, single-quoted segments, and a backslash-escaped
 * character (the `'\''` idiom). Returns null for anything else (double quotes,
 * variables, operators, an unterminated quote), so a foreign command is never
 * mistaken for ours.
 *
 * @param {string} command
 * @returns {string[] | null}
 */
export function splitShellWords(command) {
  /** @type {string[]} */
  const words = [];
  /** @type {string | null} */
  let current = null;
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) return null;
      current = (current ?? "") + command.slice(index + 1, end);
      index = end + 1;
    } else if (char === "\\") {
      if (index + 1 >= command.length) return null;
      current = (current ?? "") + command[index + 1];
      index += 2;
    } else if (char === " " || char === "\t") {
      if (current !== null) words.push(current);
      current = null;
      index += 1;
    } else if (BARE_WORD_CHARACTER.test(char)) {
      current = (current ?? "") + char;
      index += 1;
    } else {
      return null;
    }
  }
  if (current !== null) words.push(current);
  return words;
}

/**
 * True when `handler` is one of this package's handlers for `runtimeDir`: a
 * command handler whose command splits into exactly four words, the second
 * being the exact installed entry path, followed by `--runtime-dir` and the
 * exact runtime directory. A foreign hook that merely mentions our directory
 * name, or another install's runtime directory, is never ours.
 */
export function isOurHandler(/** @type {unknown} */ handler, /** @type {string} */ runtimeDir) {
  if (typeof handler !== "object" || handler === null) return false;
  const candidate = /** @type {{ type?: unknown, command?: unknown }} */ (handler);
  if (candidate.type !== "command" || typeof candidate.command !== "string") return false;
  const words = splitShellWords(candidate.command);
  return (
    words !== null &&
    words.length === 4 &&
    words[1] === installedEntryPath(runtimeDir) &&
    words[2] === "--runtime-dir" &&
    words[3] === runtimeDir
  );
}

// ---------------------------------------------------------------------------
// Hooks file: read, merge, remove, serialize

/**
 * Reads `hooks.json`. Returns `{ exists: false }` when there is none. Refuses a
 * directory, a dangling link, invalid JSON, a top-level value that is not an
 * object, and a `hooks` value whose shape the installer cannot edit safely.
 *
 * @param {string} hooksPath
 * @returns {{ exists: boolean, text: string, doc: Record<string, any> }}
 */
export function readHooks(hooksPath) {
  if (!existsSync(hooksPath)) {
    if (lstatOrUndefined(hooksPath) !== undefined) {
      throw new Refusal(`${hooksPath} is a link to a missing file; refusing to replace it.`);
    }
    return { exists: false, text: "", doc: {} };
  }
  if (statSync(hooksPath).isDirectory()) {
    throw new Refusal(`${hooksPath} is a directory, not a hooks file; refusing to edit it.`);
  }
  const text = readFileSync(hooksPath, "utf8");
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (cause) {
    throw new Refusal(
      `${hooksPath} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "fix it by hand first. Nothing was changed.",
    );
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Refusal(`${hooksPath} is not a JSON object; refusing to edit it.`);
  }
  const hooks = doc.hooks;
  if (hooks !== undefined) {
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
      throw new Refusal(`${hooksPath}: "hooks" is not an object; refusing to edit it.`);
    }
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) {
        throw new Refusal(`${hooksPath}: "hooks.${event}" is not an array; refusing to edit it.`);
      }
    }
  }
  return { exists: true, text, doc };
}

function lstatOrUndefined(/** @type {string} */ path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Two-space JSON with a trailing newline: the one serialization every write uses. */
export function serializeHooks(/** @type {unknown} */ doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
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

/**
 * The single handler this package writes for an event: asynchronous with a
 * short timeout, except SessionEnd, which Codex always runs synchronously and
 * which gets the shorter timeout and no async flag.
 */
export function ourHandler(/** @type {string} */ event, /** @type {string} */ command) {
  if (event === "SessionEnd") {
    return { type: "command", command, timeout: SESSION_END_TIMEOUT_SECONDS };
  }
  return { type: "command", command, timeout: ASYNC_TIMEOUT_SECONDS, async: true };
}

/**
 * Pure: returns a copy of `doc` in which every subscribed event holds exactly
 * one of our matcher groups (no matcher, so every session is covered). An
 * existing group of ours is replaced where it stands, so a re-install is
 * byte-identical; a new one is appended after the owner's groups. Every other
 * key keeps its value and its position. A completely empty document gets the
 * `description` key first; the file's only other top-level key is `hooks`, and
 * Codex rejects any unknown one.
 *
 * @param {Record<string, any>} doc
 * @param {string} entryPath
 * @param {string} nodePath
 * @param {string} runtimeDir
 */
export function mergeHooks(doc, entryPath, nodePath, runtimeDir) {
  const command = hookCommand(nodePath, entryPath, runtimeDir);
  const hooks = { ...(doc.hooks ?? {}) };
  for (const event of SUBSCRIBED_EVENTS) {
    const { kept, firstIndex } = withoutOurs(hooks[event] ?? [], runtimeDir);
    const group = { hooks: [ourHandler(event, command)] };
    const at = firstIndex === -1 ? kept.length : firstIndex;
    hooks[event] = [...kept.slice(0, at), group, ...kept.slice(at)];
  }
  const base = Object.keys(doc).length === 0 ? { description: FILE_DESCRIPTION } : doc;
  return { ...base, hooks };
}

/**
 * Pure: returns a copy of `doc` with every one of our handlers removed, across
 * every event. An event key is dropped only when our removal emptied it, and
 * `hooks` only when that emptied it.
 *
 * @param {Record<string, any>} doc
 * @param {string} runtimeDir
 */
export function removeOurHooks(doc, runtimeDir) {
  if (doc.hooks === undefined) return { ...doc };
  const hooks = { ...doc.hooks };
  let removedAny = false;
  for (const [event, groups] of Object.entries(hooks)) {
    const { kept, firstIndex } = withoutOurs(groups, runtimeDir);
    if (firstIndex === -1) continue;
    removedAny = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removedAny && Object.keys(hooks).length === 0) {
    const { hooks: _dropped, ...rest } = doc;
    return rest;
  }
  return { ...doc, hooks };
}

/** Events that currently hold at least one of our handlers. */
export function ourEvents(
  /** @type {Record<string, any>} */ doc,
  /** @type {string} */ runtimeDir,
) {
  const hooks = doc.hooks ?? {};
  return Object.keys(hooks).filter((event) =>
    (hooks[event] ?? []).some((/** @type {any} */ group) => groupHasOurs(group, runtimeDir)),
  );
}

/**
 * True when `doc` is exactly what an install into an absent hooks file leaves
 * after our handlers are removed: nothing but our description. Only then may
 * uninstall delete the file (it holds nothing of the owner's).
 */
export function isCreatedShapeOnly(/** @type {Record<string, any>} */ doc) {
  const keys = Object.keys(doc);
  return keys.length === 1 && keys[0] === "description" && doc.description === FILE_DESCRIPTION;
}

// ---------------------------------------------------------------------------
// Writes

/** A sortable UTC stamp, e.g. 20260929T052341123Z. */
function stamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

/** The backups next to `hooksPath`, newest first. */
export function listBackups(/** @type {string} */ hooksPath) {
  const dir = dirname(hooksPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

/**
 * Copies the current hooks bytes to `hooks.json.ccc-backup-<stamp>` (0600,
 * never overwriting an earlier backup). Returns the backup path, or undefined
 * when there was no hooks file to back up.
 */
export function backupHooks(/** @type {string} */ hooksPath) {
  if (!existsSync(hooksPath)) return undefined;
  const base = join(dirname(hooksPath), `${BACKUP_PREFIX}${stamp()}`);
  let target = base;
  for (let n = 1; existsSync(target); n += 1) target = `${base}-${n}`;
  writeFileSync(target, readFileSync(hooksPath), { mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  return target;
}

/**
 * Refuses when `hooksPath` no longer holds what was read at the start of the
 * run (`read` from {@link readHooks}): someone changed it in between, and
 * writing the merge computed from the old bytes would silently discard their
 * edit.
 *
 * @param {string} hooksPath
 * @param {{ exists: boolean, text: string }} read
 */
export function assertHooksUnchanged(hooksPath, read) {
  const exists = existsSync(hooksPath);
  const text = exists ? readFileSync(hooksPath, "utf8") : "";
  if (exists !== read.exists || text !== read.text) {
    throw new Refusal(
      `${hooksPath} changed while the installer was running; refusing to overwrite that edit. ` +
        "Re-run to merge against the current file. hooks.json was not written.",
    );
  }
}

/**
 * Refuses a hooks file (or its directory, for a new file) the owner cannot
 * write, so a refusal comes before the first write, not halfway through.
 *
 * @param {string} hooksPath
 */
export function assertWritable(hooksPath) {
  try {
    if (existsSync(hooksPath)) {
      const target = realpathSync(hooksPath);
      accessSync(target, constants.W_OK);
      accessSync(dirname(target), constants.W_OK);
    } else {
      accessSync(dirname(hooksPath), constants.W_OK);
    }
  } catch {
    throw new Refusal(`${hooksPath} (or its folder) is not writable; nothing was changed.`);
  }
}

/**
 * Backs the current file up, then replaces it atomically (temp file in the same
 * directory, fsync, rename) with `text`. A symlinked hooks file is followed, so
 * the link survives and its target is what changes. The file's permission bits
 * are kept; a new file is created 0600.
 *
 * `read` is what the run read at its start: the file is re-read right before
 * the write and the write refused if it changed.
 *
 * @param {string} hooksPath
 * @param {string} text
 * @param {{ exists: boolean, text: string }} read
 * @returns {string | undefined} the backup path
 */
export function writeHooksAtomic(hooksPath, text, read) {
  assertHooksUnchanged(hooksPath, read);
  const exists = existsSync(hooksPath);
  const target = exists ? realpathSync(hooksPath) : hooksPath;
  const keepMode = exists ? statSync(target).mode & 0o777 : 0o600;
  const backup = backupHooks(hooksPath);
  const temp = join(
    dirname(target),
    `${TEMP_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temp, keepMode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return backup;
}

/**
 * Deletes a hooks file that holds nothing but what this package created, after
 * a backup of its bytes. A symlinked file is never deleted (returns false): the
 * caller writes the normalized text instead.
 *
 * @param {string} hooksPath
 * @param {{ exists: boolean, text: string }} read
 * @returns {{ deleted: boolean, backup: string | undefined }}
 */
export function deleteHooksFile(hooksPath, read) {
  assertHooksUnchanged(hooksPath, read);
  if (lstatOrUndefined(hooksPath)?.isSymbolicLink() === true) {
    return { deleted: false, backup: undefined };
  }
  const backup = backupHooks(hooksPath);
  rmSync(hooksPath, { force: true });
  return { deleted: true, backup };
}

/**
 * The exact bytes of the newest backup whose content serializes identically to
 * `doc`, or undefined. Uninstall writes these instead of re-serializing, so
 * undoing an install returns the owner's file byte for byte, formatting
 * included. Unreadable or invalid backups are skipped.
 *
 * @param {string} hooksPath
 * @param {Record<string, unknown>} doc
 */
export function matchingBackupText(hooksPath, doc) {
  const wanted = serializeHooks(doc);
  for (const backup of listBackups(hooksPath)) {
    try {
      const text = readFileSync(backup, "utf8");
      if (serializeHooks(JSON.parse(text)) === wanted) return text;
    } catch {
      // not a usable backup
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The installed copy

/**
 * Installs the compiled Codex hook under `<runtime>/codex-hooks`: `codex-hook/`
 * (every non-test .js file), `hook/` (only the two shared modules the entry
 * imports) and a `package.json` declaring ES modules, written last, so Node
 * resolves the relative import and never guesses the module type from some
 * package.json above the runtime directory. The whole tree is built beside the
 * old one and renamed into place, so a hook firing during a re-install never
 * sees a half-copied directory. Directories 0700, files 0600.
 *
 * @param {string} runtimeDir
 * @returns {string[]} the installed files, relative to the installed root
 */
export function installHookFiles(runtimeDir) {
  ensurePrivateDir(runtimeDir);
  const root = codexHooksDir(runtimeDir);
  const staging = `${root}.new`;
  const retired = `${root}.old`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(retired, { recursive: true, force: true });
  ensurePrivateDir(staging);

  const codexHookDir = join(COLLECTORS_DIST, "codex-hook");
  /** @type {Array<[string, string[]]>} */
  const plan = [
    [
      "codex-hook",
      readdirSync(codexHookDir)
        .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
        .sort(),
    ],
    ["hook", [...SHARED_HOOK_FILES]],
  ];
  /** @type {string[]} */
  const installed = [];
  for (const [sub, names] of plan) {
    ensurePrivateDir(join(staging, sub));
    for (const name of names) {
      const target = join(staging, sub, name);
      copyFileSync(join(COLLECTORS_DIST, sub, name), target);
      chmodSync(target, 0o600);
      installed.push(`${sub}/${name}`);
    }
  }
  writePrivateFile(
    join(staging, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );
  installed.push("package.json");

  if (existsSync(root)) renameSync(root, retired);
  renameSync(staging, root);
  rmSync(retired, { recursive: true, force: true });
  return installed;
}

/**
 * Deletes the installed copies (and any leftover staging or retired tree).
 * Called last by uninstall, so no hooks entry ever points at a missing file.
 *
 * @param {string} runtimeDir
 */
export function removeHookFiles(runtimeDir) {
  const root = codexHooksDir(runtimeDir);
  for (const path of [root, `${root}.new`, `${root}.old`]) {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Which of the installed files are present as regular files (never links).
 * Reads only the runtime directory.
 *
 * @param {string} runtimeDir
 * @returns {{ present: string[], missing: string[] }}
 */
export function inspectInstalledFiles(runtimeDir) {
  const root = codexHooksDir(runtimeDir);
  /** @type {string[]} */
  const present = [];
  /** @type {string[]} */
  const missing = [];
  for (const name of INSTALLED_FILES) {
    const stats = lstatOrUndefined(join(root, name));
    if (stats?.isFile() === true) present.push(name);
    else missing.push(name);
  }
  return { present, missing };
}
