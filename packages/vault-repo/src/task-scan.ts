import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkPathContainment,
  isTaskNotePath,
  TASK_FILE_MAX_BYTES,
  TASKS_FOLDER_NAME,
  type TaskFrontmatter,
} from "@ccc/domain";
import { emptyTaskCounts, type TaskStatusCounts } from "./managed-folders.js";
import { hashTaskNoteBytes, parseTaskNote, TaskNoteError } from "./task-note.js";

/** The fixed reasons a task note lands in the attention list. */
export type TaskAttentionReason = "duplicate-id" | "missing-id" | "unreadable";

/** One note the scan could not index, with every path involved. */
export interface TaskAttention {
  readonly reason: TaskAttentionReason;
  /** Vault-relative, POSIX-separated, sorted. */
  readonly paths: readonly string[];
  /** The shared id, for a duplicate. */
  readonly id?: string;
  /** A constant sentence; never quotes note text. */
  readonly detail: string;
}

/** One valid, unambiguous task. */
export interface ScannedTask {
  /** Vault-relative, POSIX-separated. */
  readonly path: string;
  readonly frontmatter: TaskFrontmatter;
  /** SHA-256 of the complete file bytes. */
  readonly contentHash: string;
}

/** What one scan found. */
export interface TaskScanResult {
  readonly tasks: readonly ScannedTask[];
  readonly attention: readonly TaskAttention[];
  /** Per-status counts over the valid tasks of every scope. */
  readonly counts: TaskStatusCounts;
  /** The same counts per tasks folder, keyed by vault-relative folder. */
  readonly folderCounts: Readonly<Record<string, TaskStatusCounts>>;
  /** Files skipped because their names are not valid task note names. */
  readonly skipped: number;
}

/** A workspace folder name: the opaque 25-character id. */
const WORKSPACE_DIR = /^[0-9a-z]{25}$/;

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every tasks folder that exists, vault-relative and POSIX-separated, with its scope string. */
function tasksFolders(vaultRoot: string): { key: string; scope: string }[] {
  const folders: { key: string; scope: string }[] = [
    { key: `global/${TASKS_FOLDER_NAME}`, scope: "global" },
  ];
  let workspaceIds: string[] = [];
  try {
    workspaceIds = readdirSync(join(vaultRoot, "workspaces")).filter((name) =>
      WORKSPACE_DIR.test(name),
    );
  } catch {
    // No workspaces folder yet: there are no workspace tasks.
  }
  for (const id of workspaceIds.sort(compareStrings)) {
    folders.push({
      key: `workspaces/${id}/${TASKS_FOLDER_NAME}`,
      scope: `workspace:${id}`,
    });
  }
  return folders.filter(({ key }) => isDirectory(join(vaultRoot, ...key.split("/"))));
}

/**
 * Walks every tasks folder and returns the valid tasks, an attention list and
 * per-status counts. It is a pure read: it never writes, mints an id, renames
 * or deletes anything (prohibition TASK-02, D-37).
 *
 * Ambiguity is surfaced, never resolved: two notes sharing an id are BOTH
 * left out of `tasks` and named together in one `duplicate-id` entry; a note
 * with no id is a `missing-id` entry; one whose metadata cannot be read (bad
 * YAML, wrong shape, over the size limit, a scope that is not its folder's)
 * is an `unreadable` entry. Entries carry fixed sentences and paths only,
 * never note text.
 *
 * Only direct children of a tasks folder are read. Dotfiles, non-markdown
 * files, symbolic links and `index.md` are ignored; a markdown file whose name
 * is not a valid task note name (control characters, and so on) is counted in
 * `skipped` and not listed. `contentHash` is the SHA-256 of the complete file
 * bytes, so any frontmatter edit changes it.
 */
export function scanTaskNotes(vaultRoot: string): TaskScanResult {
  const tasks: ScannedTask[] = [];
  const attention: TaskAttention[] = [];
  const folderCounts: Record<string, TaskStatusCounts> = {};
  let skipped = 0;

  for (const { key, scope } of tasksFolders(vaultRoot)) {
    const folderPath = join(vaultRoot, ...key.split("/"));
    folderCounts[key] = emptyTaskCounts();
    // A tasks folder that is a symbolic link out of the vault is not vault content.
    if (!checkPathContainment(folderPath, vaultRoot).contained) continue;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(folderPath, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") || !name.endsWith(".md") || !entry.isFile()) continue;
      if (name.toLowerCase() === "index.md") continue;
      const path = `${key}/${name}`;
      if (!isTaskNotePath(path)) {
        skipped += 1;
        continue;
      }

      const absolute = join(folderPath, name);
      let bytes: Buffer;
      try {
        if (statSync(absolute).size > TASK_FILE_MAX_BYTES) {
          attention.push({
            reason: "unreadable",
            paths: [path],
            detail: "task note is over the size limit",
          });
          continue;
        }
        bytes = readFileSync(absolute);
      } catch {
        attention.push({
          reason: "unreadable",
          paths: [path],
          detail: "task note could not be read",
        });
        continue;
      }

      try {
        const { frontmatter } = parseTaskNote(bytes.toString("utf8"));
        if (frontmatter.scope !== scope) {
          attention.push({
            reason: "unreadable",
            paths: [path],
            detail: "task note scope does not match its folder",
          });
          continue;
        }
        tasks.push({ path, frontmatter, contentHash: hashTaskNoteBytes(bytes) });
      } catch (error) {
        if (error instanceof TaskNoteError && error.reason === "missing-id") {
          attention.push({ reason: "missing-id", paths: [path], detail: error.message });
        } else {
          attention.push({
            reason: "unreadable",
            paths: [path],
            detail: error instanceof TaskNoteError ? error.message : "task note could not be read",
          });
        }
      }
    }
  }

  // Group by id across every scope: the id is the index's primary key.
  const byId = new Map<string, ScannedTask[]>();
  for (const task of tasks) {
    const group = byId.get(task.frontmatter.id);
    if (group === undefined) byId.set(task.frontmatter.id, [task]);
    else group.push(task);
  }
  const duplicated = new Set<string>();
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    duplicated.add(id);
    attention.push({
      reason: "duplicate-id",
      paths: group.map((task) => task.path).sort(compareStrings),
      id,
      detail: `${group.length} task notes share one id; none is indexed`,
    });
  }

  const valid = tasks
    .filter((task) => !duplicated.has(task.frontmatter.id))
    .sort((a, b) => compareStrings(a.path, b.path));

  const counts: Record<string, number> = { ...emptyTaskCounts() };
  for (const task of valid) {
    counts[task.frontmatter.status] = (counts[task.frontmatter.status] ?? 0) + 1;
    const folder = task.path.slice(0, task.path.lastIndexOf("/"));
    const perFolder = folderCounts[folder] as Record<string, number> | undefined;
    if (perFolder !== undefined) {
      perFolder[task.frontmatter.status] = (perFolder[task.frontmatter.status] ?? 0) + 1;
    }
  }

  attention.sort((a, b) => {
    if (a.reason !== b.reason) return compareStrings(a.reason, b.reason);
    return compareStrings(a.paths[0] ?? "", b.paths[0] ?? "");
  });

  return {
    tasks: valid,
    attention,
    counts: counts as TaskStatusCounts,
    folderCounts,
    skipped,
  };
}
