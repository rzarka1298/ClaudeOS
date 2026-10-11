import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Vitest setup file: every test file in this package runs with its own
 * throwaway `CCC_RUNTIME_DIR`, so nothing a test starts can reach the owner's
 * real runtime directory or live socket. A test that sets its own
 * `CCC_RUNTIME_DIR` still wins; it runs after this file.
 *
 * The base is a short, fixed directory under HOME rather than the system
 * temporary directory: macOS's randomized TMPDIR is long enough to break the
 * 104-byte socket path cap (ADR-0001). Same pattern as @ccc/test-fixtures.
 */
const TEST_BASE = join(homedir(), ".ccc-test");
mkdirSync(TEST_BASE, { recursive: true });
const runtimeDir = mkdtempSync(join(TEST_BASE, "rt-"));
process.env.CCC_RUNTIME_DIR = runtimeDir;
// The service prefers CCC_SOCKET_PATH over the runtime dir, so an orchestrator-exported
// smoke-run socket must not leak into unit tests. A throwaway keychain account keeps any
// test that deletes or reads the install secret off the owner's default account.
delete process.env.CCC_SOCKET_PATH;
process.env.CCC_INSTALL_SECRET_ACCOUNT = `ccc-uat-test-${randomBytes(4).toString("hex")}`;

afterAll(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});
