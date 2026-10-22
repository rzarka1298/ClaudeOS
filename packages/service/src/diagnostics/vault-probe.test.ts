import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProbeOutcome, VaultRowSchema } from "@ccc/domain";
import { initializeVault } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type NamedProbe, runProbes } from "./run-probes.js";
import { probeVault, type VaultFsPorts, type VaultProbePorts } from "./vault-probe.js";

/**
 * Plan 08-07 Task 3 (D-04, D-05; T-08-15, T-08-16, T-08-18): the vault probe against temporary
 * folders and injected file systems. It reads only the persisted root, answers closed codes, never
 * returns a path or an errno message, never writes, and never calls the synchronous managed-tree
 * plan before the root has answered.
 */

const ROOT_IS_NOT_A_PATH = "/Users/USERNAME/never-shown/vault";
const SIGNAL = new AbortController().signal;
/** Records a call and returns what the fake answers: keeps the fakes free of the comma operator. */
function note<T>(log: string[], name: string, value: T): T {
  log.push(name);
  return value;
}

const roots: string[] = [];
const restore: (() => void)[] = [];

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ccc-vault-probe-")));
  roots.push(dir);
  return dir;
}

/** A vault the managed setup would call ready: `.obsidian` plus the managed tree. */
function readyVault(): string {
  const root = scratch();
  mkdirSync(join(root, ".obsidian"));
  initializeVault(root);
  return root;
}

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ports = (root: string | null, extra: Partial<VaultProbePorts> = {}): VaultProbePorts => ({
  readRoot: () => root,
  ...extra,
});

function outcomeIsClosed(outcome: ProbeOutcome, root: string | null): void {
  // Every outcome is a valid vault row (minus the check time the runner adds) and carries no path.
  const row = { ...outcome, checkedAt: "2026-10-22T09:00:00.000Z", freshness: "live" };
  expect(VaultRowSchema.safeParse(row).success, JSON.stringify(outcome)).toBe(true);
  if (root !== null) expect(JSON.stringify(outcome)).not.toContain(root);
  expect(JSON.stringify(outcome)).not.toMatch(/\/Users\/|ENOENT|EACCES|ENOTDIR|no such file/i);
}

describe("Test 1: no persisted root", () => {
  it("reads vault-not-set-up with the vault-setup plugin command and touches no file system", async () => {
    const calls: string[] = [];
    const fs: VaultFsPorts = {
      stat: () => note(calls, "stat", Promise.reject(new Error("no"))),
      access: () => note(calls, "access", Promise.reject(new Error("no"))),
      realpath: () => note(calls, "realpath", Promise.reject(new Error("no"))),
    };
    const outcome = await probeVault(ports(null, { fs }), SIGNAL);
    expect(outcome).toEqual({
      id: "vault",
      status: "setup-needed",
      reasonCode: "vault-not-set-up",
      setupAction: { kind: "run-plugin-command", command: "vault-setup" },
    });
    expect(calls).toEqual([]);
    outcomeIsClosed(outcome, null);
  });
});

