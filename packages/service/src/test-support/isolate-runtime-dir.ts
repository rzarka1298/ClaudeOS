import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Vitest setup file: every test file in this package runs with its own
 * throwaway `CCC_RUNTIME_DIR`, so nothing a test starts (the service, a
 * socket server, the redacting logger that opens its file at import) can
 * reach the owner's real runtime directory or live socket. A test that sets
 * its own `CCC_RUNTIME_DIR` still wins — it runs after this file.
 *
 * The base is a short, fixed directory under HOME rather than the system
 * temporary directory: macOS's randomized TMPDIR is long enough to break the
 * 104-byte socket path cap (ADR-0001).
 *
 * The backstop is `RealRuntimeDirUnderTestError` in `@ccc/service`'s
 * `paths.ts`: under a test runner, resolving the real default directory or
 * socket fails loudly instead of silently touching it.
 */
const TEST_BASE = join(homedir(), ".ccc-test");
mkdirSync(TEST_BASE, { recursive: true });
const runtimeDir = mkdtempSync(join(TEST_BASE, "rt-"));
process.env.CCC_RUNTIME_DIR = runtimeDir;

afterAll(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});
