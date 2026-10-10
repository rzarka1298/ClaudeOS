import type * as FsModule from "node:fs";
import type * as FsPromisesModule from "node:fs/promises";

/**
 * A recording wrapper for the file-system modules (plan 05.1-29, CODEX-09).
 *
 * `createFsRecorder()` returns an object whose `mockFs` and `mockFsPromises` take the ACTUAL
 * `node:fs` / `node:fs/promises` module and return a module of the same shape in which every
 * path-taking function calls through to the real one after appending `{ fn, path, realpath }` to
 * a list. Nothing about file CONTENTS is ever recorded. It is installed with the test runner's
 * module mocking in the canary file, so every import of `node:fs` or `node:fs/promises` in the
 * composed module graph (every service part, every workspace package the vite pipeline inlines)
 * goes through it:
 *
 *   vi.mock("node:fs", async (importActual) => {
 *     const { sharedFsRecorder } = await import("../test-support/fs-recorder.js");
 *     return sharedFsRecorder().mockFs(await importActual());
 *   });
 *
 * WHAT IT CANNOT SEE. A native binding opens its own files without going through Node's `fs`
 * (the SQLite binding reading the Codex thread store), and a child process opens whatever it
 * likes. Those are covered by OTHER layers, which the canary asserts together with this one:
 * the CODEX_HOME port's own access record (`recordingFs`, every file the port is asked to touch),
 * the recording database opener (`recordingOpener`, every path handed to the SQLite binding),
 * the fake codex's log (argv, environment key names and working directory of every child), and
 * the allowlist test of plan 05.1-14 plus the source backstop (rule 16) for the static layer.
 * Dependencies the pipeline leaves external (the pino file destination) use their own `fs` and
 * are likewise outside this layer; their output is read back and scanned for sentinels instead.
 *
 * The recorder must not import `node:fs` itself (it would be wrapped by its own mock): the real
 * module arrives as an argument and is kept for the `realpath` lookups, which are never recorded.
 */

export interface FsAccess {
  /** The function name, e.g. `readFileSync`, `promises.stat`. */
  readonly fn: string;
  /** The path argument as a string (a URL becomes its file path, a Buffer its text). */
  readonly path: string;
  /** The real path of `path` at call time, or null when it did not resolve (a file about to be created). */
  readonly realpath: string | null;
}

/** Functions whose FIRST argument is a path. */
const PATH_FIRST: readonly string[] = [
  "access",
  "accessSync",
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "createReadStream",
  "createWriteStream",
  "exists",
  "existsSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "lstat",
  "lstatSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "mkdtempDisposable",
  "mkdtempDisposableSync",
  "open",
  "openAsBlob",
  "openSync",
  "opendir",
  "opendirSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "stat",
  "statSync",
  "statfs",
  "statfsSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "unwatchFile",
  "utimes",
  "utimesSync",
  "watch",
  "watchFile",
  "writeFile",
  "writeFileSync",
  "glob",
  "globSync",
];

/** Functions that take TWO paths (source and destination); both are recorded. */
const PATH_PAIR: readonly string[] = [
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "link",
  "linkSync",
  "rename",
  "renameSync",
  "symlink",
  "symlinkSync",
];

/**
 * Exports that take no path: descriptor-based calls (the path was recorded when the descriptor
 * was opened), classes, constants and pure helpers. Every export of `node:fs` must be in this list
 * or one of the two above, or the recorder's own coverage test fails, so a function added by a
 * later Node release cannot silently escape the recorder.
 */
export const FS_EXEMPT: readonly string[] = [
  "Dir",
  "Dirent",
  "F_OK",
  "FileReadStream",
  "FileWriteStream",
  "R_OK",
  "ReadStream",
  "Stats",
  "Utf8Stream",
  "W_OK",
  "WriteStream",
  "X_OK",
  "_toUnixTimestamp",
  "close",
  "closeSync",
  "constants",
  "default",
  "fchmod",
  "fchmodSync",
  "fchown",
  "fchownSync",
  "fdatasync",
  "fdatasyncSync",
  "fstat",
  "fstatSync",
  "fsync",
  "fsyncSync",
  "ftruncate",
  "ftruncateSync",
  "futimes",
  "futimesSync",
  "promises",
  "read",
  "readSync",
  "readv",
  "readvSync",
  "write",
  "writeSync",
  "writev",
  "writevSync",
];

/** The same lists for `node:fs/promises`. */
export const FS_PROMISES_EXEMPT: readonly string[] = ["FileHandle", "constants", "default"];

/** Every wrapped function name of `node:fs` (the recorder's own coverage test reads this). */
export const WRAPPED_FS_FUNCTIONS: readonly string[] = [...PATH_FIRST, ...PATH_PAIR];

