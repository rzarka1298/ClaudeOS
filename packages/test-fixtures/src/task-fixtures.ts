import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  localDayBounds,
  type TaskCountsResponse,
  type TaskFilter,
  TaskFrontmatterSchema,
  type TaskPriority,
  type TaskStatus,
  taskFileName,
  VALID_HOSTILE_TASK_TITLES,
  type WorkspaceId,
  workspaceScope,
} from "@ccc/domain";
import {
  createWorkspace,
  ensureTasksFolder,
  initializeVault,
  stringifyTaskNote,
} from "@ccc/vault-repo";

/**
 * Seeded task vaults for the plan 06-25 suites (TASK-02, TASK-06, TASK-09).
 * Test data only: it lives in this package and nothing in production imports it.
 *
 * Notes are written directly with the vault-repo serializer rather than through
 * the per-note writer, so ten thousand of them take about a second. Every date
 * is relative to one instant and one zone (UTC), and every task has a `kind`
 * that says where it belongs, so an independent oracle can say what each view
 * must hold without consulting the index under test.
 */

/** The shapes a generated task can take; each maps to exactly one place in the task views. */
export type TaskKind =
  | "today-date"
  | "today-instant"
  | "overdue-date"
  | "overdue-instant"
  | "upcoming-date"
  | "upcoming-instant"
  | "undated"
  | "in-progress"
  | "blocked-status"
  | "blocked-unmet"
  | "blocked-dangling"
  | "completed"
  | "cancelled"
  | "proposed";

/** One generated task as the generator wrote it. */
export interface GeneratedTask {
  readonly id: string;
  /** Vault-relative, POSIX-separated. */
  readonly path: string;
  readonly scope: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly title: string;
  readonly due?: string;
  readonly scheduled?: string;
  readonly projectId?: string;
  readonly dependencies: readonly string[];
}

export interface GenerateTaskVaultOptions {
  readonly count: number;
  readonly seed?: number;
  /** Dates are relative to this instant. Defaults to the real clock, which is what a running service uses. */
  readonly now?: Date;
  /** Number of workspaces besides global. Default 2. */
  readonly workspaces?: number;
  /** Exactly this many tasks depend on an open task. Default: the shape's own share. */
  readonly unmetDependencies?: number;
  /** Exactly this many tasks depend on an id that names no task. Default: the shape's own share. */
  readonly danglingDependencies?: number;
  /** Whether proposed tasks are included. Default true. */
  readonly proposed?: boolean;
  /** How many of the notes are boundary-sized (a body near the file limit; one also has the longest title and most tags). Default 0. */
  readonly boundarySize?: number;
  /** IANA zone the dates are relative to. Default UTC (the zone the suites query in). */
  readonly zone?: string;
}

export interface GeneratedTaskVault {
  readonly vaultRoot: string;
  readonly workspaceIds: readonly string[];
  /** `global`, then one `workspace:<id>` per workspace. */
  readonly scopes: readonly string[];
  readonly tasks: readonly GeneratedTask[];
  readonly now: Date;
  readonly seed: number;
}

export interface DayBounds {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export const DEFAULT_TASK_SEED = 20261007;

const TEST_BASE = join(homedir(), ".ccc-test");
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const HEX = "0123456789abcdef";
const HOUR_MS = 3_600_000;

/** The shape cycle: twenty slots, so ten thousand tasks hold every shape in fixed proportion. */
const KIND_CYCLE: readonly TaskKind[] = [
  "undated",
  "today-date",
  "overdue-date",
  "upcoming-date",
  "completed",
  "blocked-unmet",
  "today-instant",
  "undated",
  "overdue-instant",
  "upcoming-instant",
  "cancelled",
  "blocked-status",
  "proposed",
  "completed",
  "blocked-dangling",
  "undated",
  "today-date",
  "in-progress",
  "upcoming-date",
  "completed",
];

const STATUS_OF: Readonly<Record<TaskKind, TaskStatus>> = {
  "today-date": "ready",
  "today-instant": "ready",
  "overdue-date": "ready",
  "overdue-instant": "ready",
  "upcoming-date": "ready",
  "upcoming-instant": "ready",
  undated: "inbox",
  "in-progress": "in-progress",
  "blocked-status": "blocked",
  "blocked-unmet": "ready",
  "blocked-dangling": "ready",
  completed: "done",
  cancelled: "cancelled",
  proposed: "proposed",
};

const PRIORITIES: readonly TaskPriority[] = ["urgent", "high", "medium", "low"];
const TAG_POOL = ["work", "home", "q4/plan", "review", "waiting", "errand", "reading", "ops"];
const VERBS = ["Draft", "Review", "Call", "Plan", "Send", "Fix", "Write", "Check"];
const NOUNS = ["weekly report", "budget", "roadmap", "invoice", "handoff", "backlog", "notes"];

/** mulberry32, the same small seeded generator the synthetic notes use. */
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

function randomString(rand: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

const noteId = (rand: () => number): string => randomString(rand, ID_ALPHABET, 25);
const projectId = (rand: () => number): string =>
  randomString(rand, ID_ALPHABET, 9) + randomString(rand, HEX, 16);

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)] as T;
}

