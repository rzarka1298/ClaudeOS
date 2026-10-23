import { describe, expect, it, vi } from "vitest";
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
