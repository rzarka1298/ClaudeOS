import { sep } from "node:path";
import { createSingleFlight } from "../single-flight.js";

/**
 * Whether the service's runtime folder is the vault or below it (FIX3A MAJOR-1; ADR-0031).
 *
 * The research allowlist file must not live in the synced vault. The old check resolved both paths
 * with a SYNCHRONOUS `realpathSync` on every health check, so a vault on a stalled mount froze the
 * event loop past the probe caps. The answer is now resolved asynchronously, at service start and
 * whenever the vault root changes, and cached. The per-request answer ({@link insideVault}) does
 * no file work at all: it returns the cached boolean for the current vault root, or, until that
 * resolution finishes, the purely lexical comparison.
 *
 * A resolution that fails is not remembered as "no" for good (FIX6A opus minor 5): the request
 * answers with the lexical rule meanwhile (so a runtime folder lexically inside the vault is still
 * refused) and the next refresh after a backoff tries again. Each `realpath` is bounded by a
 * timeout, so a never-settling call cannot keep the refresh in flight, and at most one call per
 * path is outstanding, so a stalled mount holds one worker however many refreshes time out.
 *
 * The research pipeline's own write path (`loadResearchSources`) keeps its fresh synchronous check;
 * that runs only on an owner-triggered run, never on the health path.
 */

export interface RuntimeVaultGuardDeps {
  readonly runtimeDir: string;
  /** The persisted vault root, read fresh (a store read, no file work). */
  readonly getVaultRoot: () => string | null;
  /** Asynchronous path resolution (`fs.promises.realpath`); injected so tests never touch a disk. */
  readonly realpath: (path: string) => Promise<string>;
  /** Monotonic milliseconds for the retry backoff; defaults to `performance.now`. */
  readonly nowMs?: () => number;
  /** How long a failed resolution waits before the next refresh retries it (default 30 s). */
  readonly retryAfterMs?: number;
  /** The bound on one `realpath` call (default 5 s). */
  readonly timeoutMs?: number;
}

const DEFAULT_RETRY_AFTER_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface RuntimeVaultGuard {
  /** The cached answer for `vaultRoot`. Synchronous and free of file work. */
  insideVault(vaultRoot: string | null): boolean;
  /** Resolves the answer for the current vault root and caches it. Never rejects. */
  refresh(): Promise<void>;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** The path comparison with no link resolution and no file work. */
export function lexicalInsideVault(runtimeDir: string, vaultRoot: string): boolean {
  return within(runtimeDir, vaultRoot);
}

export function createRuntimeVaultGuard(deps: RuntimeVaultGuardDeps): RuntimeVaultGuard {
  const nowMs = deps.nowMs ?? (() => performance.now());
  const retryAfterMs = deps.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const flights = createSingleFlight();
  /** `inside` is the resolved answer; `null` means the resolution failed at `failedAtMs`. */
  let cached: {
    readonly vaultRoot: string;
    readonly inside: boolean | null;
    readonly failedAtMs: number;
  } | null = null;
  let inFlight: Promise<void> | null = null;

  /** One bounded, single-flight `realpath`; null when it fails or runs past the timeout. */
  function resolvePath(path: string): Promise<string | null> {
    const call = flights.run(path, () => deps.realpath(path)).catch(() => null);
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      void call.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  async function resolveOnce(vaultRoot: string): Promise<boolean | null> {
    const runtime = await resolvePath(deps.runtimeDir);
    if (runtime === null) return null;
    const vault = await resolvePath(vaultRoot);
    if (vault === null) return null;
    return within(runtime, vault);
  }

  async function run(): Promise<void> {
    // Loop until the cache matches the root as it is now: the root can change during a resolution.
    for (;;) {
      const root = deps.getVaultRoot();
      if (root === null || root.length === 0) {
        cached = null;
        return;
      }
      if (cached !== null && cached.vaultRoot === root) {
        if (cached.inside !== null) return;
        // A failed resolution waits out the backoff before it is asked again.
        if (nowMs() - cached.failedAtMs < retryAfterMs) return;
      }
      const inside = await resolveOnce(root);
      cached = { vaultRoot: root, inside, failedAtMs: nowMs() };
    }
  }

  function refresh(): Promise<void> {
    if (inFlight === null) {
      inFlight = run()
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    insideVault(vaultRoot) {
      if (vaultRoot === null || vaultRoot.length === 0) return false;
      if (cached !== null && cached.vaultRoot === vaultRoot && cached.inside !== null) {
        return cached.inside;
      }
      // Not resolved for this root yet, or the last resolution failed: start (or, inside the
      // backoff, skip) the background resolution and answer lexically.
      void refresh();
      return lexicalInsideVault(deps.runtimeDir, vaultRoot);
    },
    refresh,
  };
}
