import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUN_PATH_MAX_BYTES = 104;
// A short, fixed base directory under $HOME — deliberately not
// os.tmpdir(), whose randomized macOS $TMPDIR is exactly what breaks the
// sun_path cap (ADR-0001). Fixture behavior must not itself violate the
// constraint the tests using it are asserting.
const TEST_BASE = join(homedir(), ".ccc-test");

export interface TempSocketDir {
  dir: string;
  socketPath: string;
}

/**
 * Creates a short-path temp directory under `~/.ccc-test/`, asserts the
 * resulting socket path stays under the 104-byte sun_path cap, hands it to
 * `fn`, and removes the directory afterward regardless of outcome.
 */
export async function withTempSocketDir<T>(
  fn: (fixture: TempSocketDir) => Promise<T> | T,
): Promise<T> {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEST_BASE, "s-"));
  const socketPath = join(dir, "svc.sock");
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength >= SUN_PATH_MAX_BYTES) {
    throw new Error(
      `Test fixture socket path is ${byteLength} bytes, at or above the ${SUN_PATH_MAX_BYTES}-byte cap: ${socketPath}`,
    );
  }
  try {
    return await fn({ dir, socketPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
