import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertRunRootShape,
  assertUatAccount,
  buildServiceEnv,
  buildWdioEnv,
  realClaudeConfigDir,
  realRuntimeDir,
  realSocketPath,
  realStorePath,
  refuseRealPaths,
  scrubInheritedEnv,
  uatAccountFor,
} from "./isolation-guards.js";

let scratch: string;
let home: string;
let base: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ccc-e2e-guards-"));
  home = join(scratch, "home");
  base = join(scratch, "base");
  mkdirSync(home, { recursive: true });
  mkdirSync(base, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RUN_ROOT_NAME = "ccc-uat.a1B2c3";

function paths(root: string) {
  return {
    runId: "0123abcd",
    root,
    runtimeDir: join(root, "rt"),
    socketPath: join(root, "rt", "svc.sock"),
    dbPath: join(root, "rt", "operational.db"),
    claudeConfigDir: join(root, "claude"),
    codexHome: join(root, "codex"),
    vaultsDir: join(root, "vaults"),
    pluginStageDir: join(root, "plugin-stage"),
    tmpDir: join(root, "tmp"),
    wdioDir: join(root, "wdio"),
    ledgerPath: join(root, "ledger.jsonl"),
    resultsPath: join(root, "results.jsonl"),
    lookPendingPath: join(root, "look-pending.jsonl"),
    versionsPath: join(root, "versions.json"),
  };
}

describe("uat keychain account (Test 1)", () => {
  it("builds ccc-uat-<runid> and accepts it", () => {
    expect(uatAccountFor("0123abcd")).toBe("ccc-uat-0123abcd");
    expect(() => assertUatAccount("ccc-uat-0123abcd")).not.toThrow();
    expect(() => assertUatAccount("ccc-uat-selftest-9")).not.toThrow();
  });

  it("rejects the default install-secret account, empty, unprefixed and unsafe values", () => {
    expect(() => assertUatAccount("install-secret")).toThrow();
    expect(() => assertUatAccount("")).toThrow();
    expect(() => assertUatAccount("uat-0123abcd")).toThrow();
    expect(() => assertUatAccount("ccc-uat-")).toThrow();
    expect(() => assertUatAccount('ccc-uat-a"b')).toThrow();
    expect(() => assertUatAccount("ccc-uat-a b")).toThrow();
    expect(() => assertUatAccount("ccc-uat-a\nb")).toThrow();
    expect(() => assertUatAccount("ccc-uat-a/b")).toThrow();
  });
});

describe("run root shape (Test 2)", () => {
  it("accepts a direct child of the base with the ccc-uat.XXXXXX name", () => {
    const root = join(base, RUN_ROOT_NAME);
    expect(() => assertRunRootShape(root, { base, home })).not.toThrow();
    mkdirSync(root);
    expect(() => assertRunRootShape(root, { base, home })).not.toThrow();
  });

  it("rejects the home directory, a runtime-directory path, siblings, nesting and a wrong name", () => {
    expect(() => assertRunRootShape(home, { base, home })).toThrow();
    expect(() => assertRunRootShape(realRuntimeDir(home), { base, home })).toThrow();
    expect(() =>
      assertRunRootShape(join(realRuntimeDir(home), RUN_ROOT_NAME), { base, home }),
    ).toThrow();
    expect(() => assertRunRootShape(join(scratch, RUN_ROOT_NAME), { base, home })).toThrow();
    expect(() => assertRunRootShape(join(base, "x", RUN_ROOT_NAME), { base, home })).toThrow();
    expect(() => assertRunRootShape(join(base, "ccc-uat.abc12"), { base, home })).toThrow();
    expect(() => assertRunRootShape(join(base, "ccc-uat.abc1234"), { base, home })).toThrow();
    expect(() => assertRunRootShape(join(base, "ccc-uat.ab/c12"), { base, home })).toThrow();
    expect(() => assertRunRootShape(join(base, "ccc-uat-abc123"), { base, home })).toThrow();
    expect(() => assertRunRootShape("relative/ccc-uat.abc123", { base, home })).toThrow();
  });

  it("rejects a base that sits inside the owner's runtime directory", () => {
    const badBase = join(realRuntimeDir(home), "base");
    expect(() => assertRunRootShape(join(badBase, RUN_ROOT_NAME), { base: badBase, home })).toThrow();
  });

  it("rejects a run root that is a symlink escaping the base (real paths compared)", () => {
    const target = join(scratch, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(base, RUN_ROOT_NAME));
    expect(() => assertRunRootShape(join(base, RUN_ROOT_NAME), { base, home })).toThrow();
  });
});

describe("real paths refused (Test 3)", () => {
  it("builds the owner's real paths from a home directory", () => {
    expect(realRuntimeDir(home)).toBe(join(home, ".claude-command-center"));
    expect(realSocketPath(home)).toBe(join(home, ".claude-command-center", "svc.sock"));
    expect(realStorePath(home)).toBe(join(home, ".claude-command-center", "operational.db"));
    expect(realClaudeConfigDir(home)).toBe(join(home, ".claude"));
  });

  const safe = (root: string) => ({
    runtimeDir: join(root, "rt"),
    socketPath: join(root, "rt", "svc.sock"),
    claudeConfigDir: join(root, "claude"),
  });

  it("accepts a sandbox inside a run root", () => {
    expect(() => refuseRealPaths(safe(join(base, RUN_ROOT_NAME)), { home })).not.toThrow();
  });

  it("refuses the real runtime directory, real socket and real Claude config directory", () => {
    const good = safe(join(base, RUN_ROOT_NAME));
    expect(() => refuseRealPaths({ ...good, runtimeDir: realRuntimeDir(home) }, { home })).toThrow(
      /runtime directory/,
    );
    expect(() => refuseRealPaths({ ...good, socketPath: realSocketPath(home) }, { home })).toThrow(
      /socket/,
    );
    expect(() =>
      refuseRealPaths({ ...good, claudeConfigDir: realClaudeConfigDir(home) }, { home }),
    ).toThrow(/Claude config/);
  });

  it("refuses paths inside the owner's real folders and does not echo the offending path", () => {
    const good = safe(join(base, RUN_ROOT_NAME));
    try {
      refuseRealPaths(
        { ...good, runtimeDir: join(realRuntimeDir(home), "sub", "..", "sub2") },
        { home },
      );
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain(home);
    }
    expect(() =>
      refuseRealPaths({ ...good, claudeConfigDir: join(realClaudeConfigDir(home), "projects") }, { home }),
    ).toThrow();
  });

  it("refuses through a symlink", () => {
    const good = safe(join(base, RUN_ROOT_NAME));
    mkdirSync(realRuntimeDir(home));
    mkdirSync(realClaudeConfigDir(home));
    const link = join(scratch, "link");
    symlinkSync(realRuntimeDir(home), link);
    expect(() => refuseRealPaths({ ...good, runtimeDir: link }, { home })).toThrow();
    expect(() => refuseRealPaths({ ...good, socketPath: join(link, "svc.sock") }, { home })).toThrow();
    const claudeLink = join(scratch, "claude-link");
    symlinkSync(realClaudeConfigDir(home), claudeLink);
    expect(() => refuseRealPaths({ ...good, claudeConfigDir: claudeLink }, { home })).toThrow();
  });

  it("refuses a socket path of 104 bytes or more and accepts 103", () => {
    const good = safe(join(base, RUN_ROOT_NAME));
    const stem = join(base, "s");
    const ok = stem + "x".repeat(103 - Buffer.byteLength(stem));
    const bad = stem + "x".repeat(104 - Buffer.byteLength(stem));
    expect(Buffer.byteLength(ok)).toBe(103);
    expect(() => refuseRealPaths({ ...good, socketPath: ok }, { home })).not.toThrow();
    expect(() => refuseRealPaths({ ...good, socketPath: bad }, { home })).toThrow(/socket path/);
  });
});

describe("service env (Test 4)", () => {
  const account = "ccc-uat-0123abcd";
  const root = join("/tmp", RUN_ROOT_NAME);

  it("normal kind: only isolation variables, all inside the run root, no overrides", () => {
    const env = buildServiceEnv(paths(root), account, "normal");
    expect(env.CCC_RUNTIME_DIR).toBe(join(root, "rt"));
    expect(env.CCC_SOCKET_PATH).toBe(join(root, "rt", "svc.sock"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, "claude"));
    expect(env.CODEX_HOME).toBe(join(root, "codex"));
    expect(env.CCC_INSTALL_SECRET_ACCOUNT).toBe(account);
    expect(Object.keys(env).sort()).toEqual(
      [
        "CCC_INSTALL_SECRET_ACCOUNT",
        "CCC_RUNTIME_DIR",
        "CCC_SOCKET_PATH",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
      ].sort(),
    );
  });

  it("expiry kind adds exactly the three test-override variables", () => {
    const env = buildServiceEnv(paths(root), account, "expiry");
    expect(env.CCC_ENABLE_TEST_OVERRIDES).toBe("1");
    expect(env.CCC_APPROVAL_TEST_TTL_MS).toBe("15000");
    expect(env.CCC_APPROVAL_SWEEP_MS).toBe("500");
    expect(Object.keys(env)).toHaveLength(8);
  });

  it("refuses the default install-secret account and an account outside the ccc-uat family", () => {
    expect(() => buildServiceEnv(paths(root), "install-secret", "normal")).toThrow();
  });

  it("scrubInheritedEnv drops overrides, isolation variables and the spool path from a copy", () => {
    const inherited: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      HOME: "/home-x",
      CCC_ENABLE_TEST_OVERRIDES: "1",
      CCC_APPROVAL_TEST_TTL_MS: "1",
      CCC_APPROVAL_SWEEP_MS: "1",
      CCC_RUNTIME_DIR: "/a",
      CCC_SOCKET_PATH: "/a/s",
      CLAUDE_CONFIG_DIR: "/c",
      CODEX_HOME: "/x",
      CCC_INSTALL_SECRET_ACCOUNT: "install-secret",
      CCC_SPOOL_PATH: "/spool",
    };
    const scrubbed = scrubInheritedEnv(inherited);
    expect(scrubbed).toEqual({ PATH: "/usr/bin", HOME: "/home-x" });
    expect(inherited.CCC_SPOOL_PATH).toBe("/spool");
  });
});

