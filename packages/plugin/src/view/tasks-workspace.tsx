import type { TaskFilter } from "@ccc/domain/tasks.js";
import { effect } from "@preact/signals";
import type { ComponentChildren, RefObject, VNode } from "preact";
import { useEffect } from "preact/hooks";
import { tasksApi } from "../tasks/api.js";
import type { TasksContext } from "../tasks/contexts.js";
import { consumeTaskFormRequest, taskFormRequested } from "./navigation-request.js";
import { notify } from "./notify-port.js";
import { TaskChips } from "./task-chips.js";
import { TaskCreateForm, type TaskFormOption } from "./task-form.js";
import { TaskList, type TaskRowAction } from "./task-list.js";
import type { TasksViewState } from "./tasks-view-state.js";

/**
 * The part of a Tasks surface both containers share (plan 06-22; D-34, TASK-07):
 * the chip toolbar, the one polite status line, the inline create form and the
 * list. The global destination and a project panel each mount this over their
 * OWN {@link TasksContext} and {@link TasksViewState}, so the two surfaces share
 * components and no state. It imports no client, connector, executor or
 * `obsidian`; every write goes through functions this module's callers supply
 * or the task API holder.
 */
export interface TasksWorkspaceProps {
  readonly context: TasksContext;
  readonly view: TasksViewState;
  readonly connected: boolean;
  readonly now: number;
  readonly zone: string;
  readonly projects: readonly TaskFormOption[];
  readonly workspaces: readonly TaskFormOption[];
  /** The chips to show; a project panel omits Project. */
  readonly filters?: readonly TaskFilter[] | undefined;
  /** The project panel's project, preselected in the create form. */
  readonly defaultProjectId?: string | undefined;
  /** The project panel's display name, for its empty line. */
  readonly projectName?: string | null | undefined;
  /** The control that opens the create form; focus returns to it when the form closes. */
  readonly openerRef: RefObject<HTMLElement>;
  /** Shown before the chips in the toolbar row: the scope and project selects. */
  readonly toolbarLead?: ComponentChildren;
  /** True while a rebuild runs: the last good rows stay and say so. */
  readonly rebuilding?: boolean | undefined;
  /** Whether this surface listens for the create-form intent (the global destination does). */
  readonly listensForFormIntent?: boolean | undefined;
  onRowAction(action: TaskRowAction, rowId: string): Promise<void>;
}

function nameMap(options: readonly TaskFormOption[]): Readonly<Record<string, string>> {
  return Object.fromEntries(options.map((option) => [option.id, option.name]));
}

export function TasksWorkspace(props: TasksWorkspaceProps): VNode {
  const { context, view, connected } = props;

  // The create-form intent: opens the form once, whether it was set before this
  // surface mounted or arrives while it is on screen.
  useEffect(() => {
    if (props.listensForFormIntent === false) return undefined;
    return effect(() => {
      if (taskFormRequested.value) {
        consumeTaskFormRequest();
        view.formOpen.value = true;
      }
    });
  }, [view, props.listensForFormIntent]);

  const error = context.error.value;
  const rows = context.rows.value;
  const counts = context.counts.value;
  const effectiveConnected = connected && error !== "service-disconnected";
  const status =
    counts === null && error === null
      ? "loading"
      : error !== null && rows.length === 0 && counts === null
        ? "error"
        : "ready";

  return (
    <>
      <div className="ccc-tasks-toolbar">
        {props.toolbarLead}
        <TaskChips
          active={context.filter.value}
          counts={counts === null ? null : counts.counts}
          filters={props.filters}
          onSelect={(filter) => {
            void context.setFilter(filter);
          }}
        />
      </div>
      <p className="ccc-tasks-status" role="status">
        {view.status.value}
      </p>
      {view.formOpen.value ? (
        <TaskCreateForm
          connected={effectiveConnected}
          zone={props.zone}
          projects={props.projects}
          workspaces={props.workspaces}
          defaultProjectId={props.defaultProjectId}
          defaultScope={context.scope.value === "all" ? "global" : context.scope.value}
          create={async (request) => {
            const created = await tasksApi().create(request);
            void context.refresh();
            return created;
          }}
          onStatus={(text) => {
            view.status.value = text;
          }}
          onNotice={notify}
          onClose={() => {
            view.formOpen.value = false;
          }}
          getOpener={() => props.openerRef.current}
        />
      ) : null}
      <TaskList
        filter={context.filter.value}
        rows={rows}
        total={context.total.value}
        selectedId={context.selectedTaskId.value}
        connected={effectiveConnected}
        now={props.now}
        zone={props.zone}
        projectNames={nameMap(props.projects)}
        status={status}
        busy={context.busy.value}
        stale={props.rebuilding === true}
        rebuilding={props.rebuilding === true}
        chooseProject={context.chooseProject.value}
        projectName={props.projectName}
        noTasksAtAll={counts !== null && counts.counts.all === 0}
        hasMore={context.nextCursor.value !== null}
        onLoadMore={() => {
          void context.loadMore();
        }}
        onCreate={() => {
          view.formOpen.value = true;
        }}
        announce={(text) => {
          view.status.value = text;
        }}
        onSelect={(id) => context.select(id)}
        onAction={(action, row) => props.onRowAction(action, row.id)}
      />
    </>
  );
}