export interface FsRecorder {
  /** `node:fs` with every path-taking function recorded. */
  mockFs(actual: typeof FsModule): typeof FsModule;
  /**
   * `node:fs/promises` with every path-taking function recorded. The actual `node:fs` is passed
   * as well, for the real-path lookups, because either module may be imported first.
   */
  mockFsPromises(
    actual: typeof FsPromisesModule,
    actualFs: typeof FsModule,
  ): typeof FsPromisesModule;
  /** Every access recorded since the last `clear`, oldest first. */
  all(): readonly FsAccess[];
  /** Accesses whose path OR real path is `path`. */
  accessesTo(path: string): FsAccess[];
  /** Accesses whose path or real path satisfies `predicate`. */
  accessesWhere(predicate: (path: string) => boolean): FsAccess[];
  clear(): void;
  /**
   * Runs `fn` without recording (test infrastructure that must touch the decoys itself, such as
   * the final content hash). Pausing is global to the recorder, so wrap only code that nothing else
   * runs beside; an async `fn` stays paused until its promise settles.
   */
  whilePaused<T>(fn: () => T): T;
}

/** Accesses in `list` whose path OR real path is `path`. */
export function filterAccessesTo(list: readonly FsAccess[], path: string): FsAccess[] {
  return list.filter((access) => access.path === path || access.realpath === path);
}

/** Accesses in `list` whose path or real path satisfies `predicate`. */
export function filterAccessesWhere(
  list: readonly FsAccess[],
  predicate: (path: string) => boolean,
): FsAccess[] {
  return list.filter(
    (access) => predicate(access.path) || (access.realpath !== null && predicate(access.realpath)),
  );
}

type AnyFn = (...args: unknown[]) => unknown;

function pathText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.protocol === "file:" ? value.pathname : value.href;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

export function createFsRecorder(): FsRecorder {
  const log: FsAccess[] = [];
  let paused = 0;
  // The real module, set when the mock factory first runs; used for `realpath` lookups only.
  let realFs: typeof FsModule | null = null;

  function resolve(path: string): string | null {
    if (realFs === null) return null;
    try {
      return realFs.realpathSync.native(path);
    } catch {
      return null;
    }
  }

  function record(fn: string, args: readonly unknown[], pathArgs: readonly number[]): void {
    if (paused > 0) return;
    for (const index of pathArgs) {
      const path = pathText(args[index]);
      if (path !== null) log.push({ fn, path, realpath: resolve(path) });
    }
  }

  function wrapAll<M extends object>(
    actual: M,
    prefix: string,
    first: readonly string[],
    pair: readonly string[],
  ): M {
    const out: Record<string, unknown> = { ...(actual as Record<string, unknown>) };
    const wrap = (name: string, pathArgs: readonly number[]): void => {
      const original = (actual as Record<string, unknown>)[name];
      if (typeof original !== "function") return;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        record(`${prefix}${name}`, args, pathArgs);
        return (original as AnyFn).apply(this, args);
      };
      // Keep the properties some functions carry (`realpath.native`, `exists[util.promisify.custom]`).
      for (const key of Reflect.ownKeys(original as object)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const descriptor = Object.getOwnPropertyDescriptor(original, key);
        if (descriptor !== undefined) Object.defineProperty(wrapped, key, descriptor);
      }
      if (name === "realpathSync" || name === "realpath") {
        const nativeOriginal = (original as unknown as { native?: AnyFn }).native;
        if (typeof nativeOriginal === "function") {
          (wrapped as unknown as { native: AnyFn }).native = function (
            this: unknown,
            ...args: unknown[]
          ): unknown {
            record(`${prefix}${name}.native`, args, [0]);
            return nativeOriginal.apply(this, args);
          };
        }
      }
      out[name] = wrapped;
    };
    for (const name of first) wrap(name, [0]);
    for (const name of pair) wrap(name, [0, 1]);
    return out as M;
  }

  return {
    mockFs(actual) {
      realFs = actual;
      const wrapped = wrapAll(actual, "", PATH_FIRST, PATH_PAIR);
      const promises = wrapAll(actual.promises, "promises.", PATH_FIRST, PATH_PAIR);
      const withPromises = { ...wrapped, promises };
      // `import fs from "node:fs"` and `import * as fs from "node:fs"` must both be wrapped.
      return { ...withPromises, default: withPromises } as typeof FsModule;
    },
    mockFsPromises(actual, actualFs) {
      realFs ??= actualFs;
      const wrapped = wrapAll(actual, "promises.", PATH_FIRST, PATH_PAIR);
      return { ...wrapped, default: wrapped } as typeof FsPromisesModule;
    },
    all: () => log,
    accessesTo: (path) => filterAccessesTo(log, path),
    accessesWhere: (predicate) => filterAccessesWhere(log, predicate),
    clear() {
      log.length = 0;
    },
    whilePaused<T>(fn: () => T): T {
      paused += 1;
      let result: T;
      try {
        result = fn();
      } catch (error) {
        paused -= 1;
        throw error;
      }
      if (result instanceof Promise) {
        return result.finally(() => {
          paused -= 1;
        }) as T;
      }
      paused -= 1;
      return result;
    },
  };
}

let shared: FsRecorder | null = null;

/** The one recorder the mock factories and the test body share (module state, per test file). */
export function sharedFsRecorder(): FsRecorder {
  shared ??= createFsRecorder();
  return shared;
}