describe("Test 2: every state against temporary folders", () => {
  it("a ready vault reads vault-ready", async () => {
    const root = readyVault();
    const outcome = await probeVault(ports(root), SIGNAL);
    expect(outcome).toEqual({ id: "vault", status: "ok", reasonCode: "vault-ready" });
    outcomeIsClosed(outcome, root);
  });

  it("a missing root reads vault-root-missing", async () => {
    const root = join(scratch(), "gone");
    const outcome = await probeVault(ports(root), SIGNAL);
    expect(outcome).toMatchObject({ status: "failing", reasonCode: "vault-root-missing" });
    outcomeIsClosed(outcome, root);
  });

  it("a file instead of a folder reads vault-root-not-directory, as does a path below a file", async () => {
    const dir = scratch();
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    for (const root of [file, join(file, "child")]) {
      const outcome = await probeVault(ports(root), SIGNAL);
      expect(outcome, root).toMatchObject({
        status: "failing",
        reasonCode: "vault-root-not-directory",
      });
      outcomeIsClosed(outcome, root);
    }
  });

  it.skipIf(process.getuid?.() === 0)("mode 000 reads vault-root-unreadable", async () => {
    const root = readyVault();
    chmodSync(root, 0o000);
    restore.push(() => chmodSync(root, 0o700));
    const outcome = await probeVault(ports(root), SIGNAL);
    expect(outcome).toMatchObject({ status: "failing", reasonCode: "vault-root-unreadable" });
    outcomeIsClosed(outcome, root);
  });

  it.skipIf(process.getuid?.() === 0)("mode 500 reads vault-root-not-writable", async () => {
    const root = readyVault();
    chmodSync(root, 0o500);
    restore.push(() => chmodSync(root, 0o700));
    const outcome = await probeVault(ports(root), SIGNAL);
    expect(outcome).toMatchObject({ status: "failing", reasonCode: "vault-root-not-writable" });
    outcomeIsClosed(outcome, root);
  });

  it("a root without .obsidian reads not-an-obsidian-vault", async () => {
    const root = scratch();
    const outcome = await probeVault(ports(root), SIGNAL);
    expect(outcome).toMatchObject({ status: "degraded", reasonCode: "not-an-obsidian-vault" });
    outcomeIsClosed(outcome, root);
  });

  it("a forbidden location reads vault-root-refused: the real /etc, and an injected forbidden folder", async () => {
    const etc = await probeVault(ports("/etc"), SIGNAL);
    expect(etc).toMatchObject({ status: "failing", reasonCode: "vault-root-refused" });
    outcomeIsClosed(etc, null);

    const root = readyVault();
    const injected = await probeVault(ports(root, { isForbiddenRoot: (p) => p === root }), SIGNAL);
    expect(injected).toMatchObject({ reasonCode: "vault-root-refused" });
  });

  it("a root that is not an absolute, NUL-free path reads vault-root-refused without touching the file system", async () => {
    const calls: string[] = [];
    const fs: VaultFsPorts = {
      stat: () => note(calls, "stat", Promise.reject(new Error("no"))),
      access: () => note(calls, "access", Promise.reject(new Error("no"))),
      realpath: () => note(calls, "realpath", Promise.reject(new Error("no"))),
    };
    for (const root of ["relative/vault", "../vault", "/ok\u0000/vault", ""]) {
      const outcome = await probeVault(ports(root, { fs }), SIGNAL);
      expect(outcome, JSON.stringify(root)).toMatchObject({ reasonCode: "vault-root-refused" });
    }
    expect(calls).toEqual([]);
  });

  it("a missing managed folder reads managed-tree-incomplete", async () => {
    const root = readyVault();
    rmSync(join(root, "inbox"), { recursive: true, force: true });
    const outcome = await probeVault(ports(root), SIGNAL);
    expect(outcome).toMatchObject({ status: "degraded", reasonCode: "managed-tree-incomplete" });
    outcomeIsClosed(outcome, root);
  });

  it("a missing index or CLAUDE.md alone does not make the tree incomplete", async () => {
    const root = readyVault();
    rmSync(join(root, "CLAUDE.md"), { force: true });
    rmSync(join(root, "inbox", "index.md"), { force: true });
    expect(await probeVault(ports(root), SIGNAL)).toMatchObject({ reasonCode: "vault-ready" });
  });

  it("an errno the table does not know reads probe-error, never a guess", async () => {
    const root = readyVault();
    const fs: VaultFsPorts = {
      stat: () =>
        Promise.reject(Object.assign(new Error(`EIO: i/o error, stat '${root}'`), { code: "EIO" })),
      access: () => Promise.resolve(),
      realpath: () => Promise.resolve(root),
    };
    const outcome = await probeVault(ports(root, { fs }), SIGNAL);
    expect(outcome).toEqual({ id: "vault", status: "unknown", reasonCode: "probe-error" });
    outcomeIsClosed(outcome, root);
  });

  it("maps access errors by code: EACCES unreadable, EROFS not writable, anything else probe-error", async () => {
    const root = readyVault();
    const failing = (code: string, fail: "read" | "write"): VaultFsPorts => ({
      stat: (path) => import("node:fs/promises").then((fs) => fs.stat(path)),
      realpath: (path) => import("node:fs/promises").then((fs) => fs.realpath(path)),
      access: (_path, mode) =>
        // R_OK is 4, W_OK is 2, X_OK is 1; fail only the check being exercised.
        (fail === "read" ? (mode & 4) !== 0 : (mode & 2) !== 0 && (mode & 4) === 0)
          ? Promise.reject(Object.assign(new Error(`${code} at ${root}`), { code }))
          : Promise.resolve(),
    });
    expect(await probeVault(ports(root, { fs: failing("EACCES", "read") }), SIGNAL)).toMatchObject({
      reasonCode: "vault-root-unreadable",
    });
    expect(await probeVault(ports(root, { fs: failing("EROFS", "write") }), SIGNAL)).toMatchObject({
      reasonCode: "vault-root-not-writable",
    });
    expect(await probeVault(ports(root, { fs: failing("EIO", "read") }), SIGNAL)).toMatchObject({
      reasonCode: "probe-error",
    });
  });
});