/** The UTC day containing `now` (the zone every generated date is relative to). */
export function utcDay(now: Date): DayBounds {
  return localDayBounds(now, "UTC");
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Assigns a shape to every position, honouring exact dependency counts when given. */
function assignKinds(options: GenerateTaskVaultOptions): TaskKind[] {
  const exactUnmet = options.unmetDependencies !== undefined;
  const exactDangling = options.danglingDependencies !== undefined;
  const kinds = Array.from({ length: options.count }, (_, index): TaskKind => {
    let kind = KIND_CYCLE[index % KIND_CYCLE.length] as TaskKind;
    if (kind === "proposed" && options.proposed === false) kind = "undated";
    if (kind === "blocked-unmet" && exactUnmet) kind = "undated";
    if (kind === "blocked-dangling" && exactDangling) kind = "undated";
    return kind;
  });
  const retag = (wanted: number | undefined, kind: TaskKind): void => {
    if (wanted === undefined) return;
    let left = wanted;
    // Position 0 stays the open anchor the unmet dependencies point at.
    for (let index = 1; index < kinds.length && left > 0; index += 1) {
      if (kinds[index] === "undated") {
        kinds[index] = kind;
        left -= 1;
      }
    }
  };
  retag(options.unmetDependencies, "blocked-unmet");
  retag(options.danglingDependencies, "blocked-dangling");
  return kinds;
}

/** Creates and initialises the managed vault at an existing empty `vaultRoot`, then fills it with task notes. */
export function generateTaskVault(
  vaultRoot: string,
  options: GenerateTaskVaultOptions,
): GeneratedTaskVault {
  const seed = options.seed ?? DEFAULT_TASK_SEED;
  const now = options.now ?? new Date();
  const rand = mulberry32(seed);
  const day = localDayBounds(now, options.zone ?? "UTC");
  const dayStartMs = Date.parse(day.startsAt);
  const dayEndMs = Date.parse(day.endsAt);

  // The setup route refuses a directory that is not an Obsidian vault.
  mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });
  initializeVault(vaultRoot);
  const workspaceIds: WorkspaceId[] = [];
  for (let index = 0; index < (options.workspaces ?? 2); index += 1) {
    workspaceIds.push(createWorkspace(vaultRoot, `Workspace ${index + 1}`).workspaceId);
  }
  const scopes = ["global", ...workspaceIds.map((id) => workspaceScope(id))];
  const folders = new Map<string, string>();
  for (const scope of scopes) {
    ensureTasksFolder(vaultRoot, scope);
    folders.set(scope, scope === "global" ? "global/tasks" : `workspaces/${scope.slice(10)}/tasks`);
  }

  const projectIds = [projectId(rand), projectId(rand), projectId(rand)];
  const kinds = assignKinds(options);
  const boundaryFrom = options.count - (options.boundarySize ?? 0);
  const tasks: GeneratedTask[] = [];
  let anchorId = "";
  let lastUnmetId = "";

  for (let index = 0; index < options.count; index += 1) {
    const kind = kinds[index] as TaskKind;
    const id = noteId(rand);
    const scope = pick(rand, scopes);
    const boundary = index >= boundaryFrom;
    const hostile = !boundary && index % 97 === 13;
    const maxFrontmatter = index === boundaryFrom;
    const title = maxFrontmatter
      ? "T".repeat(200)
      : hostile
        ? pick(rand, VALID_HOSTILE_TASK_TITLES)
        : `${pick(rand, VERBS)} the ${pick(rand, NOUNS)} ${index}`;
    if (anchorId === "" && kind === "undated") anchorId = id;

    let due: string | undefined;
    let scheduled: string | undefined;
    let completed: string | undefined;
    const dependencies: string[] = [];
    switch (kind) {
      case "today-date":
        due = day.localDate;
        break;
      case "today-instant":
        due = new Date(dayStartMs + 12 * HOUR_MS).toISOString();
        break;
      case "overdue-date":
        due = addDays(day.localDate, -(1 + (index % 5)));
        break;
      case "overdue-instant":
        due = new Date(dayStartMs - 2 * HOUR_MS).toISOString();
        break;
      case "upcoming-date":
        due = addDays(day.localDate, 1 + (index % 10));
        break;
      case "upcoming-instant":
        due = new Date(dayEndMs + 3 * HOUR_MS).toISOString();
        break;
      case "completed":
        completed = new Date(dayStartMs - ((index % 48) + 1) * HOUR_MS).toISOString();
        break;
      case "blocked-unmet":
        dependencies.push(lastUnmetId === "" ? anchorId : lastUnmetId);
        lastUnmetId = id;
        break;
      case "blocked-dangling":
        dependencies.push(noteId(rand));
        break;
      case "proposed":
        due = day.localDate;
        break;
      default:
        break;
    }
    if (kind === "undated" && index % 11 === 0) {
      scheduled = addDays(day.localDate, 3);
    }
    const inProject = index % 3 === 0 && kind !== "completed" && kind !== "cancelled";
    const project = inProject ? pick(rand, projectIds) : undefined;
    const priority = rand() < 0.7 ? pick(rand, PRIORITIES) : undefined;
    const tagCount = maxFrontmatter ? 20 : Math.floor(rand() * 4);
    const tags = maxFrontmatter
      ? Array.from({ length: 20 }, (_, tagIndex) => `tag-${tagIndex}-${"x".repeat(40)}`)
      : Array.from(new Set(Array.from({ length: tagCount }, () => pick(rand, TAG_POOL))));

    const created = new Date(now.getTime() - (options.count - index + 60) * 60_000).toISOString();
    const updated = new Date(Date.parse(created) + 30 * 60_000).toISOString();
    const status = STATUS_OF[kind];

    const frontmatter = TaskFrontmatterSchema.parse({
      id,
      scope,
      stage: "capture",
      created,
      updated,
      generatedBy: kind === "proposed" ? { automation: "daily-brief" } : {},
      aiGenerated: kind === "proposed",
      ...(kind === "proposed" ? { claimType: "recommendation" } : {}),
      sources: [],
      confidence: "unverified",
      lastReviewed: null,
      type: "task",
      title,
      status,
      ...(priority === undefined ? {} : { priority }),
      ...(due === undefined ? {} : { due }),
      ...(scheduled === undefined ? {} : { scheduled }),
      ...(completed === undefined ? {} : { completed }),
      ...(project === undefined ? {} : { projectId: project }),
      ...(kind === "proposed" ? { assignee: "automation", sourceType: "automation" } : {}),
      dependencies,
      tags,
    });
    const body = boundary
      ? `${"A line of body text that is part of a very large task note.\n".repeat(3_900)}`
      : `Synthetic task ${index}.\n`;
    const relativePath = `${folders.get(scope) as string}/${taskFileName(title, id)}`;
    writeFileSync(
      join(vaultRoot, ...relativePath.split("/")),
      stringifyTaskNote(frontmatter, body),
    );

    tasks.push({
      id,
      path: relativePath,
      scope,
      kind,
      status,
      title,
      ...(due === undefined ? {} : { due }),
      ...(scheduled === undefined ? {} : { scheduled }),
      ...(project === undefined ? {} : { projectId: project }),
      dependencies,
    });
  }

  return { vaultRoot, workspaceIds, scopes, tasks, now, seed };
}

