import { createHash } from "node:crypto";
import { access, constants, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProbeOutcome } from "@ccc/domain";
import { MANAGED_FOLDERS } from "@ccc/vault-repo";
import { isForbiddenRoot } from "../vault-root-policy.js";

/**
 * The vault probe (plan 08-07; D-04, D-05, D-36; threats T-08-15, T-08-16, T-08-18). It reads only
 * the persisted vault root and answers one closed code. Everything it does is read-only:
 *
 * 1. `stat` the root (async, so a stalled mount cannot block the event loop, research Pitfall 1);
 * 2. `realpath` it and refuse a forbidden location (the same rule setup applies);
 * 3. `access` for read and search, then for write: `access(2)` writes nothing;
 * 4. `stat` the `.obsidian` marker;
 * 5. only then the managed tree: one asynchronous `stat` per managed folder, one after another,
 *    each raced against the signal. Nothing here is synchronous (FIX2A F1): a managed folder may be a
 *    symlink into a stalled network mount, and a synchronous `existsSync` on it would hold the event
 *    loop past the 2 s and 5 s caps. A hung `stat` holds a thread-pool thread while the timers fire,
 *    and the probe reads `probe-timeout`.
 *
 * Every file-system error is mapped to a code by its `errno` code; the error message, which can
 * name the path, is never read. The result carries a reason code and nothing else.
 */

/** The file-system calls the probe may make, all asynchronous. There is no write member to inject. */
export interface VaultFsPorts {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  access(path: string, mode: number): Promise<void>;
  realpath(path: string): Promise<string>;
}

export interface VaultProbePorts {
  /**
   * The persisted vault root, or null when none has been set up. The probe calls it itself (FIX2A
   * F9): a throw reads `probe-error` for this row and never fails the whole response.
   */
  readonly readRoot: () => string | null;
  readonly fs?: VaultFsPorts | undefined;
  /** Whether a realpath'd root is a location this service never adopts (defaults to the setup rule). */
  readonly isForbiddenRoot?: ((resolved: string) => boolean) | undefined;
}

const DEFAULT_FS: VaultFsPorts = {
  stat: (path) => stat(path),
  access: (path, mode) => access(path, mode),
  realpath: (path) => realpath(path),
};

/** The marker Obsidian itself creates in every vault. */
const OBSIDIAN_MARKER = ".obsidian";

const SET_UP_ACTION = { kind: "run-plugin-command", command: "vault-setup" } as const;

type VaultOutcome = Extract<ProbeOutcome, { id: "vault" }>;

const outcomes = {
  notSetUp: {
    id: "vault",
    status: "setup-needed",
    reasonCode: "vault-not-set-up",
    setupAction: SET_UP_ACTION,
  },
  ready: { id: "vault", status: "ok", reasonCode: "vault-ready" },
  incomplete: { id: "vault", status: "degraded", reasonCode: "managed-tree-incomplete" },
  notObsidian: { id: "vault", status: "degraded", reasonCode: "not-an-obsidian-vault" },
  missing: { id: "vault", status: "failing", reasonCode: "vault-root-missing" },
  notDirectory: { id: "vault", status: "failing", reasonCode: "vault-root-not-directory" },
  unreadable: { id: "vault", status: "failing", reasonCode: "vault-root-unreadable" },
  notWritable: { id: "vault", status: "failing", reasonCode: "vault-root-not-writable" },
  refused: { id: "vault", status: "failing", reasonCode: "vault-root-refused" },
  timeout: { id: "vault", status: "unknown", reasonCode: "probe-timeout" },
  error: { id: "vault", status: "unknown", reasonCode: "probe-error" },
} as const satisfies Record<string, VaultOutcome>;

/** The signal fired: the probe stops and says so. */
class ProbeAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "ProbeAborted";
  }
}

/** Races `promise` against `signal`. The underlying call cannot be cancelled; its result is simply dropped. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProbeAborted());
      return;
    }
    const onAbort = (): void => reject(new ProbeAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The `errno` code of a file-system error, or null. The message is never read. */
function errnoOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** Maps a failed `stat` / `realpath` of the root (or `access` for read) to its closed outcome. */
function outcomeForRootError(error: unknown, writeCheck: boolean): VaultOutcome {
  switch (errnoOf(error)) {
    case "ENOENT":
      return outcomes.missing;
    case "ENOTDIR":
      return outcomes.notDirectory;
    case "EACCES":
    case "EPERM":
      return writeCheck ? outcomes.notWritable : outcomes.unreadable;
    case "EROFS":
      return writeCheck ? outcomes.notWritable : outcomes.error;
    default:
      return outcomes.error;
  }
}

/** The root string a persisted value must have before any file-system call is made. */
function isUsableRootString(root: string): boolean {
  return root.length > 0 && isAbsolute(root) && !root.includes("\u0000");
}

/** Whether an errno says "there is nothing there": the only errors that mean a managed folder is missing. */
function isNotThere(error: unknown): boolean {
  const code = errnoOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function probeVault(
  ports: VaultProbePorts,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  let root: string | null;
  try {
    root = ports.readRoot();
  } catch {
    return outcomes.error;
  }
  if (root === null) return outcomes.notSetUp;
  if (!isUsableRootString(root)) return outcomes.refused;
  if (signal.aborted) return outcomes.timeout;

  const fs = ports.fs ?? DEFAULT_FS;
  const forbidden = ports.isForbiddenRoot ?? isForbiddenRoot;

  try {
    // 1. The root exists and is a directory.
    let rootStat: Awaited<ReturnType<VaultFsPorts["stat"]>>;
    try {
      rootStat = await abortable(fs.stat(root), signal);
    } catch (error) {
      if (error instanceof ProbeAborted) return outcomes.timeout;
      return outcomeForRootError(error, false);
    }
    if (!rootStat.isDirectory()) return outcomes.notDirectory;

    // 2. Where it really is, and whether that is a place we never adopt as a vault.
    let resolved: string;
    try {
      resolved = await abortable(fs.realpath(root), signal);
    } catch (error) {
      if (error instanceof ProbeAborted) return outcomes.timeout;
      return outcomeForRootError(error, false);
    }
    if (forbidden(resolved)) return outcomes.refused;

    // 3. Read and search, then write. `access` checks permissions without writing.
    try {
      await abortable(fs.access(root, constants.R_OK | constants.X_OK), signal);
    } catch (error) {
      if (error instanceof ProbeAborted) return outcomes.timeout;
      return outcomeForRootError(error, false);
    }
    try {
      await abortable(fs.access(root, constants.W_OK), signal);
    } catch (error) {
      if (error instanceof ProbeAborted) return outcomes.timeout;
      return outcomeForRootError(error, true);
    }

    // 4. The Obsidian marker.
    try {
      const marker = await abortable(fs.stat(join(root, OBSIDIAN_MARKER)), signal);
      if (!marker.isDirectory()) return outcomes.notObsidian;
    } catch (error) {
      if (error instanceof ProbeAborted) return outcomes.timeout;
      const code = errnoOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") return outcomes.notObsidian;
      return outcomeForRootError(error, false);
    }

    // 5. The managed folders, asynchronously, one after another (FIX2A F1). A missing or
    // non-folder entry makes the tree incomplete and ends the walk; an error that is not "not
    // there" is not a verdict about the tree, so it reads probe-error.
    for (const folder of MANAGED_FOLDERS) {
      if (signal.aborted) return outcomes.timeout;
      let info: Awaited<ReturnType<VaultFsPorts["stat"]>>;
      try {
        info = await abortable(fs.stat(join(root, ...folder.split("/"))), signal);
      } catch (error) {
        if (error instanceof ProbeAborted) return outcomes.timeout;
        return isNotThere(error) ? outcomes.incomplete : outcomes.error;
      }
      if (!info.isDirectory()) return outcomes.incomplete;
    }
    return outcomes.ready;
  } catch {
    return outcomes.error;
  }
}

/**
 * The salted fingerprint of the persisted root (D-36): the first 16 hex characters of SHA-256 over
 * `salt + ":" + root`. The plugin computes the same digest over its own vault path with the salt
 * it was sent and compares; the root itself never crosses the wire.
 */
export function vaultFingerprint(salt: string, root: string): { salt: string; digest: string } {
  const digest = createHash("sha256").update(`${salt}:${root}`).digest("hex").slice(0, 16);
  return { salt, digest };
}
