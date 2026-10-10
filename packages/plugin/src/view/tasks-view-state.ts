import { type Signal, signal } from "@preact/signals";
import type { TaskDetailTask } from "./task-detail.js";
import type { TaskFormOption } from "./task-form.js";

/**
 * The Tasks views' in-memory view state (plan 06-22; UI-SPEC "Interaction and
 * keyboard contract"). The create form's open flag, the section's one polite
 * message, the selected task's loaded detail and the dirty and leave flags are
 * plain signals made INSIDE {@link createTasksViewState}, so the global
 * destination and every project panel own separate sets (TASK-07). Nothing here
 * is persisted: a destination resets its set when it unmounts.
 */

/** The detail pane's load state for the selected task. */
export type TaskDetailLoad =
  | { readonly kind: "none" }
  | { readonly kind: "loading"; readonly id: string }
  | { readonly kind: "ready"; readonly task: TaskDetailTask }
  | { readonly kind: "missing"; readonly id: string };

export interface TasksViewState {
  readonly formOpen: Signal<boolean>;
  /** The section's one polite message; a new message replaces the old one. */
  readonly status: Signal<string>;
  readonly detail: Signal<TaskDetailLoad>;
  readonly dirty: Signal<boolean>;
  /** Set while the owner tried to leave a dirty pane; the pane shows its confirmation. */
  readonly leaveRequest: Signal<boolean>;
}

export function createTasksViewState(): TasksViewState {
  return {
    formOpen: signal(false),
    status: signal(""),
    detail: signal<TaskDetailLoad>({ kind: "none" }),
    dirty: signal(false),
    leaveRequest: signal(false),
  };
}

/** Puts a state back to what a fresh mount sees. */
export function resetTasksViewState(state: TasksViewState): void {
  state.formOpen.value = false;
  state.status.value = "";
  state.detail.value = { kind: "none" };
  state.dirty.value = false;
  state.leaveRequest.value = false;
}

/**
 * One-shot: the owner arrived with a task already chosen (an Overview row), so
 * the global destination focuses the pane's heading once it has loaded.
 */
export const taskDetailFocusRequested = signal(false);

/** The global destination's view state. */
export const globalTasksViewState: TasksViewState = createTasksViewState();

// ---------------------------------------------------------------------------
// Workspaces for the Scope selector

type WorkspaceLoader = () => Promise<readonly TaskFormOption[]>;

let workspaceLoader: WorkspaceLoader | null = null;

/** Installs the function that lists workspaces (the wiring plan); `null` restores none. */
export function configureTaskWorkspaces(loader: WorkspaceLoader | null): void {
  workspaceLoader = loader;
}

/** The longest workspace display name the selector shows. */
const WORKSPACE_NAME_MAX = 64;

/**
 * The workspaces for the Scope and Scope-field selects. A failed or absent
 * fetch gives none, so the selector still offers All scopes and Global. Names are
 * untrusted text, capped here and rendered as text nodes.
 */
export async function loadTaskWorkspaces(): Promise<readonly TaskFormOption[]> {
  if (workspaceLoader === null) return [];
  try {
    const loaded = await workspaceLoader();
    return loaded.map((option) => ({
      id: option.id,
      name: option.name.slice(0, WORKSPACE_NAME_MAX),
    }));
  } catch {
    return [];
  }
}
