import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
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

export interface ChildEnvFs {
  /** The first bytes of the file as text, or `null` when unreadable. */
  readHead(path: string): string | null;
  /** The resolved real path of a directory that is world-unwritable, or `null`. */
  safeDirectory(path: string): string | null;
  isExecutableFile(path: string): boolean;
}

export const realChildEnvFs: ChildEnvFs = {
  readHead(path) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(SHEBANG_HEAD_BYTES);
      const read = readSync(fd, buffer, 0, SHEBANG_HEAD_BYTES, 0);
      return buffer.subarray(0, read).toString("latin1");
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Nothing to do.
        }
      }
    }
  },
  safeDirectory(path) {
    try {
      if (!isAbsolute(path)) return null;
      const real = realpathSync(path);
      const stat = statSync(real);
      if (!stat.isDirectory() || (stat.mode & 0o002) !== 0) return null;
      return real;
    } catch {
      return null;
    }
  },
  isExecutableFile(path) {
    try {
      const stat = statSync(path);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  },
};

export interface CodexChildEnvOptions {
  readonly executablePath: string;
  readonly codexHome: string | null;
  readonly home: string;
  /** Replaces the standard directories (tests); the pinned and launcher dirs stay. */
  readonly platformDirs?: readonly string[];
  /** The pinned Node's path; the service's own by default. */
  readonly nodeExecPath?: string;
  readonly fs?: ChildEnvFs;
}

/** The interpreter name of a `#!/usr/bin/env <name>` first line, else `null`. */
function envInterpreter(head: string | null): string | null {
  if (head === null) return null;
  const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
  return ENV_SHEBANG.exec(firstLine)?.[1] ?? null;
}

export function codexChildEnv(options: CodexChildEnvOptions): Record<string, string> {
  const fs = options.fs ?? realChildEnvFs;
  let path = BASE_PATH;
  const name = envInterpreter(fs.readHead(options.executablePath));
  if (name !== null) {
    const candidates = [
      dirname(options.nodeExecPath ?? process.execPath),
      dirname(options.executablePath),
      ...(options.platformDirs ?? STANDARD_DIRS),
    ];
    for (const candidate of candidates) {
      const dir = fs.safeDirectory(candidate);
      if (dir !== null && !dir.includes(delimiter) && fs.isExecutableFile(join(dir, name))) {
        path = `${dir}${delimiter}${BASE_PATH}`;
        break;
      }
    }
  }
  const env: Record<string, string> = { HOME: options.home, PATH: path, LC_ALL: "C" };
  if (options.codexHome !== null && options.codexHome.length > 0) {
    env.CODEX_HOME = options.codexHome;
  }
  return env;
}
