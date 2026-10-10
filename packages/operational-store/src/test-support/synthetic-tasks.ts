import type { TaskPriority, TaskStatus } from "@ccc/domain";
import { TASK_PRIORITIES, TASK_STATUSES } from "@ccc/domain";
import type { TaskIndexRecord } from "../task-index-store.js";

/**
 * Seeded synthetic tasks for the task-index tests (plan 06-14).
 *
 * Package-local on purpose: `@ccc/test-fixtures` depends on this package, so
 * importing it here would point the dependency the wrong way. The generator
 * follows the synthetic-notes precedent: mulberry32 over a fixed seed, so a
 * failing run reproduces and a timing is comparable across runs.
 */

/** The fixed seed every generator call uses unless a caller supplies one. */
export const DEFAULT_SYNTHETIC_TASK_SEED = 20261006;

/** The instant the synthetic dates are laid out around: 2026-10-05 noon in New York. */
export const SYNTHETIC_TASK_NOW = new Date("2026-10-05T16:00:00.000Z");

/** The zone the synthetic dates and the tests' day bounds are computed in. */
export const SYNTHETIC_TASK_ZONE = "America/New_York";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const HEX = "0123456789abcdef";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Projects the generated tasks are spread across; a task has one in about two cases of three. */
export const SYNTHETIC_PROJECT_IDS: readonly string[] = [
  "k1a2b3c4d0123456789abcdef",
  "k1a2b3c4e0123456789abcdef",
  "k1a2b3c4f0123456789abcdef",
  "k1a2b3c4g0123456789abcdef",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function id25(rand: () => number): string {
  let out = "";
  for (let i = 0; i < 25; i++) out += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length)];
  return out;
}

function hex64(rand: () => number): string {
  let out = "";
  for (let i = 0; i < 64; i++) out += HEX[Math.floor(rand() * 16)];
  return out;
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)] as T;
}

/** The folder a task note of `scope` lives in. */
export function taskFolderForScope(scope: string): string {
  return scope === "global"
    ? "global/tasks"
    : `workspaces/${scope.slice("workspace:".length)}/tasks`;
}

/** A vault-relative task note path for an id in a scope. */
export function taskPathFor(scope: string, noteId: string): string {
  return `${taskFolderForScope(scope)}/synthetic-task-${noteId.slice(-8)}.md`;
}

/**
 * A valid task record with every optional field absent, for tests that set
 * only the fields they care about. The id doubles as the path suffix.
 */
export function makeTaskRecord(
  overrides: Partial<TaskIndexRecord> & { readonly noteId: string },
): TaskIndexRecord {
  const scope = overrides.scope ?? "global";
  return {
    path: taskPathFor(scope, overrides.noteId),
    scope,
    title: `Task ${overrides.noteId.slice(-6)}`,
    status: "ready",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    sourceType: "manual",
    contentHash: "0".repeat(64),
    tags: [],
    dependencies: [],
    aiGenerated: false,
    claimType: null,
    confidence: "unverified",
    ...overrides,
  };
}

/** A deterministic 25-character id for a small integer, for hand-written fixtures. */
export function fixtureId(n: number): string {
  return `t${n.toString(36).padStart(24, "0")}`;
}

/** The scopes the generator spreads tasks over: global and two workspaces. */
export function syntheticScopes(seed = DEFAULT_SYNTHETIC_TASK_SEED): readonly string[] {
  const rand = mulberry32(seed ^ 0x5bd1e995);
  return ["global", `workspace:${id25(rand)}`, `workspace:${id25(rand)}`];
}

const STATUS_WEIGHTS: readonly TaskStatus[] = [
  "inbox",
  "ready",
  "ready",
  "in-progress",
  "in-progress",
  "blocked",
  "proposed",
  "proposed",
  "done",
  "done",
  "done",
  "cancelled",
];

