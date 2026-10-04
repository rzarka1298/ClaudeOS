import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureRuntimeDir,
  RealRuntimeDirUnderTestError,
  resolveRuntimeDir,
  resolveSocketPath,
} from "./paths.js";

let parentDir: string;
let runtimeDir: string;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ccc-runtime-dir-test-"));
  runtimeDir = join(parentDir, "runtime");
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

function modeBits(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("ensureRuntimeDir", () => {
  it("creates a fresh directory at mode 0700", () => {
    ensureRuntimeDir(runtimeDir);
    expect(modeBits(runtimeDir)).toBe(0o700);
  });

  it("repairs a pre-existing directory left at a permissive mode (0755) back to 0700", () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o755 });
    expect(modeBits(runtimeDir)).toBe(0o755);

    ensureRuntimeDir(runtimeDir);

    expect(modeBits(runtimeDir)).toBe(0o700);
  });

  it("leaves an already-0700 directory untouched (no warning logged)", () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const warn = vi.fn();

    ensureRuntimeDir(runtimeDir, { warn });

    expect(modeBits(runtimeDir)).toBe(0o700);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a redacted warning (path only, no secret material) when repairing a permissive directory", () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o777 });
    const warn = vi.fn();

    ensureRuntimeDir(runtimeDir, { warn });

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ runtimeDir });
    expect(message).toBe("runtime dir permissions repaired");
  });
});

describe("the real runtime directory is off limits to tests", () => {
  const REAL_DEFAULT = join(homedir(), ".claude-command-center");

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("every test file already runs with an isolated CCC_RUNTIME_DIR (vitest setup)", () => {
    const dir = process.env.CCC_RUNTIME_DIR;
    expect(dir).toBeDefined();
    expect(dir).not.toBe(REAL_DEFAULT);
    expect(resolveRuntimeDir()).toBe(dir);
  });

  it("resolveRuntimeDir fails loudly under a test runner when CCC_RUNTIME_DIR is unset", () => {
    vi.stubEnv("CCC_RUNTIME_DIR", undefined);
    expect(() => resolveRuntimeDir()).toThrow(RealRuntimeDirUnderTestError);
  });

  it("resolveRuntimeDir fails loudly under a test runner when pointed at the real default", () => {
    vi.stubEnv("CCC_RUNTIME_DIR", REAL_DEFAULT);
    expect(() => resolveRuntimeDir()).toThrow(RealRuntimeDirUnderTestError);
  });

  it("resolveSocketPath fails loudly under a test runner for the real default socket", () => {
    vi.stubEnv("CCC_SOCKET_PATH", join(REAL_DEFAULT, "svc.sock"));
    expect(() => resolveSocketPath()).toThrow(RealRuntimeDirUnderTestError);
  });

  it("outside a test runner the real default is still the default", () => {
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("CCC_RUNTIME_DIR", undefined);
    expect(resolveRuntimeDir()).toBe(REAL_DEFAULT);
  });
});
