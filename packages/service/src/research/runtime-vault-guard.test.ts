import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeVaultGuard, lexicalInsideVault } from "./runtime-vault-guard.js";

// FIX3A MAJOR-1: "the runtime folder is inside the vault" is resolved ONCE, asynchronously, and
// cached. The per-request answer does no file work at all.

const RUNTIME = "/data/runtime";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("lexicalInsideVault (no file work)", () => {
  it("is true for the vault itself and anything below it, false for a sibling or a longer name", () => {
    expect(lexicalInsideVault("/v", "/v")).toBe(true);
    expect(lexicalInsideVault("/v/runtime", "/v")).toBe(true);
    expect(lexicalInsideVault("/v/", "/v/runtime")).toBe(false);
    expect(lexicalInsideVault("/vault-two/runtime", "/vault")).toBe(false);
    expect(lexicalInsideVault("/elsewhere", "/vault")).toBe(false);
  });
});

describe("createRuntimeVaultGuard", () => {
  it("answers false for no vault and never asks the file system", () => {
    const realpath = vi.fn(() => Promise.reject(new Error("must not be called")));
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => null,
      realpath,
    });
    expect(guard.insideVault(null)).toBe(false);
    expect(realpath).not.toHaveBeenCalled();
  });

  it("answers from the lexical rule before the first resolution finishes, with no file call on the request", () => {
    const pending = deferred<string>();
    const realpath = vi.fn(() => pending.promise);
    const guard = createRuntimeVaultGuard({
      runtimeDir: "/vault/runtime",
      getVaultRoot: () => "/vault",
      realpath,
    });
    expect(guard.insideVault("/vault")).toBe(true);
    const other = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath,
    });
    expect(other.insideVault("/vault")).toBe(false);
  });

  it("caches the resolved answer: a link into the vault is found once, asynchronously", async () => {
    const links: Record<string, string> = {
      [RUNTIME]: "/real/vault/runtime",
      "/vault": "/real/vault",
    };
    const realpath = vi.fn((path: string) => Promise.resolve(links[path] ?? path));
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath,
    });
    expect(guard.insideVault("/vault")).toBe(false); // lexical only, resolution not done
    await guard.refresh();
    const calls = realpath.mock.calls.length;
    expect(guard.insideVault("/vault")).toBe(true);
    expect(guard.insideVault("/vault")).toBe(true);
    expect(realpath.mock.calls.length).toBe(calls); // the request path did no file work
  });

  it("an unresolvable folder holds no file to protect: false, like the synchronous check", async () => {
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath: () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
    });
    await guard.refresh();
    expect(guard.insideVault("/vault")).toBe(false);
  });

  it("a changed vault root is picked up by a background resolution, never by the request", async () => {
    let root = "/vault-a";
    const links: Record<string, string> = { [RUNTIME]: "/vault-b/runtime" };
    const realpath = vi.fn((path: string) => Promise.resolve(links[path] ?? path));
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => root,
      realpath,
    });
    await guard.refresh();
    expect(guard.insideVault("/vault-a")).toBe(false);
    root = "/vault-b";
    const before = realpath.mock.calls.length;
    expect(guard.insideVault("/vault-b")).toBe(false); // not resolved yet, lexical answer
    expect(realpath.mock.calls.length).toBeGreaterThan(before); // a background resolution started
    await guard.refresh();
    expect(guard.insideVault("/vault-b")).toBe(true);
  });

  it("starts at most one resolution at a time (a stalled mount holds one worker, not one per check)", async () => {
    const pending = deferred<string>();
    const realpath = vi.fn(() => pending.promise);
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath,
    });
    for (let i = 0; i < 20; i += 1) guard.insideVault("/vault");
    const first = guard.refresh();
    const second = guard.refresh();
    expect(realpath.mock.calls.length).toBeLessThanOrEqual(2); // runtime + vault, once
    pending.resolve("/x");
    await Promise.all([first, second]);
  });

  it("never rejects, even when the file system call throws synchronously", async () => {
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath: () => {
        throw new Error("sync throw");
      },
    });
    await expect(guard.refresh()).resolves.toBeUndefined();
    expect(guard.insideVault("/vault")).toBe(false);
  });
});

describe("FIX6A opus minor 5: a failed or stuck resolution is retried, never cached for good", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failed realpath is retried on the next refresh after the backoff, not before", async () => {
    let clock = 1_000;
    let failing = true;
    const links: Record<string, string> = {
      [RUNTIME]: "/real/vault/runtime",
      "/vault": "/real/vault",
    };
    const realpath = vi.fn((path: string) =>
      failing
        ? Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }))
        : Promise.resolve(links[path] ?? path),
    );
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath,
      nowMs: () => clock,
    });
    await guard.refresh();
    expect(guard.insideVault("/vault")).toBe(false);
    const afterFailure = realpath.mock.calls.length;

    // Inside the backoff nothing is asked again, however often it is asked.
    failing = false;
    clock += 1_000;
    await guard.refresh();
    guard.insideVault("/vault");
    await guard.refresh();
    expect(realpath.mock.calls.length).toBe(afterFailure);
    expect(guard.insideVault("/vault")).toBe(false);
    await guard.refresh(); // let the background check that call started finish

    // After the backoff the next refresh resolves it, and the real answer replaces the failure.
    clock += 60_000;
    await guard.refresh();
    expect(realpath.mock.calls.length).toBeGreaterThan(afterFailure);
    expect(guard.insideVault("/vault")).toBe(true);
  });

  it("while a resolution has failed the request answers with the lexical rule, so a folder lexically inside the vault is still protected", async () => {
    const guard = createRuntimeVaultGuard({
      runtimeDir: "/vault/runtime",
      getVaultRoot: () => "/vault",
      realpath: () => Promise.reject(new Error("EIO")),
    });
    await guard.refresh();
    expect(guard.insideVault("/vault")).toBe(true);
  });

  it("a never-settling realpath does not stick the refresh: it is bounded by a timeout and the in-flight entry is cleared", async () => {
    let clock = 0;
    const links: Record<string, string> = {
      [RUNTIME]: "/real/vault/runtime",
      "/vault": "/real/vault",
    };
    const stuckCalls: Array<() => void> = [];
    let stuck = true;
    const realpath = vi.fn((path: string) =>
      stuck
        ? new Promise<string>((resolve) => {
            stuckCalls.push(() => resolve(links[path] ?? path));
          })
        : Promise.resolve(links[path] ?? path),
    );
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath,
      nowMs: () => clock,
      timeoutMs: 5_000,
    });
    const first = guard.refresh();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await first;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(guard.insideVault("/vault")).toBe(false);

    // The mount recovers (the stuck call finally answers): after the backoff a new refresh is not
    // blocked by the earlier one.
    stuck = false;
    for (const answer of stuckCalls) answer();
    await guard.refresh(); // the background check the insideVault call above started
    clock += 120_000;
    await guard.refresh();
    expect(guard.insideVault("/vault")).toBe(true);
  });

  it("a stuck realpath is shared, not piled up: repeated refreshes after each timeout start no further call for that path", async () => {
    let clock = 0;
    const realpath = vi.fn(() => new Promise<string>(() => undefined));
    const guard = createRuntimeVaultGuard({
      runtimeDir: RUNTIME,
      getVaultRoot: () => "/vault",
      realpath,
      nowMs: () => clock,
      timeoutMs: 1_000,
    });
    for (let i = 0; i < 4; i += 1) {
      const pending = guard.refresh();
      await vi.advanceTimersByTimeAsync(1_001);
      await pending;
      clock += 120_000;
    }
    expect(realpath).toHaveBeenCalledTimes(1);
  });
});