/**
 * `count` varied tasks: every status and priority (and none), date-only and
 * instant due and scheduled values around {@link SYNTHETIC_TASK_NOW}, tags,
 * dependencies (some dangling) and many ties on the sort keys (updated time is
 * quantised to the hour in 40 steps, due dates to 30 days) so keyset paging is
 * exercised against ties.
 */
export function generateSyntheticTasks(
  count: number,
  seed = DEFAULT_SYNTHETIC_TASK_SEED,
): TaskIndexRecord[] {
  const rand = mulberry32(seed);
  const scopes = syntheticScopes(seed);
  const tasks: TaskIndexRecord[] = [];
  const seenIds: string[] = [];
  const nowMs = SYNTHETIC_TASK_NOW.getTime();

  for (let index = 0; index < count; index++) {
    const noteId = id25(rand);
    const scope = pick(rand, scopes);
    const status = pick(rand, STATUS_WEIGHTS);
    const priority: TaskPriority | undefined =
      rand() < 0.2 ? undefined : (pick(rand, TASK_PRIORITIES) as TaskPriority);
    const hasProject = rand() < 0.66;

    const dayOffset = Math.floor(rand() * 60) - 30;
    const dueShape = rand();
    let due: string | undefined;
    if (dueShape < 0.35) due = new Date(nowMs + dayOffset * DAY_MS).toISOString().slice(0, 10);
    else if (dueShape < 0.7) {
      due = new Date(nowMs + dayOffset * DAY_MS + Math.floor(rand() * 12) * HOUR_MS).toISOString();
    }
    const schedShape = rand();
    let scheduled: string | undefined;
    if (schedShape < 0.12) {
      scheduled = new Date(nowMs + (Math.floor(rand() * 20) - 5) * DAY_MS)
        .toISOString()
        .slice(0, 10);
    } else if (schedShape < 0.2) {
      scheduled = new Date(
        nowMs + (Math.floor(rand() * 20) - 5) * DAY_MS + Math.floor(rand() * 10) * HOUR_MS,
      ).toISOString();
    }

    const updatedAt = new Date(nowMs - Math.floor(rand() * 40) * HOUR_MS).toISOString();
    const createdAt = new Date(nowMs - (40 + Math.floor(rand() * 400)) * HOUR_MS).toISOString();
    const completed =
      status === "done"
        ? new Date(nowMs - Math.floor(rand() * 90) * HOUR_MS).toISOString()
        : undefined;

    const tagCount = Math.floor(rand() * 5);
    const tags = Array.from({ length: tagCount }, () => `tag${Math.floor(rand() * 12)}`);
    const dependencyCount = rand() < 0.7 ? 0 : 1 + Math.floor(rand() * 3);
    const dependencies: string[] = [];
    for (let d = 0; d < dependencyCount; d++) {
      // Mostly real earlier tasks, occasionally a dangling id that names no task.
      const dep = rand() < 0.15 || seenIds.length === 0 ? id25(rand) : pick(rand, seenIds);
      if (dep !== noteId && !dependencies.includes(dep)) dependencies.push(dep);
    }

    tasks.push({
      noteId,
      path: taskPathFor(scope, noteId),
      scope,
      ...(hasProject ? { projectId: pick(rand, SYNTHETIC_PROJECT_IDS) } : {}),
      title: `Synthetic task ${index}`,
      status,
      ...(priority === undefined ? {} : { priority }),
      ...(due === undefined ? {} : { due }),
      ...(scheduled === undefined ? {} : { scheduled }),
      ...(completed === undefined ? {} : { completed }),
      createdAt,
      updatedAt,
      sourceType: "manual",
      contentHash: hex64(rand),
      tags: [...new Set(tags)],
      dependencies,
      aiGenerated: status === "proposed",
      claimType: null,
      confidence: "unverified",
    });
    seenIds.push(noteId);
  }
  return tasks;
}

/** Re-exported so a test that wants "every status" does not import the domain list twice. */
export const ALL_TASK_STATUSES = TASK_STATUSES;
