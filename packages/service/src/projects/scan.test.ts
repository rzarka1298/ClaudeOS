import type { Dirent } from "node:fs";
import fs, {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { ScanStateResponseSchema } from "@ccc/domain";
import {
  applyMigrations,
  insertProject,
  listProjects,
  listScanRoots,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The walker's hardening (plan 04-13 Task 2, D-07, T-04-02, T-04-13,
 * T-04-35). Every tree is a `/tmp` mkdtemp; the "home" the service judges
 * protected locations and display paths against is a folder inside it, so
 * nothing here reads the real home folder. `CCC_RUNTIME_DIR` points the
 * service logger at a throwaway directory before `scan.js` loads.
 */

const runtimeDir = realpathSync.native(mkdtempSync("/tmp/ccc-walk-rt-"));
process.env.CCC_RUNTIME_DIR = runtimeDir;

const scanModule = await import("./scan.js");
const { createScanService, SCAN_ENTRY_CAP, SCAN_TIME_CAP_MS } = scanModule;
type ScanServiceDeps = import("./scan.js").ScanServiceDeps;

afterAll(() => {
  delete process.env.CCC_RUNTIME_DIR;
  rmSync(runtimeDir, { recursive: true, force: true });
});

let base: string;
let fakeHome: string;
let root: string;
let outside: string;
let store: OperationalStore;
/** Every directory the walker listed, in order. */
let listed: string[];
let logLines: Array<{ fields: Record<string, unknown>; message: string }>;

/** The real fs.promises, with every readdir recorded. */
function recordingFs(
  readdirOverride?: (path: string) => Promise<Dirent[]> | null,
): NonNullable<ScanServiceDeps["fs"]> {
  return {
    readdir: (path: string) => {
      listed.push(path);
      const override = readdirOverride?.(path);
      if (override) return override;
      return fsPromises.readdir(path, { withFileTypes: true });
    },
    realpath: (path: string) => fsPromises.realpath(path),
  };
}

function makeService(extra: Partial<ScanServiceDeps> = {}) {
  return createScanService({
    store,
    homeDir: fakeHome,
    readPolicy: () => ({ homeDir: fakeHome, runtimeDir, vaultRoot: null }),
    fs: recordingFs(),
    log: {
      info: (fields, message) => logLines.push({ fields, message }),
      warn: (fields, message) => logLines.push({ fields, message }),
    },
    ...extra,
  });
}

function git(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

async function addRoot(service: ReturnType<typeof makeService>, depth?: number) {
  const outcome = await service.add(root, { depth, acknowledged: false });
  if (outcome.kind !== "state") throw new Error(`add answered ${outcome.kind}`);
  return ScanStateResponseSchema.parse(outcome.state);
}

function names(state: { suggestions: ReadonlyArray<{ folderName: string }> }): string[] {
  return state.suggestions.map((s) => s.folderName).sort();
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync("/tmp/ccc-walk-"));
  fakeHome = join(base, "home");
  root = join(fakeHome, "code");
  outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  listed = [];
  logLines = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("depth (D-07: default 1, at most 3)", () => {
  beforeEach(() => {
    git(join(root, "a"));
    git(join(root, "x", "b"));
    git(join(root, "x", "y", "c"));
  });

  it("depth 1 finds a/.git; depth 2 adds x/b/.git; depth 3 adds x/y/c/.git", async () => {
    const service = makeService();
    const first = await addRoot(service);
    expect(first.scanRoots[0]?.depth).toBe(1);
    expect(names(first)).toEqual(["a"]);
    const id = first.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");

    const second = await service.rescan(id, 2);
    expect(second.kind === "state" && names(second.state)).toEqual(["a", "b"]);
    const third = await service.rescan(id, 3);
    expect(third.kind === "state" && names(third.state)).toEqual(["a", "b", "c"]);
    expect(listScanRoots(store.db)[0]?.depth).toBe(3);
  });

  it("refuses a depth of 4 (or 0) without scanning", async () => {
    const service = makeService();
    expect((await service.add(root, { depth: 4, acknowledged: false })).kind).toBe("invalid");
    expect(listScanRoots(store.db)).toHaveLength(0);
    const first = await addRoot(service);
    const id = first.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    listed = [];
    expect((await service.rescan(id, 4)).kind).toBe("invalid");
    expect((await service.rescan(id, 0)).kind).toBe("invalid");
    expect(listed).toEqual([]);
  });
});

describe("what the walker skips and where it stops", () => {
  it("never suggests hidden folders or node_modules, and never lists inside them", async () => {
    git(join(root, ".hidden", "d"));
    git(join(root, ".dotrepo"));
    git(join(root, "node_modules", "e"));
    git(join(root, "a"));
    const state = await addRoot(makeService(), 3);
    expect(names(state)).toEqual(["a"]);
    expect(listed.some((p) => p.includes(".hidden") || p.includes("node_modules"))).toBe(false);
  });

  it("a .git FILE (worktree style) makes a candidate, and a candidate is never descended into", async () => {
    mkdirSync(join(root, "w", "inner"), { recursive: true });
    writeFileSync(join(root, "w", ".git"), "gitdir: /elsewhere\n");
    git(join(root, "w", "inner"));
    git(join(root, "a"));
    git(join(root, "a", "nested"));
    const state = await addRoot(makeService(), 3);
    expect(names(state)).toEqual(["a", "w"]);
    expect(listed).not.toContain(join(root, "w", "inner"));
    expect(listed).not.toContain(join(root, "a", "nested"));
  });

  it("a symlink to a Git folder outside the root is never suggested and its target is never listed", async () => {
    git(join(outside, "repo"));
    symlinkSync(join(outside, "repo"), join(root, "link"));
    git(join(root, "a"));
    const state = await addRoot(makeService(), 3);
    expect(names(state)).toEqual(["a"]);
    expect(listed.some((p) => p.startsWith(outside) || p.includes("link"))).toBe(false);
  });

  it("skips a folder whose name carries a control character", async () => {
    git(join(root, "bad\nname"));
    git(join(root, "a"));
    const state = await addRoot(makeService());
    expect(names(state)).toEqual(["a"]);
  });

  it("never lists a protected location (Library/CloudStorage) the owner did not nominate", async () => {
    root = join(fakeHome, "Library");
    git(join(root, "CloudStorage", "drive"));
    git(join(root, "tools"));
    const state = await addRoot(makeService(), 3);
    expect(names(state)).toEqual(["tools"]);
    expect(listed.some((p) => p.includes("CloudStorage"))).toBe(false);
  });

  it("excludes a folder that is already registered", async () => {
    git(join(root, "a"));
    git(join(root, "b"));
    insertProject(store.db, { path: join(root, "a"), displayName: "a" });
    const state = await addRoot(makeService());
    expect(names(state)).toEqual(["b"]);
  });
});

describe("caps (T-04-13)", () => {
  it("SCAN_ENTRY_CAP and SCAN_TIME_CAP_MS default to 5000 entries and 2000 ms", () => {
    expect(SCAN_ENTRY_CAP).toBe(5000);
    expect(SCAN_TIME_CAP_MS).toBe(2000);
  });

  it("hitting the entry cap returns what was found so far, partial", async () => {
    for (let i = 0; i < 20; i += 1) git(join(root, `r${String(i).padStart(2, "0")}`));
    const state = await addRoot(makeService({ entryCap: 5 }));
    expect(state.partial).toBe(true);
    expect(state.scanRoots[0]?.scanStatus).toBe("partial");
    expect(state.suggestions.length).toBeGreaterThan(0);
    expect(state.suggestions.length).toBeLessThan(20);
  });

  it("running past the wall-clock cap returns what was found so far, partial", async () => {
    for (let i = 0; i < 10; i += 1) git(join(root, `r${i}`));
    let clock = 0;
    const now = () => {
      clock += 600;
      return clock;
    };
    const state = await addRoot(makeService({ now, timeCapMs: 2000 }));
    expect(state.partial).toBe(true);
    expect(state.suggestions.length).toBeLessThan(10);
  });
});

describe("registering a suggestion re-checks containment (PROJ-03)", () => {
  it("refuses a suggestion whose folder was swapped for a symlink out of the root, and inserts nothing", async () => {
    git(join(root, "alpha"));
    git(join(outside, "repo"));
    const service = makeService();
    const state = await addRoot(service);
    const suggestionId = state.suggestions[0]?.suggestionId;
    if (suggestionId === undefined) throw new Error("no suggestion");
    rmSync(join(root, "alpha"), { recursive: true, force: true });
    symlinkSync(join(outside, "repo"), join(root, "alpha"));

    expect(await service.registerSuggestion(suggestionId)).toEqual({ kind: "refused" });
    expect(listProjects(store.db)).toHaveLength(0);
  });

  it("refuses to rescan a root that was replaced by a symlink, and lists nothing behind it", async () => {
    git(join(root, "alpha"));
    git(join(outside, "repo"));
    const service = makeService();
    const state = await addRoot(service);
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    renameSync(root, join(fakeHome, "moved"));
    symlinkSync(outside, root);
    listed = [];
    const after = await service.rescan(id);
    expect(after.kind === "state" && after.state.scanRoots[0]?.scanStatus).toBe("failed");
    expect(after.kind === "state" && after.state.suggestions).toEqual([]);
    expect(listed.some((p) => p.startsWith(outside))).toBe(false);
  });
});

describe("dismiss and stop scanning (D-07, D-08)", () => {
  it("dismiss hides a suggestion until the next rescan", async () => {
    git(join(root, "a"));
    const service = makeService();
    const state = await addRoot(service);
    const suggestionId = state.suggestions[0]?.suggestionId ?? "";
    expect(service.dismiss(suggestionId)).toBe(true);
    expect(service.state().suggestions).toEqual([]);
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    const rescanned = await service.rescan(id);
    expect(rescanned.kind === "state" && names(rescanned.state)).toEqual(["a"]);
  });

  it("remove deletes the row and its suggestions; registered projects and the disk stay", async () => {
    git(join(root, "a"));
    git(join(root, "b"));
    const service = makeService();
    const state = await addRoot(service);
    const a = state.suggestions.find((s) => s.folderName === "a");
    if (a === undefined) throw new Error("no suggestion a");
    expect((await service.registerSuggestion(a.suggestionId)).kind).toBe("response");
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");

    const removed = service.remove(id);
    expect(removed.kind === "state" && removed.state).toEqual({
      scanRoots: [],
      suggestions: [],
      partial: false,
    });
    expect(listScanRoots(store.db)).toHaveLength(0);
    expect(listProjects(store.db).map((p) => p.path)).toEqual([join(root, "a")]);
    expect(fs.existsSync(join(root, "a", ".git"))).toBe(true);
    expect(fs.existsSync(join(root, "b", ".git"))).toBe(true);
  });
});

describe("no background scanning (D-07, T-04-35)", () => {
  it("creates no watcher, no interval, and no timer that outlives a request across add, rescan and register", async () => {
    git(join(root, "a"));
    const watch = vi.spyOn(fs, "watch");
    const watchFile = vi.spyOn(fs, "watchFile");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const service = makeService();
    const state = await addRoot(service);
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    await service.rescan(id);
    const suggestionId = service.state().suggestions[0]?.suggestionId ?? "";
    await service.registerSuggestion(suggestionId);
    expect(watch).not.toHaveBeenCalled();
    expect(watchFile).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    // The per-operation deadline (wave-6 review) is the only timer, and every
    // one is cleared before its request answers: nothing fires later.
    const created = setTimeoutSpy.mock.results.map((r) => r.value);
    const cleared = new Set(clearTimeoutSpy.mock.calls.map((c) => c[0]));
    expect(created.every((handle) => cleared.has(handle))).toBe(true);
  });
});

describe("rescan re-validates the root and the walk skips the vault (wave-6 review)", () => {
  function policyWithVault(vault: { current: string | null }) {
    return () => ({ homeDir: fakeHome, runtimeDir, vaultRoot: vault.current });
  }

  it("a vault set up inside a scan folder later makes its rescan refused, clears its suggestions and lists nothing", async () => {
    git(join(root, "a"));
    const vault = { current: null as string | null };
    const service = makeService({ readPolicy: policyWithVault(vault) });
    const state = await addRoot(service);
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    mkdirSync(join(root, "notes"));
    vault.current = join(root, "notes");
    listed = [];

    expect(await service.rescan(id)).toEqual({ kind: "refused" });
    expect(listed).toEqual([]);
    expect(service.state().suggestions).toEqual([]);
    expect(service.state().scanRoots[0]?.scanStatus).toBe("refused");
    // Constant: asking again answers the same refusal, still without a listing.
    expect(await service.rescan(id)).toEqual({ kind: "refused" });
    expect(listed).toEqual([]);
  });

  it("a scan folder that is now inside the vault is refused on rescan", async () => {
    git(join(root, "a"));
    const vault = { current: null as string | null };
    const service = makeService({ readPolicy: policyWithVault(vault) });
    const state = await addRoot(service);
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    vault.current = join(fakeHome, "code");
    expect(await service.rescan(id)).toEqual({ kind: "refused" });
    expect(service.state().suggestions).toEqual([]);
  });

  it("a vault set up while a walk runs is never listed or suggested", async () => {
    git(join(root, "a"));
    git(join(root, "notes"));
    mkdirSync(join(root, "notes", "inner"), { recursive: true });
    const vault = { current: null as string | null };
    const service = makeService({
      readPolicy: policyWithVault(vault),
      fs: recordingFs((path) => {
        // Vault setup lands between the add's validation and the walk.
        if (path === root) vault.current = join(root, "notes");
        return null;
      }),
    });
    const state = await addRoot(service, 2);
    expect(names(state)).toEqual(["a"]);
    expect(
      listed.some((p) => p === join(root, "notes") || p.startsWith(`${join(root, "notes")}/`)),
    ).toBe(false);
  });

  it("a suggestion found before the vault was set up inside it is no longer listed", async () => {
    git(join(root, "a"));
    git(join(root, "notes"));
    const vault = { current: null as string | null };
    const service = makeService({ readPolicy: policyWithVault(vault) });
    const state = await addRoot(service);
    expect(names(state)).toEqual(["a", "notes"]);
    vault.current = join(root, "notes");
    expect(names(service.state())).toEqual(["a"]);
  });
});

describe("the time cap bounds a hung filesystem call (wave-6 review)", () => {
  function hanging(): Promise<never> {
    return new Promise<never>(() => {});
  }

  it("a listing that never answers stops the walk at the cap, partial, and the next rescan is not stuck behind it", async () => {
    git(join(root, "a"));
    mkdirSync(join(root, "stuck"));
    const service = makeService({
      timeCapMs: 100,
      fs: recordingFs((path) => (path === join(root, "stuck") ? hanging() : null)),
    });
    const started = Date.now();
    const state = await addRoot(service);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(state.partial).toBe(true);
    expect(state.scanRoots[0]?.scanStatus).toBe("partial");
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    const again = await service.rescan(id);
    expect(again.kind === "state" && again.state.scanRoots[0]?.scanStatus).toBe("partial");
  });

  it("a root realpath that never answers marks the root failed within the cap", async () => {
    git(join(root, "a"));
    const service = makeService({
      timeCapMs: 100,
      fs: {
        readdir: (path) => fsPromises.readdir(path, { withFileTypes: true }),
        realpath: (path) => (path === root ? hanging() : fsPromises.realpath(path)),
      },
    });
    const started = Date.now();
    const state = await addRoot(service);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(state.scanRoots[0]?.scanStatus).toBe("failed");
    expect(state.suggestions).toEqual([]);
  });
});

describe("failures and the log (PR-10, D-46)", () => {
  it("an EPERM on the root's listing reads folder-access-denied for that root, without a crash", async () => {
    const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const service = makeService({
      fs: recordingFs((path) => (path === root ? Promise.reject(eperm) : null)),
    });
    const state = await addRoot(service);
    expect(state.scanRoots[0]?.scanStatus).toBe("access-denied");
    expect(state.suggestions).toEqual([]);
    expect(state.scanRoots[0]?.lastScannedAt).toBeNull();
  });

  it("a root that disappeared reads failed", async () => {
    const service = makeService();
    const state = await addRoot(service);
    const id = state.scanRoots[0]?.scanRootId;
    if (id === undefined) throw new Error("no scan root");
    rmSync(root, { recursive: true, force: true });
    const after = await service.rescan(id);
    expect(after.kind === "state" && after.state.scanRoots[0]?.scanStatus).toBe("failed");
  });

  it("logs a scan as { scanRootId, found, partial } only, with no path anywhere", async () => {
    git(join(root, "a"));
    await addRoot(makeService());
    const finished = logLines.filter((l) => l.message === "scan finished");
    expect(finished).toHaveLength(1);
    expect(Object.keys(finished[0]?.fields ?? {}).sort()).toEqual([
      "found",
      "partial",
      "scanRootId",
    ]);
    expect(JSON.stringify(logLines)).not.toContain(base);
  });
});
