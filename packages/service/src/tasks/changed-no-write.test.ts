import { readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_CHANGED_MAX_PATHS, type TaskCreateRequest } from "@ccc/domain";
import { getTask } from "@ccc/operational-store";
import * as vaultRepo from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeTimers,
  makeFakeTimers,
  makeServiceFixture,
  publishedGenerations,
  type ServiceFixture,
  snapshotVault,
  withoutIndexFiles,
} from "../test-support/task-fixtures.js";
import { createTaskServices } from "./task-service.js";
import type { TaskServiceHost } from "./types.js";

/**
 * The enforcement point for the no-write rule (plan 06-20, prohibition
 * TASK-02, T-06-22): the changed route and the rescan never write, rename,
 * mint an id into or delete a task note, in every branch. Three independent
 * instruments watch for it: a before/after snapshot of every file in the vault,
 * spies on the vault writer functions, and counters on the file system write
 * functions.
 */

const probes = vi.hoisted(() => ({
  fsWrites: [] as string[],
  fsReads: [] as string[],
  scans: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const tracked = (bucket: "fsWrites" | "fsReads", name: string, fn: (...a: never[]) => unknown) =>
    ((...args: never[]) => {
      probes[bucket].push(name);
      return fn(...args);
    }) as never;
  const wrapped = {
    ...actual,
    writeFileSync: tracked("fsWrites", "writeFileSync", actual.writeFileSync as never),
    appendFileSync: tracked("fsWrites", "appendFileSync", actual.appendFileSync as never),
    renameSync: tracked("fsWrites", "renameSync", actual.renameSync as never),
    unlinkSync: tracked("fsWrites", "unlinkSync", actual.unlinkSync as never),
    rmSync: tracked("fsWrites", "rmSync", actual.rmSync as never),
    rmdirSync: tracked("fsWrites", "rmdirSync", actual.rmdirSync as never),
    mkdirSync: tracked("fsWrites", "mkdirSync", actual.mkdirSync as never),
    copyFileSync: tracked("fsWrites", "copyFileSync", actual.copyFileSync as never),
    truncateSync: tracked("fsWrites", "truncateSync", actual.truncateSync as never),
    writeSync: tracked("fsWrites", "writeSync", actual.writeSync as never),
    readFileSync: tracked("fsReads", "readFileSync", actual.readFileSync as never),
    statSync: tracked("fsReads", "statSync", actual.statSync as never),
    existsSync: tracked("fsReads", "existsSync", actual.existsSync as never),
    realpathSync: Object.assign(tracked("fsReads", "realpathSync", actual.realpathSync as never), {
      native: tracked("fsReads", "realpathSync.native", actual.realpathSync.native as never),
    }),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("@ccc/vault-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ccc/vault-repo")>();
  return {
    ...actual,
    writeTaskNote: vi.fn(actual.writeTaskNote),
    writeNote: vi.fn(actual.writeNote),
    atomicWriteFileSync: vi.fn(actual.atomicWriteFileSync),
    ensureTasksFolder: vi.fn(actual.ensureTasksFolder),
    repairVault: vi.fn(actual.repairVault),
    regenerateIndex: vi.fn(actual.regenerateIndex),
    scanTaskNotes: vi.fn((root: string) => {
      probes.scans += 1;
      return actual.scanTaskNotes(root);
    }),
  };
});

const NOTE_WRITERS = [
  "writeTaskNote",
  "writeNote",
  "atomicWriteFileSync",
  "ensureTasksFolder",
  "repairVault",
] as const;

let fx: ServiceFixture;
let timers: FakeTimers;
let services: TaskServiceHost;

beforeEach(() => {
  fx = makeServiceFixture();
  timers = makeFakeTimers();
  services = createTaskServices({ ...fx.deps, timers, minWalkIntervalMs: 5_000 });
});

afterEach(() => {
  services.dispose();
  vi.clearAllMocks();
  fx.cleanup();
});

const ZONE = "America/New_York";

function create(overrides: Partial<TaskCreateRequest> = {}) {
  const result = services.create({ title: "A task", intent: "inbox", zone: ZONE, ...overrides });
  if (!result.ok) throw new Error(`create refused: ${result.code}`);
  const path = getTask(fx.store.db, result.value.task.id)?.path as string;
  return { id: result.value.task.id, path, abs: join(fx.vault.root, ...path.split("/")) };
}

/** Clears every instrument after seeding, so only the branch under test is measured. */
function arm(): Record<string, string> {
  const snapshot = snapshotVault(fx.vault.root);
  vi.clearAllMocks();
  probes.fsWrites.length = 0;
  probes.fsReads.length = 0;
  probes.scans = 0;
  return snapshot;
}

function expectNothingWritten(
  before: Record<string, string>,
  opts: { allowIndexFiles?: boolean } = {},
) {
  const after = snapshotVault(fx.vault.root);
  if (opts.allowIndexFiles === true) {
    expect(withoutIndexFiles(after)).toEqual(withoutIndexFiles(before));
  } else {
    expect(after).toEqual(before);
    expect(probes.fsWrites).toEqual([]);
  }
  const spied = vaultRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
  for (const name of NOTE_WRITERS) expect(spied[name]).not.toHaveBeenCalled();
}

function edit(abs: string, from: string, to: string): void {
  const text = readFileSync(abs, "utf8");
  expect(text).toContain(from);
  writeFileSync(abs, text.replace(from, to));
}

function changes(): number {
  return (fx.store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

describe("Test 0 (hash agreement)", () => {
  it("computes the same whole-file hash in the scan, the writer and the changed route, so naming an unchanged note writes nothing", () => {
    const { id, path } = create({ description: "body" });
    const scanned = vaultRepo.scanTaskNotes(fx.vault.root).tasks.find((task) => task.path === path);
    expect(scanned?.contentHash).toBe(getTask(fx.store.db, id)?.contentHash);
    const generations = publishedGenerations(fx.bus).length;
    const before = changes();
    const result = services.changed({ paths: [path] });
    expect(result.ok).toBe(true);
    expect(changes()).toBe(before);
    expect(publishedGenerations(fx.bus)).toHaveLength(generations);
  });
});

describe("Test 1 (changed, update)", () => {
  it("updates the row for a status-only edit with the body byte for byte the same, and announces once", () => {
    const { id, path, abs } = create({ description: "Body stays exactly as it is.\n" });
    const bodyBefore = readFileSync(abs, "utf8").split("\n---\n").slice(-1)[0];
    const generations = publishedGenerations(fx.bus).length;
    const before = snapshotVault(fx.vault.root);
    edit(abs, "status: inbox", "status: done");
    arm();
    const result = services.changed({ paths: [path] });
    expect(result).toMatchObject({ ok: true, value: { accepted: 1 } });
    expect(getTask(fx.store.db, id)?.status).toBe("done");
    expect(readFileSync(abs, "utf8").split("\n---\n").slice(-1)[0]).toBe(bodyBefore);
    expect(publishedGenerations(fx.bus)).toHaveLength(generations + 1);
    const counts = services.counts({ context: { scope: "all" }, zone: ZONE });
    if (!counts.ok) throw new Error("counts refused");
    expect(counts.value.counts.completed).toBe(1);
    // The only difference from the snapshot is the edit itself.
    const after = snapshotVault(fx.vault.root);
    const changedPaths = Object.keys(after).filter((key) => after[key] !== before[key]);
    expect(changedPaths).toEqual([path]);
    expect(probes.fsWrites).toEqual([]);
  });

  it("updates the row for a due-date-only edit and for a title-only edit", () => {
    const { id, path, abs } = create({ description: "same body" });
    arm();
    edit(abs, "status: inbox\n", "status: inbox\ndue: 2026-10-09\n");
    services.changed({ paths: [path] });
    expect(getTask(fx.store.db, id)?.dueDate).toBe("2026-10-09");
    edit(abs, "title: A task", "title: A renamed task");
    services.changed({ paths: [path] });
    expect(getTask(fx.store.db, id)?.title).toBe("A renamed task");
    expect(getTask(fx.store.db, id)?.path).toBe(path);
  });

  it("performs no index write and publishes nothing for an unchanged note", () => {
    const { path } = create();
    const before = arm();
    const generations = publishedGenerations(fx.bus).length;
    const writes = changes();
    const result = services.changed({ paths: [path] });
    expect(result).toMatchObject({ ok: true, value: { accepted: 1 } });
    expect(changes()).toBe(writes);
    expect(publishedGenerations(fx.bus)).toHaveLength(generations);
    expectNothingWritten(before);
  });
});

describe("Test 2 (changed, delete and invalid)", () => {
  it("removes the row of a note that no longer exists, writing nothing", () => {
    const { id, path, abs } = create();
    unlinkSync(abs);
    const before = arm();
    const result = services.changed({ paths: [path] });
    expect(result).toMatchObject({ ok: true, value: { accepted: 1 } });
    expect(getTask(fx.store.db, id)).toBeNull();
    expectNothingWritten(before);
  });

  it("removes the row of a note whose frontmatter became unreadable and queues a rescan", () => {
    const { id, path, abs } = create();
    writeFileSync(abs, "---\nid: [unclosed\n---\nbody\n");
    const before = arm();
    services.changed({ paths: [path] });
    expect(getTask(fx.store.db, id)).toBeNull();
    expect(timers.pending()).toBe(1);
    expectNothingWritten(before);
  });

  it("treats a note over the size limit like an unreadable one", () => {
    const { id, path, abs } = create();
    writeFileSync(abs, `${readFileSync(abs, "utf8")}${"x".repeat(300 * 1024)}`);
    const before = arm();
    services.changed({ paths: [path] });
    expect(getTask(fx.store.db, id)).toBeNull();
    expect(timers.pending()).toBe(1);
    expectNothingWritten(before);
  });

  it("indexes neither copy of a duplicated id and queues a rescan", () => {
    const { id, path, abs } = create({ description: "original" });
    const copyPath = path.replace("a-task-", "a-task-copy-");
    writeFileSync(join(fx.vault.root, ...copyPath.split("/")), readFileSync(abs, "utf8"));
    const before = arm();
    services.changed({ paths: [copyPath] });
    expect(getTask(fx.store.db, id)).toBeNull();
    expect(timers.pending()).toBe(1);
    expectNothingWritten(before);
  });

  it("follows a rename: the old path is gone and the new one takes the row", () => {
    const { id, path, abs } = create();
    const newPath = path.replace("a-task-", "moved-");
    const text = readFileSync(abs, "utf8");
    unlinkSync(abs);
    writeFileSync(join(fx.vault.root, ...newPath.split("/")), text);
    arm();
    services.changed({ paths: [newPath, path] });
    expect(getTask(fx.store.db, id)?.path).toBe(newPath);
  });
});

describe("Test 3 (path containment)", () => {
  const REFUSED: readonly string[] = [
    "../outside.md",
    "global/tasks/../../secret.md",
    "/etc/passwd",
    "global\\tasks\\x.md",
    "global/notes/x.md",
    "global/tasks/index.md",
    "global/tasks/sub/x.md",
    "workspaces/short/tasks/x.md",
    "global/tasks/x.txt",
    "global/tasks/.hidden.md",
  ];

  it("refuses a path that fails the task note rule without any file system call, and writes nothing", () => {
    const before = arm();
    for (const bad of REFUSED) {
      const result = services.changed({ paths: [bad as never] });
      expect(result).toEqual({ ok: false, code: "invalid-path" });
    }
    expect(probes.fsReads).toEqual([]);
    expectNothingWritten(before);
  });

  it("refuses a note that resolves through a symlink outside the vault and still applies the other paths", () => {
    const good = create();
    const outside = join(fx.vault.root, "..", "outside-1.md");
    writeFileSync(outside, readFileSync(good.abs, "utf8"));
    const link = join(fx.vault.root, "global", "tasks", "evil.md");
    symlinkSync(outside, link);
    edit(good.abs, "status: inbox", "status: ready");
    const before = arm();
    const result = services.changed({
      paths: ["global/tasks/evil.md" as never, good.path as never],
    });
    expect(result).toMatchObject({ ok: true, value: { accepted: 1 } });
    expect(getTask(fx.store.db, good.id)?.status).toBe("ready");
    expect(
      fx.store.db
        .prepare("SELECT COUNT(*) AS n FROM task_index WHERE path = ?")
        .get("global/tasks/evil.md"),
    ).toEqual({ n: 0 });
    const after = snapshotVault(fx.vault.root);
    expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([]);
  });

  it("ignores a symlink that stays inside the vault, as the scan does, so it never becomes a duplicate", () => {
    const good = create();
    symlinkSync(good.abs, join(fx.vault.root, "global", "tasks", "alias.md"));
    const before = arm();
    const result = services.changed({ paths: ["global/tasks/alias.md" as never] });
    expect(result).toMatchObject({ ok: true, value: { accepted: 1 } });
    expect(getTask(fx.store.db, good.id)?.path).toBe(good.path);
    expect(timers.pending()).toBe(0);
    expectNothingWritten(before);
  });

  it("answers invalid-path when every named path is refused by the symlink check", () => {
    const good = create();
    const outside = join(fx.vault.root, "..", "outside-2.md");
    writeFileSync(outside, readFileSync(good.abs, "utf8"));
    symlinkSync(outside, join(fx.vault.root, "global", "tasks", "evil-2.md"));
    expect(services.changed({ paths: ["global/tasks/evil-2.md" as never] })).toEqual({
      ok: false,
      code: "invalid-path",
    });
  });
});

describe("Test 4 (no write, spies) and Test 5 (limits)", () => {
  it("writes nothing in the rescan branch except the tasks folder summary index", () => {
    const { path } = create();
    const before = arm();
    const queued = services.changed({ rescan: true });
    expect(queued).toMatchObject({ ok: true, value: { accepted: 0 } });
    expect(probes.scans).toBe(0);
    timers.flush();
    expect(probes.scans).toBe(1);
    expectNothingWritten(before, { allowIndexFiles: true });
    expect(
      readdirSync(join(fx.vault.root, "global", "tasks")).filter((n) => n !== "index.md"),
    ).toHaveLength(1);
    expect(path).toMatch(/^global\/tasks\//);
  });

  it("refuses more than 200 paths and accepts a rescan flag alone", () => {
    const many = Array.from(
      { length: TASK_CHANGED_MAX_PATHS + 1 },
      (_, i) => `global/tasks/n-${i}.md`,
    );
    expect(services.changed({ paths: many as never })).toEqual({ ok: false, code: "invalid-body" });
    expect(services.changed({ rescan: true }).ok).toBe(true);
    expect(services.changed({})).toEqual({ ok: false, code: "invalid-body" });
  });

  it("coalesces a storm of rescan requests into one walk", () => {
    create();
    arm();
    for (let i = 0; i < 25; i++) services.changed({ rescan: true });
    expect(timers.pending()).toBe(1);
    timers.flush();
    expect(probes.scans).toBe(1);
    // A request right after the walk is deferred past the minimum interval, not run at once.
    services.changed({ rescan: true });
    expect(timers.pending()).toBe(1);
    expect(Math.max(...timers.delays())).toBeGreaterThan(0);
    expect(probes.scans).toBe(1);
  });

  it("imports no write function from the vault package in changed.ts", () => {
    const source = readFileSync(join(import.meta.dirname, "changed.ts"), "utf8");
    const imports = [
      ...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"@ccc\/vault-repo"/g),
    ]
      .flatMap((m) => (m[1] ?? "").split(","))
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter((name) => name.length > 0);
    expect(imports.sort()).toEqual(["TaskNoteError", "hashTaskNoteBytes", "parseTaskNote"].sort());
  });
});
