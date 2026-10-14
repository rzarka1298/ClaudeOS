import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./repo-paths.js";
import {
  assertCacheDir,
  assertIsolatedEnv,
  assertShotsDir,
  MSG_CACHE_DIR,
  MSG_ISOLATION,
  MSG_SHOTS_DIR,
} from "./uat-env.js";

const HOME = "/Users/USERNAME";
const RUN_ROOT = "/tmp/ccc-uat.AbC123";

function goodEnv(): Record<string, string | undefined> {
  return {
    CCC_SOCKET_PATH: `${RUN_ROOT}/rt/svc.sock`,
    CCC_RUNTIME_DIR: `${RUN_ROOT}/rt`,
    CLAUDE_CONFIG_DIR: `${RUN_ROOT}/claude`,
    CODEX_HOME: `${RUN_ROOT}/codex`,
    CCC_INSTALL_SECRET_ACCOUNT: "ccc-uat-abc123",
  };
}

describe("assertIsolatedEnv (HIGH-1, D-05, L-3)", () => {
  it("accepts a fully isolated environment", () => {
    expect(() => assertIsolatedEnv(goodEnv(), { runRoot: RUN_ROOT, home: HOME })).not.toThrow();
  });

  for (const name of [
    "CCC_SOCKET_PATH",
    "CCC_RUNTIME_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "CCC_INSTALL_SECRET_ACCOUNT",
  ]) {
    it(`refuses when ${name} is unset or empty`, () => {
      for (const value of [undefined, ""]) {
        const env = { ...goodEnv(), [name]: value };
        expect(() => assertIsolatedEnv(env, { runRoot: RUN_ROOT, home: HOME })).toThrow(
          MSG_ISOLATION,
        );
      }
    });
  }

  it("refuses the owner's live socket", () => {
    const env = { ...goodEnv(), CCC_SOCKET_PATH: `${HOME}/.claude-command-center/svc.sock` };
    expect(() => assertIsolatedEnv(env, { runRoot: RUN_ROOT, home: HOME })).toThrow(MSG_ISOLATION);
  });

  for (const name of ["CCC_SOCKET_PATH", "CCC_RUNTIME_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    it(`refuses ${name} outside the run root, relative, or a prefix sibling`, () => {
      for (const value of [`${HOME}/x`, "relative/x", `${RUN_ROOT}-evil/x`, RUN_ROOT]) {
        const env = { ...goodEnv(), [name]: value };
        expect(() => assertIsolatedEnv(env, { runRoot: RUN_ROOT, home: HOME })).toThrow(
          MSG_ISOLATION,
        );
      }
    });
  }

  it("refuses an install-secret account without the ccc-uat- prefix", () => {
    for (const value of ["claude-command-center", "ccc-uat", "xccc-uat-1", "ccc-uat-"]) {
      const env = { ...goodEnv(), CCC_INSTALL_SECRET_ACCOUNT: value };
      expect(() => assertIsolatedEnv(env, { runRoot: RUN_ROOT, home: HOME })).toThrow(
        MSG_ISOLATION,
      );
    }
  });

  it("never echoes the offending value", () => {
    const env = { ...goodEnv(), CCC_SOCKET_PATH: `${HOME}/secret-place/svc.sock` };
    try {
      assertIsolatedEnv(env, { runRoot: RUN_ROOT, home: HOME });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-place");
    }
  });
});

describe("assertShotsDir resolves symlinks (Codex review)", () => {
  it("refuses an outside-looking path that is a symlink into the repository", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ccc-shots-link-")));
    const repo = join(base, "repo");
    mkdirSync(join(repo, "inside"), { recursive: true });
    const link = join(base, "link");
    symlinkSync(join(repo, "inside"), link);
    expect(() => assertShotsDir(link, repo)).toThrow(MSG_SHOTS_DIR);
    expect(() => assertShotsDir(join(link, "deeper"), repo)).toThrow(MSG_SHOTS_DIR);
    const other = join(base, "other");
    mkdirSync(other);
    expect(() => assertShotsDir(other, repo)).not.toThrow();
  });
});

describe("assertShotsDir and assertCacheDir (MEDIUM-2, D-08, D-12)", () => {
  it("refuses a relative or in-repository screenshot directory", () => {
    expect(() => assertShotsDir("shots", REPO_ROOT)).toThrow(MSG_SHOTS_DIR);
    expect(() => assertShotsDir(`${REPO_ROOT}/tmp/shots`, REPO_ROOT)).toThrow(MSG_SHOTS_DIR);
    expect(() => assertShotsDir(REPO_ROOT, REPO_ROOT)).toThrow(MSG_SHOTS_DIR);
    expect(() => assertShotsDir(`${REPO_ROOT}-sibling/shots`, REPO_ROOT)).not.toThrow();
    expect(() => assertShotsDir("/tmp/ccc-uat.AbC123/shots", REPO_ROOT)).not.toThrow();
  });

  it("allows an in-repository cache only when it is .obsidian-cache", () => {
    expect(() => assertCacheDir(`${REPO_ROOT}/cache`, REPO_ROOT)).toThrow(MSG_CACHE_DIR);
    expect(() => assertCacheDir("rel/.obsidian-cache", REPO_ROOT)).toThrow(MSG_CACHE_DIR);
    expect(() => assertCacheDir(`${REPO_ROOT}/.obsidian-cache`, REPO_ROOT)).not.toThrow();
    expect(() => assertCacheDir("/tmp/anywhere-else/cache", REPO_ROOT)).not.toThrow();
  });
});

describe("wdio.smoke.conf.ts wiring (HIGH-1)", () => {
  it("calls the isolation, shots and cache guards before building capabilities", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "wdio.smoke.conf.ts"),
      "utf8",
    );
    const build = source.indexOf("buildLaunchCapabilities({");
    for (const call of ["assertIsolatedEnv(", "assertShotsDir(", "assertCacheDir("]) {
      const at = source.indexOf(call);
      expect(at, call).toBeGreaterThan(-1);
      expect(at, call).toBeLessThan(build);
    }
  });
});
