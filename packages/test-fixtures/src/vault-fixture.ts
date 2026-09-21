import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The same short, fixed base directory `withTempSocketDir` uses. A vault
// root has no `sun_path` byte cap to respect, so the reason is weaker
// here — but keeping every ephemeral test artifact under one predictable
// root means a killed test run leaves its debris somewhere a human can
// find and delete, instead of scattered through a randomized $TMPDIR.
const TEST_BASE = join(homedir(), ".ccc-test");

export interface TempVaultDir {
  /** The ephemeral vault root, created empty. */
  vaultRoot: string;
}

/**
 * Creates an empty, ephemeral vault root under `~/.ccc-test/`, hands it to
 * `fn`, and removes it afterward regardless of outcome.
 *
 * Every vault test runs against one of these, never against the committed
 * `examples/vault/` fixture — pointing a real write path at the tracked
 * example is how an "empty structure" quietly grows real content (PRIV-05,
 * research Pitfall 6).
 */
export async function withTempVaultDir<T>(
  fn: (fixture: TempVaultDir) => Promise<T> | T,
): Promise<T> {
  mkdirSync(TEST_BASE, { recursive: true });
  const vaultRoot = mkdtempSync(join(TEST_BASE, "v-"));
  try {
    return await fn({ vaultRoot });
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
}
