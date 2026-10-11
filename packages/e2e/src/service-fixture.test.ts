import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServiceEnv } from "./isolation-guards.js";
import { createRunRoot, type RunRootPaths } from "./run-root.js";
import { SERVICE_ENTRY } from "./repo-paths.js";
import type { Stoppable } from "./sandbox.js";
import { createServiceFixture } from "./service-fixture.js";

let base: string;
let paths: RunRootPaths;

beforeEach(() => {
  base = mkdtempSync("/tmp/ccc-e2e-sf.");
  paths = createRunRoot({ base });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const ACCOUNT = "ccc-uat-0123abcd";

function fakeHandle(pid: number, behaviour: { stopHangs?: boolean } = {}) {
  return {
    pid,
    stop: vi.fn<() => Promise<void>>(() =>
      behaviour.stopHangs ? new Promise<void>(() => undefined) : Promise.resolve(),
    ),
    kill: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
}

function setup(handles: Array<ReturnType<typeof fakeHandle>>, wait?: (ms: number) => Promise<void>) {
  const sandbox = {
    paths,
    account: ACCOUNT,
    registerService: vi.fn<(handle: Stoppable, marker?: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    unregister: vi.fn<(handle: Stoppable) => void>(),
  };
  let next = 0;
  const startService = vi.fn(() => {
    const handle = handles[next++];
    if (handle === undefined) return Promise.reject(new Error("no more handles"));
    return Promise.resolve(handle);
  });
  const fixture = createServiceFixture(sandbox, {
    startService,
    wait: wait ?? (() => new Promise<void>(() => undefined)),
    home: join(base, "home"),
  });
  return { sandbox, startService, fixture };
}

describe("service fixture start (Test 5)", () => {
  it("starts with the sandbox env and records the pid with the service entry marker", async () => {
    const handle = fakeHandle(7001);
    const { sandbox, startService, fixture } = setup([handle]);
    await fixture.start({ kind: "normal" });
    expect(startService).toHaveBeenCalledWith({
      socketPath: paths.socketPath,
      dbPath: paths.dbPath,
      env: buildServiceEnv(paths, ACCOUNT, "normal"),
    });
    expect(sandbox.registerService).toHaveBeenCalledWith(handle, SERVICE_ENTRY);
    expect(fixture.isRunning()).toBe(true);
  });

  it("adds the three override variables for the expiry kind and passes waitAttempts", async () => {
    const { startService, fixture } = setup([fakeHandle(7002)]);
    await fixture.start({ kind: "expiry", waitAttempts: 600 });
    const call = startService.mock.calls[0] as unknown as [{ env: Record<string, string>; waitAttempts: number }];
    expect(call[0].env.CCC_ENABLE_TEST_OVERRIDES).toBe("1");
    expect(call[0].env.CCC_APPROVAL_TEST_TTL_MS).toBe("15000");
    expect(call[0].env.CCC_APPROVAL_SWEEP_MS).toBe("500");
    expect(call[0].waitAttempts).toBe(600);
  });

  it("throws when a service is already running", async () => {
    const { fixture } = setup([fakeHandle(7003), fakeHandle(7004)]);
    await fixture.start({});
    await expect(fixture.start({})).rejects.toThrow(/already running/);
  });

  it("refuses to start when the sandbox locations resolve to the owner's real folders", async () => {
    const { fixture, startService } = setup([fakeHandle(7005)]);
    const real = createServiceFixture(
      { paths: { ...paths, runtimeDir: join(base, "home", ".claude-command-center") }, account: ACCOUNT, registerService: vi.fn(), unregister: vi.fn() },
      { startService, wait: () => new Promise<void>(() => undefined), home: join(base, "home") },
    );
    await expect(real.start({})).rejects.toThrow(/real runtime directory|run root/);
    expect(startService).not.toHaveBeenCalled();
    expect(fixture.isRunning()).toBe(false);
  });
});

describe("service fixture stop, restart, reset (Test 6)", () => {
  it("stop stops the handle and unregisters it from the sandbox", async () => {
    const handle = fakeHandle(7101);
    const { sandbox, fixture } = setup([handle]);
    await fixture.start({});
    await fixture.stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(handle.kill).not.toHaveBeenCalled();
    expect(sandbox.unregister).toHaveBeenCalledWith(handle);
    expect(fixture.isRunning()).toBe(false);
  });

  it("stop escalates to kill after the injected deadline", async () => {
    const handle = fakeHandle(7102, { stopHangs: true });
    const { fixture } = setup([handle], () => Promise.resolve());
    await fixture.start({});
    await fixture.stop();
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it("restart stops then starts on the same runtime directory and account, ledgering the new pid", async () => {
    const first = fakeHandle(7103);
    const second = fakeHandle(7104);
    const { sandbox, startService, fixture } = setup([first, second]);
    await fixture.start({ kind: "expiry" });
    await fixture.restart();
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(startService).toHaveBeenCalledTimes(2);
    const calls = startService.mock.calls as unknown as Array<[{ socketPath: string; env: Record<string, string> }]>;
    expect(calls[1]?.[0].socketPath).toBe(paths.socketPath);
    expect(calls[1]?.[0].env).toEqual(calls[0]?.[0].env);
    expect(sandbox.registerService).toHaveBeenLastCalledWith(second, SERVICE_ENTRY);
  });

  it("resetData stops the service and removes the store, logs and spool but never the runtime directory", async () => {
    const handle = fakeHandle(7105);
    const { fixture } = setup([handle]);
    await fixture.start({});
    for (const name of ["operational.db", "operational.db-wal", "operational.db-shm", "keep.txt"]) {
      writeFileSync(join(paths.runtimeDir, name), "x");
    }
    for (const name of ["logs", "spool"]) {
      mkdirSync(join(paths.runtimeDir, name));
      writeFileSync(join(paths.runtimeDir, name, "f"), "x");
    }
    await fixture.resetData();
    expect(handle.stop).toHaveBeenCalledTimes(1);
    for (const name of ["operational.db", "operational.db-wal", "operational.db-shm", "logs", "spool"]) {
      expect(existsSync(join(paths.runtimeDir, name))).toBe(false);
    }
    expect(existsSync(join(paths.runtimeDir, "keep.txt"))).toBe(true);
    expect(statSync(paths.runtimeDir).mode & 0o777).toBe(0o700);
    expect(fixture.isRunning()).toBe(false);
  });

  it("surfaces the harness error from a service that never exposes its socket, still handing its handle to teardown", async () => {
    const orphan = fakeHandle(7106);
    const failure = Object.assign(new Error("Service socket never became reachable"), { handle: orphan });
    const sandbox = {
      paths,
      account: ACCOUNT,
      registerService: vi.fn<(handle: Stoppable, marker?: string) => Promise<void>>(() => Promise.resolve()),
      unregister: vi.fn(),
    };
    const fixture = createServiceFixture(sandbox, {
      startService: () => Promise.reject(failure),
      wait: () => new Promise<void>(() => undefined),
      home: join(base, "home"),
    });
    await expect(fixture.start({})).rejects.toBe(failure);
    expect(sandbox.registerService).toHaveBeenCalledWith(orphan, SERVICE_ENTRY);
    expect(fixture.isRunning()).toBe(false);
  });
});
