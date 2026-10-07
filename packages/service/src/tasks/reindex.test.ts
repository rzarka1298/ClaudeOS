import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskFrontmatterSchema } from "@ccc/domain";
import { getTask } from "@ccc/operational-store";
import { stringifyTaskNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FakeTimers,
  makeFakeTimers,
  makeServiceFixture,
  noteId,
  publishedGenerations,
  type ServiceFixture,
  seedTasks,
  snapshotVault,
  taskRecord,
  withoutIndexFiles,
} from "../test-support/task-fixtures.js";
import { createTaskServices } from "./task-service.js";
import type { TaskServiceHost } from "./types.js";

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
  fx.cleanup();
});

const ZONE = "America/New_York";

/** A note file written straight to disk, the way a person or another tool would. */
function writeNoteFile(
  name: string,
  overrides: Record<string, unknown> = {},
  folder = join(fx.vault.root, "global", "tasks"),
): string {
  const id = (overrides.id as string | undefined) ?? noteId(Math.floor(Math.random() * 900) + 100);
  const frontmatter = TaskFrontmatterSchema.parse({
    id,
    scope: "global",
    stage: "capture",
    created: "2026-10-01T09:00:00.000Z",
    updated: "2026-10-01T09:00:00.000Z",
    generatedBy: {},
    aiGenerated: false,
    sources: [],
    confidence: "unverified",
    lastReviewed: null,
    type: "task",
    title: `Task ${name}`,
    status: "ready",
    sourceType: "manual",
    dependencies: [],
    tags: [],
    ...overrides,
  });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${name}.md`), stringifyTaskNote(frontmatter, "body\n"));
  return frontmatter.id;
}

function indexedIds(): string[] {
  return (
    fx.store.db.prepare("SELECT note_id AS id FROM task_index ORDER BY note_id").all() as {
      id: string;
    }[]
  ).map((row) => row.id);
}

describe("Test 6 (rebuild)", () => {
  function seedVault() {
    for (let i = 0; i < 3; i++) {
      const created = services.create({ title: `Real ${i}`, intent: "inbox", zone: ZONE });
      if (!created.ok) throw new Error("create refused");
    }
    writeNoteFile("copy-a", { id: noteId(500) });
    writeNoteFile("copy-b", { id: noteId(500) });
    writeFileSync(
      join(fx.vault.root, "global", "tasks", "no-id.md"),
      "---\ntype: task\ntitle: No id here\n---\nbody\n",
    );
    writeFileSync(
      join(fx.vault.root, "global", "tasks", "broken.md"),
      "---\nid: [oops\n---\nbody\n",
    );
  }

  it("indexes the valid tasks, lists duplicate, id-less and unreadable notes, and refreshes the summary counts", () => {
    seedVault();
    seedTasks(fx.store, [taskRecord(900, { path: "global/tasks/ghost.md" })]);
    const generations = publishedGenerations(fx.bus).length;
    const result = services.rebuild();
    expect(result).toEqual({ ok: true, value: { tasks: 3, attention: 4 } });
    expect(indexedIds()).toHaveLength(3);
    expect(getTask(fx.store.db, noteId(900))).toBeNull();
    expect(getTask(fx.store.db, noteId(500))).toBeNull();
    expect(publishedGenerations(fx.bus)).toHaveLength(generations + 1);
    const summary = readFileSync(join(fx.vault.root, "global", "tasks", "index.md"), "utf8");
    expect(summary).toContain("- inbox: 3");

    const attention = services.attention({});
    if (!attention.ok) throw new Error("attention refused");
    expect(attention.value.total).toBe(4);
    const reasons = attention.value.items.map((item) => [item.reason, item.path]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ["duplicate-id", "global/tasks/copy-a.md"],
        ["duplicate-id", "global/tasks/copy-b.md"],
        ["missing-id", "global/tasks/no-id.md"],
        ["unreadable", "global/tasks/broken.md"],
      ]),
    );
    const copyA = attention.value.items.find((item) => item.path === "global/tasks/copy-a.md");
    expect(copyA?.otherPaths).toEqual(["global/tasks/copy-b.md"]);
  });

  it("renames, mints, rewrites and deletes nothing", () => {
    seedVault();
    const before = snapshotVault(fx.vault.root);
    services.rebuild();
    expect(withoutIndexFiles(snapshotVault(fx.vault.root))).toEqual(withoutIndexFiles(before));
    expect(readFileSync(join(fx.vault.root, "global", "tasks", "no-id.md"), "utf8")).not.toMatch(
      /^id:/m,
    );
  });

  it("answers a second rebuild inside the minimum interval with the last result and no new walk", () => {
    seedVault();
    const first = services.rebuild();
    writeNoteFile("late", { id: noteId(600) });
    const second = services.rebuild();
    expect(second).toEqual(first);
    expect(getTask(fx.store.db, noteId(600))).toBeNull();
    fx.clock.advance(5_001);
    const third = services.rebuild();
    expect(third).toEqual({ ok: true, value: { tasks: 4, attention: 4 } });
    expect(getTask(fx.store.db, noteId(600))).not.toBeNull();
  });

  it("a pending deferred rescan is satisfied by a rebuild", () => {
    seedVault();
    services.changed({ rescan: true });
    expect(timers.pending()).toBe(1);
    services.rebuild();
    expect(timers.pending()).toBe(0);
  });

  it("ignores rescan requests once disposed", () => {
    seedVault();
    services.dispose();
    services.changed({ rescan: true });
    expect(timers.pending()).toBe(0);
  });

  it("shares one walk between a rescan request and its flush, and never starves later work", () => {
    seedVault();
    services.changed({ rescan: true });
    timers.flush();
    expect(indexedIds()).toHaveLength(3);
    expect(publishedGenerations(fx.bus)).toHaveLength(4);
  });

  it("answers vault-not-set-up for no vault or a root that is not there, leaving the index alone", () => {
    seedTasks(fx.store, [taskRecord(1)]);
    fx.setVaultRoot(null);
    expect(services.rebuild()).toEqual({ ok: false, code: "vault-not-set-up" });
    fx.setVaultRoot(join(fx.vault.root, "does-not-exist"));
    expect(services.startupWalk()).toEqual({ ok: false, code: "vault-not-set-up" });
    expect(getTask(fx.store.db, noteId(1))).not.toBeNull();
  });

  it("lists a note whose scope is not its folder's instead of indexing it", () => {
    writeNoteFile("fine", { id: noteId(700) });
    // A note whose scope names a workspace folder it does not sit in is unreadable to the scan.
    writeNoteFile("wrong-scope", { id: noteId(701), scope: "workspace:0abcdefghijklmnopqrstuvwx" });
    const result = services.rebuild();
    expect(result).toEqual({ ok: true, value: { tasks: 1, attention: 1 } });
  });
});

describe("Test 7 (startup walk)", () => {
  it("does the same work without a request and is safe to call repeatedly, with no rate limit", () => {
    writeNoteFile("one", { id: noteId(1) });
    expect(services.startupWalk()).toEqual({ ok: true, value: { tasks: 1, attention: 0 } });
    writeNoteFile("two", { id: noteId(2) });
    expect(services.startupWalk()).toEqual({ ok: true, value: { tasks: 2, attention: 0 } });
    expect(services.startupWalk()).toEqual({ ok: true, value: { tasks: 2, attention: 0 } });
    expect(indexedIds()).toEqual([noteId(1), noteId(2)]);
  });

  it("walks 10,000 generated notes in under 3 seconds", () => {
    const folder = join(fx.vault.root, "global", "tasks");
    for (let i = 0; i < 10_000; i++) {
      const id = i.toString(36).padStart(25, "0");
      writeNoteFile(
        `gen-${i}`,
        { id, title: `Generated ${i}`, status: i % 3 === 0 ? "done" : "ready" },
        folder,
      );
    }
    const started = performance.now();
    const result = services.startupWalk();
    const elapsed = performance.now() - started;
    expect(result).toEqual({ ok: true, value: { tasks: 10_000, attention: 0 } });
    expect(elapsed, `walk took ${Math.round(elapsed)} ms`).toBeLessThan(3_000);
    expect(indexedIds()).toHaveLength(10_000);
  }, 60_000);
});
