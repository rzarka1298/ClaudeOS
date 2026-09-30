import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Codex finding 1: readProject runs on refresh and on every subscribed
 * polling tick. A synchronous lstat/stat/realpath against a stalled network
 * or external volume blocks the whole event loop — the git call timeout,
 * the launch cap, the API and the heartbeats all stop. The root and `.git`
 * probes must be asynchronous.
 *
 * The synchronous probe functions are wrapped so that calling any of them
 * while a read is in flight fails the test; everything else in `node:fs`
 * (the fixture's own setup) is the real module.
 */
const guard = vi.hoisted(() => ({ armed: false, calls: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const trap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      if (guard.armed) guard.calls.push(name);
      return fn(...args);
    };
  const realpathSync = Object.assign(
    trap("realpathSync", real.realpathSync as (...a: unknown[]) => unknown),
    {
      native: trap("realpathSync.native", real.realpathSync.native as (...a: unknown[]) => unknown),
    },
  );
  const patched = {
    ...real,
    lstatSync: trap("lstatSync", real.lstatSync as (...a: unknown[]) => unknown),
    statSync: trap("statSync", real.statSync as (...a: unknown[]) => unknown),
    realpathSync,
    existsSync: trap("existsSync", real.existsSync),
    accessSync: trap("accessSync", real.accessSync),
  };
  return { ...patched, default: patched };
});

const { createFakeCommandRunner } = await import("../test-support/fake-command-runner.js");
const { createGitFixture, FIXTURE_GIT } = await import("../test-support/git-fixture.js");
const { createExecFileCommandRunner } = await import("./command-runner.js");
const { createGitRunner } = await import("./git-runner.js");

type Fixture = ReturnType<typeof createGitFixture>;
let fx: Fixture;

beforeEach(() => {
  fx = createGitFixture();
  guard.calls = [];
  guard.armed = false;
});

afterEach(() => {
  guard.armed = false;
  fx.cleanup();
});

async function read(root: string) {
  const runner = createFakeCommandRunner({ inner: createExecFileCommandRunner() });
  const git = createGitRunner({
    runner,
    git: { kind: "available", path: FIXTURE_GIT },
    homeDir: fx.home,
  });
  guard.armed = true;
  try {
    return await git.readProject(root);
  } finally {
    guard.armed = false;
  }
}

describe("readProject never blocks the event loop on a filesystem probe (codex finding 1)", () => {
  it("reads a repository with no synchronous filesystem call", async () => {
    const root = fx.repo("example-project", 1);
    expect((await read(root)).kind).toBe("repo");
    expect(guard.calls).toEqual([]);
  });

  it("reads a folder with no .git as not-a-repo with no synchronous filesystem call", async () => {
    const root = join(fx.base, "plain-folder");
    (await import("node:fs")).mkdirSync(root);
    expect(await read(root)).toEqual({ kind: "not-a-repo" });
    expect(guard.calls).toEqual([]);
  });

  it("reads a missing root as folder-missing with no synchronous filesystem call", async () => {
    expect(await read(join(fx.base, "gone"))).toEqual({ kind: "folder-missing" });
    expect(guard.calls).toEqual([]);
  });
});
