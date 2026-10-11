import { open, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * The ONE child-environment policy for every local spawn of the owner's Codex
 * launcher (usage app-server, version probe, doctor probe).
 *
 * The child never inherits the service environment: HOME, the C locale, a
 * fixed PATH and CODEX_HOME only when configured. The fixed PATH is
 * `/usr/bin:/bin`, which holds no Node. A launcher saved as a
 * `#!/usr/bin/env <name>` script (the usual nvm or Homebrew Node install)
 * could therefore never start. So when, and only when, the launcher's first
 * line is that shebang, the interpreter is searched for in a FIXED list of
 * directories and the one directory that holds it goes FIRST on the child
 * PATH. Nothing from the service PATH is ever passed through, and no shell is
 * involved.
 *
 * Searched, in order: the directory of the service's own Node (the pinned
 * Node), the launcher's own directory, `/opt/homebrew/bin`, `/usr/local/bin`.
 * Each must be an absolute real directory that is not world-writable. If the
 * interpreter is found nowhere, the PATH stays minimal and the child fails to
 * start, which every caller already reports as unavailable.
 */

const BASE_PATH = "/usr/bin:/bin";
const STANDARD_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];
const SHEBANG_HEAD_BYTES = 256;
const ENV_SHEBANG = /^#!\s*\/usr\/bin\/env\s+([A-Za-z0-9._-]+)\s*$/;

/**
 * Every call is asynchronous (a stalled mount must never block the event loop) and may never
 * settle; {@link codexChildEnv} bounds the whole preparation with a deadline.
 */
export interface ChildEnvFs {
  /** The first bytes of the file as text, or `null` when unreadable. */
  readHead(path: string): Promise<string | null>;
  /** The resolved real path of a directory that is world-unwritable, or `null`. */
  safeDirectory(path: string): Promise<string | null>;
  isExecutableFile(path: string): Promise<boolean>;
}

export const realChildEnvFs: ChildEnvFs = {
  async readHead(path) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(SHEBANG_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SHEBANG_HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("latin1");
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  async safeDirectory(path) {
    try {
      if (!isAbsolute(path)) return null;
      const real = await realpath(path);
      const info = await stat(real);
      if (!info.isDirectory() || (info.mode & 0o002) !== 0) return null;
      return real;
    } catch {
      return null;
    }
  },
  async isExecutableFile(path) {
    try {
      const info = await stat(path);
      return info.isFile() && (info.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  },
};

/** How long preparing the environment may take; part of (never added to) the probe's own cap. */
export const CHILD_ENV_PREPARE_DEADLINE_MS = 1500;

export interface CodexChildEnvOptions {
  readonly executablePath: string;
  readonly codexHome: string | null;
  readonly home: string;
  /** Replaces the standard directories (tests); the pinned and launcher dirs stay. */
  readonly platformDirs?: readonly string[];
  /** The pinned Node's path; the service's own by default. */
  readonly nodeExecPath?: string;
  readonly fs?: ChildEnvFs;
  /** Longest the filesystem inspection may take; default {@link CHILD_ENV_PREPARE_DEADLINE_MS}. */
  readonly deadlineMs?: number;
  /** Ends the preparation early (the answer is then `null`). */
  readonly signal?: AbortSignal;
}

/** The interpreter name of a `#!/usr/bin/env <name>` first line, else `null`. */
function envInterpreter(head: string | null): string | null {
  if (head === null) return null;
  const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
  return ENV_SHEBANG.exec(firstLine)?.[1] ?? null;
}

async function discoverPath(options: CodexChildEnvOptions, fs: ChildEnvFs): Promise<string> {
  const name = envInterpreter(await fs.readHead(options.executablePath));
  if (name === null) return BASE_PATH;
  const candidates = [
    dirname(options.nodeExecPath ?? process.execPath),
    dirname(options.executablePath),
    ...(options.platformDirs ?? STANDARD_DIRS),
  ];
  for (const candidate of candidates) {
    const dir = await fs.safeDirectory(candidate);
    if (dir !== null && !dir.includes(delimiter) && (await fs.isExecutableFile(join(dir, name)))) {
      return `${dir}${delimiter}${BASE_PATH}`;
    }
  }
  return BASE_PATH;
}

/**
 * The child environment, or `null` when it could not be prepared in time (the deadline passed or
 * the signal fired while the launcher or interpreter was being inspected). Callers report their
 * existing "unavailable" outcome for `null`. Nothing here blocks the event loop.
 */
export async function codexChildEnv(
  options: CodexChildEnvOptions,
): Promise<Record<string, string> | null> {
  const fs = options.fs ?? realChildEnvFs;
  const deadlineMs = Math.max(1, options.deadlineMs ?? CHILD_ENV_PREPARE_DEADLINE_MS);
  const { signal } = options;
  if (signal?.aborted === true) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cutoff = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
    onAbort = () => resolve(null);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const path = await Promise.race([discoverPath(options, fs).catch(() => BASE_PATH), cutoff]);
    if (path === null) return null;
    const env: Record<string, string> = { HOME: options.home, PATH: path, LC_ALL: "C" };
    if (options.codexHome !== null && options.codexHome.length > 0) {
      env.CODEX_HOME = options.codexHome;
    }
    return env;
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}
