import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realRuntimeDir } from "./isolation-guards.js";
import { assertIsolatedEnv, MSG_ISOLATION } from "./uat-env.js";

/** Wave 2 review LOW-5: the isolation checks follow links instead of comparing text only. */

let base: string;
let runRoot: string;
let home: string;
let liveRuntime: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync("/tmp/ccc-e2e-env."));
  runRoot = join(base, "ccc-uat.abc123");
  home = join(base, "home");
  liveRuntime = realRuntimeDir(home);
  mkdirSync(runRoot);
  mkdirSync(liveRuntime, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function env(overrides: Record<string, string>): Record<string, string> {
  return {
    CCC_SOCKET_PATH: join(runRoot, "rt", "svc.sock"),
    CCC_RUNTIME_DIR: join(runRoot, "rt"),
    CLAUDE_CONFIG_DIR: join(runRoot, "claude"),
    CODEX_HOME: join(runRoot, "codex"),
    CCC_INSTALL_SECRET_ACCOUNT: "ccc-uat-abc123",
    ...overrides,
  };
}

describe("assertIsolatedEnv canonicalises the isolation paths (LOW-5)", () => {
  it("accepts real directories inside the run root", () => {
    expect(() => assertIsolatedEnv(env({}), { runRoot, home })).not.toThrow();
  });

  it.each([
    ["CCC_RUNTIME_DIR", "rt"],
    ["CLAUDE_CONFIG_DIR", "claude"],
    ["CODEX_HOME", "codex"],
  ])("refuses %s when it is a link to the owner's runtime folder", (name, entry) => {
    symlinkSync(liveRuntime, join(runRoot, entry));
    expect(() => assertIsolatedEnv(env({}), { runRoot, home })).toThrow(MSG_ISOLATION);
    expect(name).toBeTruthy();
  });

  it("refuses a socket path that reaches the live socket through a link", () => {
    symlinkSync(liveRuntime, join(runRoot, "rt"));
    expect(() => assertIsolatedEnv(env({}), { runRoot, home })).toThrow(MSG_ISOLATION);
  });

  it("refuses a variable pointing outside the run root through a link", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(runRoot, "codex"));
    expect(() => assertIsolatedEnv(env({}), { runRoot, home })).toThrow(MSG_ISOLATION);
  });
});
