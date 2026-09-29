import { homedir } from "node:os";
import { join } from "node:path";
import { RealRuntimeDirUnderTestError, resolveRuntimeDir } from "@ccc/service/paths";
import { afterEach, describe, expect, it, vi } from "vitest";

const REAL_DEFAULT = join(homedir(), ".claude-command-center");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("test-fixtures never resolve the real runtime directory", () => {
  it("every test file runs with an isolated CCC_RUNTIME_DIR (vitest setup)", () => {
    expect(process.env.CCC_RUNTIME_DIR).toBeDefined();
    expect(process.env.CCC_RUNTIME_DIR).not.toBe(REAL_DEFAULT);
  });

  it("resolving the runtime directory without CCC_RUNTIME_DIR fails loudly", () => {
    vi.stubEnv("CCC_RUNTIME_DIR", undefined);
    expect(() => resolveRuntimeDir()).toThrow(RealRuntimeDirUnderTestError);
  });
});
