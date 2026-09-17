import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRuntimeDir } from "./paths.js";

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
