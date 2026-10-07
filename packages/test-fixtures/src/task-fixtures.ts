import type { TaskCountsResponse, TaskFilter, TaskStatus } from "@ccc/domain";

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

const NOT_IMPLEMENTED = "task fixtures are not implemented yet (RED)";

/** Creates and initialises the managed vault at an existing empty `vaultRoot`, then fills it with task notes. */
export function generateTaskVault(
  _vaultRoot: string,
  _options: GenerateTaskVaultOptions,
): GeneratedTaskVault {
  throw new Error(NOT_IMPLEMENTED);
}

/** A throwaway vault under the shared test base, removed afterwards. */
export async function withTaskVault<T>(
  _options: GenerateTaskVaultOptions,
  _fn: (vault: GeneratedTaskVault) => Promise<T> | T,
): Promise<T> {
  throw new Error(NOT_IMPLEMENTED);
}

/** The UTC day containing `now` (the zone every generated date is relative to). */
export function utcDay(_now: Date): DayBounds {
  throw new Error(NOT_IMPLEMENTED);
}

/** The ids a filter should return, computed independently of the index from the generator's own record. */
export function expectedIds(
  _tasks: readonly GeneratedTask[],
  _filter: TaskFilter,
  _selector: string,
  _day: DayBounds,
  _projectId?: string,
): string[] {
  throw new Error(NOT_IMPLEMENTED);
}

/** The chip counts and open total the counts route should answer. */
export function expectedCounts(
  _tasks: readonly GeneratedTask[],
  _selector: string,
  _day: DayBounds,
  _projectId?: string,
): TaskCountsResponse {
  throw new Error(NOT_IMPLEMENTED);
}

/** SHA-256 of every regular file under `root`, keyed by POSIX-relative path. */
export function hashVaultFiles(_root: string): Record<string, string> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Copies a note to a second file name in the same folder (a duplicated id); returns the new vault-relative path. */
export function duplicateTaskNote(
  _vaultRoot: string,
  _relativePath: string,
  _name: string,
): string {
  throw new Error(NOT_IMPLEMENTED);
}
