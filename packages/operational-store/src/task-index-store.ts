import type {
  ClaimType,
  ConfidenceState,
  LocalDayBounds,
  TaskFilter,
  TaskPriority,
  TaskStatus,
} from "@ccc/domain";
import type Database from "better-sqlite3";

/** RED skeleton for plan 06-14: the types and signatures only; nothing is indexed yet. */
export interface TaskIndexRecord {
  readonly noteId: string;
  readonly path: string;
  readonly scope: string;
  readonly projectId?: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority?: TaskPriority;
  readonly due?: string;
  readonly scheduled?: string;
  readonly completed?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentId?: string;
  readonly sourceType: string;
  readonly assignee?: "user" | "automation";
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly dependencies: readonly string[];
  readonly decision?: { readonly outcome: "accepted" | "dismissed"; readonly at: string };
  readonly aiGenerated: boolean;
  readonly claimType: ClaimType | null;
  readonly confidence: ConfidenceState;
}

export interface TaskIndexRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority?: TaskPriority;
  readonly scope: string;
  readonly projectId?: string;
  readonly dueDate?: string;
  readonly dueAt?: string;
  readonly scheduledDate?: string;
  readonly scheduledAt?: string;
  readonly completedAt?: string;
  readonly tags: readonly string[];
  readonly tagCount: number;
  readonly unmetDependencies: number;
  readonly overdue: boolean;
  readonly updatedAt: string;
}

export interface TaskPage {
  readonly rows: readonly TaskIndexRow[];
  readonly total: number;
  readonly nextCursor: null;
  readonly chooseProject: boolean;
}

export class InvalidTaskIndexError extends Error {
  constructor(field: string, value: string) {
    super(`"${value}" is not a valid ${field}`);
    this.name = "InvalidTaskIndexError";
  }
}

export function upsertTask(_db: Database.Database, _record: TaskIndexRecord): void {}

export function getTask(
  _db: Database.Database,
  _id: string,
  _day?: LocalDayBounds,
): TaskIndexRow | null {
  return null;
}

export function queryTasks(
  _db: Database.Database,
  _query: {
    readonly context: { readonly scope: string; readonly projectId?: string };
    readonly filter: TaskFilter;
    readonly day: LocalDayBounds;
  },
): TaskPage {
  return { rows: [], total: 0, nextCursor: null, chooseProject: false };
}
