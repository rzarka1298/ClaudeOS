import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TasksChangedPayloadSchema } from "@ccc/domain";
import {
  applyMigrations,
  type OperationalStore,
  openStore,
  type TaskIndexRecord,
  upsertTask,
} from "@ccc/operational-store";
import { createWorkspace, initializeVault } from "@ccc/vault-repo";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { TaskLog, TaskServicesDeps } from "../tasks/types.js";

/**
 * Shared fixtures for the task service, route, changed and reindex tests (plan
 * 06-20). Everything is synthetic. Test code only: no production file imports
 * this module.
 */

const TEST_BASE = join(homedir(), ".ccc-test");

/** A throwaway vault with the managed skeleton, removed by `cleanup`. */
export interface TestVault {
  readonly root: string;
  workspace(name?: string): string;
  cleanup(): void;
}

export function makeVault(): TestVault {
  mkdirSync(TEST_BASE, { recursive: true });
  const base = mkdtempSync(join(TEST_BASE, "tasks-vault-"));
  const root = join(base, "vault");
  mkdirSync(root, { recursive: true });
  initializeVault(root);
  return {
    root,
    workspace: (name = "Example") => createWorkspace(root, name).workspaceId,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** A throwaway operational store with every migration applied. */
export interface TestStore {
  readonly store: OperationalStore;
  cleanup(): void;
}

export function makeStore(): TestStore {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEST_BASE, "tasks-store-"));
  const store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One recorded log line. */
export interface LogLine {
  readonly level: "warn" | "error";
  readonly fields: Readonly<Record<string, unknown>>;
}

export function recordingLog(): { readonly log: TaskLog; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    log: {
      warn: (fields) => lines.push({ level: "warn", fields }),
      error: (fields) => lines.push({ level: "error", fields }),
    },
  };
}

/** A movable clock. */
export function makeClock(startIso = "2026-10-07T12:00:00.000Z") {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    set(iso: string) {
      current = new Date(iso).getTime();
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

/** Every `tasks.changed` generation the bus carried, in order. */
export function publishedGenerations(bus: EventBus): number[] {
  const replay = bus.buffer.since(0);
  if (replay.mode !== "replay") throw new Error("expected a replay");
  return replay.events
    .filter((event) => event.type === "tasks.changed")
    .map((event) => TasksChangedPayloadSchema.parse(event.payload).generation);
}

export interface ServiceFixture {
  readonly deps: TaskServicesDeps;
  readonly bus: EventBus;
  readonly lines: LogLine[];
  readonly clock: ReturnType<typeof makeClock>;
  readonly vault: TestVault;
  readonly store: OperationalStore;
  /** Clears the vault root the services see (for the not-set-up case). */
  setVaultRoot(root: string | null): void;
  cleanup(): void;
}

/** A complete dependency set over a fresh vault, store, bus, clock and log. */
export function makeServiceFixture(): ServiceFixture {
  const vault = makeVault();
  const testStore = makeStore();
  const bus = createEventBus();
  const clock = makeClock();
  const { log, lines } = recordingLog();
  let root: string | null = vault.root;
  return {
    deps: {
      db: testStore.store.db,
      getVaultRoot: () => root,
      eventBus: bus,
      now: clock.now,
      log,
    },
    bus,
    lines,
    clock,
    vault,
    store: testStore.store,
    setVaultRoot: (next) => {
      root = next;
    },
    cleanup: () => {
      testStore.cleanup();
      vault.cleanup();
    },
  };
}

/** A valid note id, varied by `n`. */
export function noteId(n: number): string {
  return `0mfk1a2b3c4d5e6f7a8b9c${String(n).padStart(3, "0")}`;
}

/** A valid project id, varied by `n`. */
export function projectIdOf(n: number): string {
  return `abcdefghi${String(n).padStart(16, "0")}`;
}

/** A synthetic index record under global/tasks, varied by `n`. */
export function taskRecord(n: number, overrides: Partial<TaskIndexRecord> = {}): TaskIndexRecord {
  return {
    noteId: noteId(n),
    path: `global/tasks/task-${n}.md`,
    scope: "global",
    title: `Task ${n}`,
    status: "ready",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: `2026-10-0${1 + (n % 5)}T09:00:00.000Z`,
    sourceType: "manual",
    contentHash: "ab".repeat(32),
    tags: [],
    dependencies: [],
    aiGenerated: false,
    claimType: null,
    confidence: "unverified",
    ...overrides,
  };
}

/** Inserts synthetic records straight into the index. */
export function seedTasks(store: OperationalStore, records: readonly TaskIndexRecord[]): void {
  for (const record of records) upsertTask(store.db, record);
}