/** A throwaway vault under the shared test base, removed afterwards. */
export async function withTaskVault<T>(
  options: GenerateTaskVaultOptions,
  fn: (vault: GeneratedTaskVault) => Promise<T> | T,
): Promise<T> {
  mkdirSync(TEST_BASE, { recursive: true });
  const vaultRoot = mkdtempSync(join(TEST_BASE, "tv-"));
  try {
    return await fn(generateTaskVault(vaultRoot, options));
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
}

const isOpen = (task: GeneratedTask): boolean =>
  task.status !== "done" && task.status !== "cancelled" && task.status !== "proposed";

const isInstant = (value: string): boolean => value.length > 10;

function inDay(value: string | undefined, day: DayBounds): boolean {
  if (value === undefined) return false;
  return isInstant(value) ? value >= day.startsAt && value < day.endsAt : value === day.localDate;
}

function beforeDay(value: string | undefined, day: DayBounds): boolean {
  if (value === undefined) return false;
  return isInstant(value) ? value < day.startsAt : value < day.localDate;
}

function afterDay(value: string | undefined, day: DayBounds): boolean {
  if (value === undefined) return false;
  return isInstant(value) ? value >= day.endsAt : value > day.localDate;
}

/** The ids a filter should return, computed independently of the index from the generator's own record. */
export function expectedIds(
  tasks: readonly GeneratedTask[],
  filter: TaskFilter,
  selector: string,
  day: DayBounds,
  project?: string,
): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const inContext = tasks.filter(
    (task) =>
      (selector === "all" || task.scope === selector) &&
      (project === undefined || task.projectId === project),
  );
  const unfinishedDependency = (task: GeneratedTask): boolean =>
    task.dependencies.some((id) => {
      const dependency = byId.get(id);
      return (
        dependency === undefined ||
        (dependency.status !== "done" && dependency.status !== "cancelled")
      );
    });
  const matches = (task: GeneratedTask): boolean => {
    switch (filter) {
      case "all":
        return true;
      case "today":
        return isOpen(task) && (inDay(task.due, day) || inDay(task.scheduled, day));
      case "overdue":
        return isOpen(task) && beforeDay(task.due, day);
      case "upcoming":
        return isOpen(task) && (afterDay(task.due, day) || afterDay(task.scheduled, day));
      case "project":
        return isOpen(task) && task.projectId !== undefined;
      case "proposed":
        return task.status === "proposed";
      case "blocked":
        return isOpen(task) && (task.status === "blocked" || unfinishedDependency(task));
      case "completed":
        return task.status === "done";
    }
  };
  return inContext.filter(matches).map((task) => task.id);
}

