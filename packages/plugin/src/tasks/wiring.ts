import { TASK_ERROR_CODES, type TaskRebuildResponse } from "@ccc/domain/tasks.js";
import type { TasksClient } from "@ccc/service-api-client";
import type { ManagedNoteFile } from "../conflict-safe.js";
import type { HostRegistry } from "../host-registry.js";
import type { TaskFormOption } from "../view/task-form.js";
import { configureTaskWorkspaces } from "../view/tasks-view-state.js";
import {
  acceptTask,
  completeTask,
  dismissTask,
  reopenTask,
  saveTask,
  type TaskActionDeps,
  type TaskActionResult,
} from "./actions.js";
import { configureTaskActionsPort, type TaskNoteTarget } from "./actions-port.js";
import { configureTasksApi, type TasksApi, TasksApiError, tasksApi } from "./api.js";
import { registerCreateTaskCommand } from "./commands.js";
import { globalTasksContext } from "./contexts.js";
import { resetTasksGeneration } from "./events.js";
import { loadAttention, rebuildTaskIndex } from "./rebuild.js";
import { type ReadTaskResult, readTaskForEdit, type TaskEditVault } from "./task-update.js";
import { registerTaskVaultWatch } from "./watch.js";

/**
 * Connects the task modules to Obsidian and the service (plan 06-23; D-35, D-37,
 * A-10, TASK-08). Every registration goes through the host registry. A note is
 * only ever edited through the conflict-safe functions in `actions.ts`, looked
 * up in the vault by its vault-relative path; this file reaches no launcher, no
 * approval function and no network of its own.
 */

/** The structural vault the wiring needs: the conflict-safe edit surface plus a path lookup. */
export type TaskNoteVault = TaskEditVault & {
  getFileByPath(path: string): ManagedNoteFile | null;
};

export interface WireTasksDeps {
  /** The tasks client built from the authenticated connection (injected, never imported by value). */
  readonly client: TasksClient;
  readonly vault: TaskNoteVault;
  /** Opens a note in the workspace by vault-relative path. */
  readonly openNote: (path: string) => void;
  /** Reveals the command center view (the Create task command). */
  readonly reveal: () => void;
  readonly now: () => number;
  /** Lists the workspaces for the Scope selector and the create form. */
  readonly listWorkspaces: () => Promise<readonly TaskFormOption[]>;
  /** Receives the class name of a failed watcher flush, never the message. */
  readonly log: (className: string) => void;
}

export interface TasksWiring {
  /** The Rebuild task index action: re-reads every note, reloads the lists, answers the counts. */
  readonly rebuild: () => Promise<TaskRebuildResponse>;
  /** The connect hook: asks the service to rescan, then reloads the global list and attention list. */
  readonly onLive: () => void;
}

const CLOSED_CODES: ReadonlySet<string> = new Set(TASK_ERROR_CODES);

function toApiError(error: unknown): TasksApiError {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return new TasksApiError(
    typeof code === "string" && CLOSED_CODES.has(code)
      ? (code as TasksApiError["code"])
      : "unrecognised-response",
  );
}

async function closed<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toApiError(error);
  }
}

const UNREADABLE = { kind: "unreadable", reason: "read-failed" } as const;

export function wireTasks(registry: HostRegistry, deps: WireTasksDeps): TasksWiring {
  const client = deps.client;
  const api: TasksApi = {
    create: (request) => closed(() => client.create(request)),
    list: (request) => closed(() => client.list(request)),
    counts: (request) => closed(() => client.counts(request)),
    get: (request) => closed(() => client.get(request)),
    changed: (request) => closed(() => client.changed(request)),
    rebuild: () => closed(() => client.rebuild()),
    attention: (request) => closed(() => client.attention(request)),
    dueToday: (request) => closed(() => client.dueToday(request)),
  };
  configureTasksApi(api);
  registry.cleanup(() => {
    configureTasksApi(null);
    resetTasksGeneration();
  });

  // The watcher first: its ledger is the one the actions record their writes in.
  const { ownWrites } = registerTaskVaultWatch(registry, { now: deps.now, log: deps.log });
  const actionDeps: TaskActionDeps = { vault: deps.vault, ownWrites };

  const nowIso = (): string => new Date(deps.now()).toISOString();

  async function withFile(
    target: TaskNoteTarget,
    run: (
      file: ManagedNoteFile,
      expected: { expectedPriorContent: string } | object,
    ) => Promise<TaskActionResult>,
  ): Promise<TaskActionResult> {
    const file = deps.vault.getFileByPath(target.path);
    if (file === null) return UNREADABLE;
    return run(
      file,
      target.expectedPriorContent === undefined
        ? {}
        : { expectedPriorContent: target.expectedPriorContent },
    );
  }

  configureTaskActionsPort({
    complete: (target) =>
      withFile(target, (file, e) => completeTask(actionDeps, { file, ...e }, nowIso())),
    reopen: (target) =>
      withFile(target, (file, e) => reopenTask(actionDeps, { file, ...e }, nowIso())),
    accept: (target) =>
      withFile(target, (file, e) => acceptTask(actionDeps, { file, ...e }, nowIso())),
    dismiss: (target) =>
      withFile(target, (file, e) => dismissTask(actionDeps, { file, ...e }, nowIso())),
    save: (target, input) =>
      withFile(target, (file, e) => saveTask(actionDeps, { file, ...e }, nowIso(), input)),
    readForEdit: async (path): Promise<ReadTaskResult> => {
      const file = deps.vault.getFileByPath(path);
      return file === null ? UNREADABLE : readTaskForEdit(deps.vault, file);
    },
    openNote: (path) => deps.openNote(path),
  });
  registry.cleanup(() => configureTaskActionsPort(null));

  configureTaskWorkspaces(deps.listWorkspaces);
  registry.cleanup(() => configureTaskWorkspaces(null));

  registerCreateTaskCommand(registry, deps.reveal);

  return {
    rebuild: () => rebuildTaskIndex(),
    onLive: () => {
      tasksApi()
        .changed({ rescan: true })
        .then(() => Promise.all([globalTasksContext.refresh(), loadAttention()]))
        .catch(() => undefined);
    },
  };
}