describe("Test 3: the abort signal and the synchronous plan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an aborted signal during the root stat yields the runner's timeout row and the plan is never called", async () => {
    const root = readyVault();
    const order: string[] = [];
    const fs: VaultFsPorts = {
      stat: () => note(order, "stat", new Promise(() => undefined)),
      access: () => note(order, "access", Promise.resolve()),
      realpath: () => note(order, "realpath", Promise.resolve(root)),
    };
    const plan = vi.fn(() => {
      order.push("plan");
      throw new Error("must not be called");
    });
    const probe: NamedProbe = {
      id: "vault",
      run: (signal) => probeVault(ports(root, { fs, plan }), signal),
    };
    const done = runProbes([probe], "reconnect", { now: () => new Date(Date.now()) });
    await vi.advanceTimersByTimeAsync(2000);
    const [row] = await done;
    expect(row).toMatchObject({
      id: "vault",
      status: "unknown",
      reasonCode: "probe-timeout",
      freshness: "unavailable",
    });
    expect(order).toEqual(["stat"]);
    expect(plan).not.toHaveBeenCalled();
  });

  it("an already-aborted signal answers probe-timeout without calling the file system", async () => {
    const calls: string[] = [];
    const fs: VaultFsPorts = {
      stat: () => note(calls, "stat", Promise.resolve({ isDirectory: () => true })),
      access: () => note(calls, "access", Promise.resolve()),
      realpath: () => note(calls, "realpath", Promise.resolve("/x")),
    };
    const controller = new AbortController();
    controller.abort();
    const outcome = await probeVault(ports("/some/vault", { fs }), controller.signal);
    expect(outcome).toEqual({ id: "vault", status: "unknown", reasonCode: "probe-timeout" });
    expect(calls).toEqual([]);
  });

  it("calls the file system in the documented order and the plan last, only after the root answered", async () => {
    const root = readyVault();
    const order: string[] = [];
    const real = await import("node:fs/promises");
    const fs: VaultFsPorts = {
      stat: (path) => note(order, path === root ? "stat-root" : "stat-marker", real.stat(path)),
      access: (path, mode) => note(order, `access-${mode}`, real.access(path, mode)),
      realpath: (path) => note(order, "realpath", real.realpath(path)),
    };
    const plan = vi.fn((r: string) => {
      order.push("plan");
      return { vaultRoot: r, entries: [] };
    });
    await probeVault(ports(root, { fs, plan }), SIGNAL);
    expect(order[0]).toBe("stat-root");
    expect(order.at(-1)).toBe("plan");
    expect(order.indexOf("realpath")).toBeLessThan(order.indexOf("plan"));
    expect(order.filter((step) => step === "plan")).toHaveLength(1);
  });

  it("aborts between the async checks and the plan: a signal that fires after the marker check skips the plan", async () => {
    const root = readyVault();
    const controller = new AbortController();
    const real = await import("node:fs/promises");
    const fs: VaultFsPorts = {
      stat: async (path) => {
        const result = await real.stat(path);
        if (path.endsWith(".obsidian")) controller.abort();
        return result;
      },
      access: (path, mode) => real.access(path, mode),
      realpath: (path) => real.realpath(path),
    };
    const plan = vi.fn(() => ({ vaultRoot: root, entries: [] }));
    const outcome = await probeVault(ports(root, { fs, plan }), controller.signal);
    expect(outcome).toEqual({ id: "vault", status: "unknown", reasonCode: "probe-timeout" });
    expect(plan).not.toHaveBeenCalled();
  });
});

describe("Test 4: no path and no errno message in any result", () => {
  it("never echoes a path or an error message that the file system or the plan carried", async () => {
    const root = ROOT_IS_NOT_A_PATH;
    const leaky = (code: string): VaultFsPorts => ({
      stat: () =>
        Promise.reject(Object.assign(new Error(`${code}: failed on '${root}'`), { code })),
      access: () =>
        Promise.reject(Object.assign(new Error(`${code}: failed on '${root}'`), { code })),
      realpath: () =>
        Promise.reject(Object.assign(new Error(`${code}: failed on '${root}'`), { code })),
    });
    for (const code of ["ENOENT", "EACCES", "ENOTDIR", "EIO", "ELOOP", "EPERM"]) {
      const outcome = await probeVault(ports(root, { fs: leaky(code) }), SIGNAL);
      const text = JSON.stringify(outcome);
      expect(text, code).not.toContain("never-shown");
      expect(text, code).not.toContain(code);
      expect(Object.keys(outcome).sort(), code).toEqual(["id", "reasonCode", "status"]);
    }
    const throwingPlan: VaultProbePorts["plan"] = () => {
      throw new Error(`plan failed for ${root}`);
    };
    const readyFs: VaultFsPorts = {
      stat: () => Promise.resolve({ isDirectory: () => true }),
      access: () => Promise.resolve(),
      realpath: () => Promise.resolve(root),
    };
    const outcome = await probeVault(
      ports(root, { fs: readyFs, plan: throwingPlan, isForbiddenRoot: () => false }),
      SIGNAL,
    );
    expect(outcome).toEqual({ id: "vault", status: "unknown", reasonCode: "probe-error" });
  });

  it("opens nothing for writing: the file system port has no write member and the probe is read-only on disk", async () => {
    const root = readyVault();
    const before = JSON.stringify(
      (await import("node:fs")).readdirSync(root, { recursive: true }).sort(),
    );
    await probeVault(ports(root), SIGNAL);
    const after = JSON.stringify(
      (await import("node:fs")).readdirSync(root, { recursive: true }).sort(),
    );
    expect(after).toBe(before);
    const members: (keyof VaultFsPorts)[] = ["stat", "access", "realpath"];
    expect(members).toHaveLength(3);
  });
});