describe("wdio env (Test 5)", () => {
  it("sets the renderer's socket, the run identity and TMPDIR inside the run root; no overrides", () => {
    const root = join("/tmp", RUN_ROOT_NAME);
    const env = buildWdioEnv(paths(root), { account: "ccc-uat-0123abcd", profile: "standard" });
    expect(env.CCC_SOCKET_PATH).toBe(join(root, "rt", "svc.sock"));
    expect(env.CCC_UAT_RUN_ROOT).toBe(root);
    expect(env.CCC_UAT_RUN_ID).toBe("0123abcd");
    expect(env.CCC_UAT_PROFILE).toBe("standard");
    expect(env.CCC_UAT_ACCOUNT).toBe("ccc-uat-0123abcd");
    expect(env.TMPDIR).toBe(join(root, "tmp"));
    expect(env.CCC_UAT_VAULT_LIVE).toBe(join(root, "vaults", "live"));
    expect(env.CCC_UAT_VAULT_BIG).toBeUndefined();
    expect(env.CCC_UAT_PLUGIN_STAGE).toBe(join(root, "plugin-stage"));
    for (const name of [
      "CCC_ENABLE_TEST_OVERRIDES",
      "CCC_APPROVAL_TEST_TTL_MS",
      "CCC_APPROVAL_SWEEP_MS",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("adds the big vault only in the full profile", () => {
    const root = join("/tmp", RUN_ROOT_NAME);
    const env = buildWdioEnv(paths(root), { account: "ccc-uat-0123abcd", profile: "full" });
    expect(env.CCC_UAT_VAULT_BIG).toBe(join(root, "vaults", "big"));
  });
});