/** The chip counts and open total the counts route should answer. */
export function expectedCounts(
  tasks: readonly GeneratedTask[],
  selector: string,
  day: DayBounds,
  project?: string,
): TaskCountsResponse {
  const count = (filter: TaskFilter): number =>
    expectedIds(tasks, filter, selector, day, project).length;
  const scoped = tasks.filter(
    (task) =>
      (selector === "all" || task.scope === selector) &&
      (project === undefined || task.projectId === project),
  );
  return {
    counts: {
      all: count("all"),
      today: count("today"),
      upcoming: count("upcoming"),
      overdue: count("overdue"),
      project: count("project"),
      proposed: count("proposed"),
      blocked: count("blocked"),
      completed: count("completed"),
    },
    open: scoped.filter(isOpen).length,
  };
}

/** SHA-256 of every regular file under `root`, keyed by POSIX-relative path. */
export function hashVaultFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string): void => {
    const absolute = relative === "" ? root : join(root, ...relative.split("/"));
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        out[child] = createHash("sha256")
          .update(readFileSync(join(root, ...child.split("/"))))
          .digest("hex");
      }
    }
  };
  walk("");
  return out;
}

/** Copies a note to a second file name in the same folder (a duplicated id); returns the new vault-relative path. */
export function duplicateTaskNote(vaultRoot: string, relativePath: string, name: string): string {
  const folder = relativePath.slice(0, relativePath.lastIndexOf("/"));
  const target = `${folder}/${name}`;
  copyFileSync(join(vaultRoot, ...relativePath.split("/")), join(vaultRoot, ...target.split("/")));
  return target;
}

/** The structural vault the plugin's task update path needs: an atomic modify and an uncached read. */
export interface FileSystemTaskVault {
  process(file: { readonly path: string }, fn: (data: string) => string): Promise<string>;
  read(file: { readonly path: string }): Promise<string>;
}

/** A file-system-backed vault for the plugin write path (no Obsidian runtime involved). */
export function fileSystemTaskVault(vaultRoot: string): FileSystemTaskVault {
  const absolute = (file: { readonly path: string }): string =>
    join(vaultRoot, ...file.path.split("/"));
  return {
    async process(file, fn) {
      const current = readFileSync(absolute(file), "utf8");
      const next = fn(current);
      if (next !== current) writeFileSync(absolute(file), next);
      return next;
    },
    async read(file) {
      return readFileSync(absolute(file), "utf8");
    },
  };
}

