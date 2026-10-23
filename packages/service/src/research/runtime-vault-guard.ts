import { sep } from "node:path";

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
 * The research pipeline's own write path (`loadResearchSources`) keeps its fresh synchronous check;
 * that runs only on an owner-triggered run, never on the health path.
 */

export interface RuntimeVaultGuardDeps {
  readonly runtimeDir: string;
  /** The persisted vault root, read fresh (a store read, no file work). */
  readonly getVaultRoot: () => string | null;
  /** Asynchronous path resolution (`fs.promises.realpath`); injected so tests never touch a disk. */
  readonly realpath: (path: string) => Promise<string>;
}

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
  let cached: { readonly vaultRoot: string; readonly inside: boolean } | null = null;
  let inFlight: Promise<void> | null = null;

  async function resolveOnce(vaultRoot: string): Promise<boolean> {
    try {
      const runtime = await deps.realpath(deps.runtimeDir);
      const vault = await deps.realpath(vaultRoot);
      return within(runtime, vault);
    } catch {
      // A folder that cannot be resolved holds no file to protect (the open then fails).
      return false;
    }
  }

  async function run(): Promise<void> {
    // Loop until the cache matches the root as it is now: the root can change during a resolution.
    for (;;) {
      const root = deps.getVaultRoot();
      if (root === null || root.length === 0) {
        cached = null;
        return;
      }
      if (cached !== null && cached.vaultRoot === root) return;
      const inside = await resolveOnce(root);
      cached = { vaultRoot: root, inside };
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
      if (cached !== null && cached.vaultRoot === vaultRoot) return cached.inside;
      // Not resolved for this root yet: start the background resolution and answer lexically.
      void refresh();
      return lexicalInsideVault(deps.runtimeDir, vaultRoot);
    },
    refresh,
  };
}