/** Polls `check` until it answers a value other than `undefined`, or fails after `timeoutMs`. */
export async function eventually<T>(
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** What the live-check helper wrote: the valid tasks (for an oracle) and the notes the index must refuse. */
export interface LiveCheckNotes {
  readonly tasks: readonly GeneratedTask[];
  /** Vault-relative paths of the notes that must appear under Notes need attention. */
  readonly unreadable: readonly string[];
}

/** The oversize note's padding: more than the frontmatter limit, less than the file limit. */
const OVERSIZE_PAD_BYTES = 70 * 1024;

/**
 * Writes the opt-in set of live-check notes into the global tasks folder of an already
 * generated vault (plan 06-28, U-6, U-7, T-06-21, T-06-25, T-06-26): one task written
 * the way Obsidian's Properties editor writes a date, three proposed tasks (one with
 * hostile display text, one with a source link), one note whose frontmatter exceeds
 * the size limit and one whose frontmatter cannot be parsed. Deterministic from the
 * seed, the clock and the zone. Everything is synthetic.
 */
export function writeLiveCheckNotes(
  vaultRoot: string,
  options: { readonly seed?: number; readonly now?: Date; readonly zone?: string } = {},
): LiveCheckNotes {
  const rand = mulberry32((options.seed ?? DEFAULT_TASK_SEED) ^ 0x5a5a5a5a);
  const now = options.now ?? new Date();
  const day = localDayBounds(now, options.zone ?? "UTC");
  const folder = "global/tasks";
  ensureTasksFolder(vaultRoot, "global");
  const tasks: GeneratedTask[] = [];

  const write = (
    kind: TaskKind,
    status: TaskStatus,
    title: string,
    extra: Record<string, unknown>,
    transform?: (text: string) => string,
  ): void => {
    const id = noteId(rand);
    const created = new Date(now.getTime() - 3_600_000).toISOString();
    const proposed = status === "proposed";
    const frontmatter = TaskFrontmatterSchema.parse({
      id,
      scope: "global",
      stage: "capture",
      created,
      updated: created,
      generatedBy: proposed ? { automation: "daily-brief" } : {},
      aiGenerated: proposed,
      ...(proposed ? { claimType: "recommendation" } : {}),
      sources: [],
      confidence: "unverified",
      lastReviewed: null,
      type: "task",
      title,
      status,
      dependencies: [],
      tags: [],
      ...(proposed ? { assignee: "automation", sourceType: "automation" } : {}),
      ...extra,
    });
    const path = `${folder}/${taskFileName(title, id)}`;
    const text = stringifyTaskNote(frontmatter, "Synthetic live-check task.\n");
    writeFileSync(
      join(vaultRoot, ...path.split("/")),
      transform === undefined ? text : transform(text),
    );
    tasks.push({
      id,
      path,
      scope: "global",
      kind,
      status,
      title,
      ...(typeof extra.due === "string" ? { due: extra.due } : {}),
      dependencies: [],
    });
  };

  // U-6: a date as the Properties editor writes it, unquoted and with no time.
  write("today-date", "ready", "Live check properties style date", { due: day.localDate }, (text) =>
    text.replace(/^due: ['"]?(\d{4}-\d{2}-\d{2})['"]?$/m, "due: $1"),
  );
  write("proposed", "proposed", "Live check proposed plain", {});
  write("proposed", "proposed", VALID_HOSTILE_TASK_TITLES[0] as string, {});
  write("proposed", "proposed", "Live check proposed with source", {
    sourceLink: "https://example.invalid/synthetic-source",
  });

  const unreadable: string[] = [];
  const raw = (name: string, text: string): void => {
    const path = `${folder}/${name}`;
    writeFileSync(join(vaultRoot, ...path.split("/")), text);
    unreadable.push(path);
  };
  raw(
    "live-check-oversize-frontmatter.md",
    `---\nid: ${noteId(rand)}\npad: ${"x".repeat(OVERSIZE_PAD_BYTES)}\n---\nbody\n`,
  );
  raw("live-check-unparseable.md", "---\nid: [unclosed\n---\nbody\n");
  return { tasks, unreadable };
}
