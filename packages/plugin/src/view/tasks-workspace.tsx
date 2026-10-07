import type { TaskFilter } from "@ccc/domain/tasks.js";
import { effect } from "@preact/signals";
import type { ComponentChildren, RefObject, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { taskActionsPort } from "../tasks/actions-port.js";
import { tasksApi } from "../tasks/api.js";
import type { TasksContext } from "../tasks/contexts.js";
import { consumeTaskFormRequest, taskFormRequested } from "./navigation-request.js";
import { notify } from "./notify-port.js";
import { TaskChips } from "./task-chips.js";
import {
  TaskDetail,
  type TaskDetailAction,
  type TaskDetailEdit,
  type TaskDetailResult,
} from "./task-detail.js";
import { TaskCreateForm, type TaskFormOption } from "./task-form.js";
import { TaskList, type TaskRowAction } from "./task-list.js";
import {
  buildDetailTask,
  detailLoadFailedLine,
  failureReason,
  toDetailResult,
} from "./tasks-detail-model.js";
import { actionFailedLine, actionNotice } from "./tasks-forms-copy.js";
import type { TasksViewState } from "./tasks-view-state.js";

/**
 * The part of a Tasks surface both containers share (plan 06-22; D-34, TASK-07):
 * the chip toolbar, the one polite status line, the inline create form, the
 * list and the detail and edit pane. The global destination and a project panel
 * each mount this over their OWN {@link TasksContext} and {@link TasksViewState},
 * so the two surfaces share components and no state. It imports no client,
 * connector, executor or `obsidian`: every note edit goes through the actions
 * port, every read through the task API holder.
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
}

function nameMap(options: readonly TaskFormOption[]): Readonly<Record<string, string>> {
  return Object.fromEntries(options.map((option) => [option.id, option.name]));
}

function detailInput(
  edit: TaskDetailEdit,
  zone: string,
): Parameters<ReturnType<typeof taskActionsPort>["save"]>[1] {
  return {
    zone,
    ...(edit.title === undefined ? {} : { title: edit.title }),
    ...(edit.description === undefined ? {} : { description: edit.description }),
    ...(edit.status === undefined ? {} : { status: edit.status }),
    ...(edit.priority === undefined ? {} : { priority: edit.priority }),
    ...(edit.due === undefined ? {} : { due: edit.due }),
    ...(edit.scheduled === undefined ? {} : { scheduled: edit.scheduled }),
    ...(edit.projectId === undefined ? {} : { projectId: edit.projectId }),
    ...(edit.tags === undefined ? {} : { tags: edit.tags }),
  };
}

const ROW_ACTION_KIND: Readonly<Record<TaskRowAction, TaskDetailAction>> = {
  "mark-done": "mark-done",
  accept: "accept",
  dismiss: "dismiss",
};

export function TasksWorkspace(props: TasksWorkspaceProps): VNode {
  const { context, view, connected } = props;
  const pendingLeave = useRef<(() => void) | null>(null);
  const focusRequest = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const detailSequence = useRef(0);
  const restoreFocusTo = useRef<string | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

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

  async function loadDetail(id: string, silent: boolean): Promise<void> {
    const mine = ++detailSequence.current;
    if (!silent) view.detail.value = { kind: "loading", id };
    try {
      const got = await tasksApi().get({ taskId: id });
      const read = await taskActionsPort().readForEdit(got.task.path);
      if (mine !== detailSequence.current) return;
      if (read.kind !== "ok") {
        view.detail.value = { kind: "missing", id };
        return;
      }
      view.detail.value = {
        kind: "ready",
        task: buildDetailTask({
          detail: got.task,
          content: read.content,
          note: read.task,
          zone: latest.current.zone,
          workspaces: latest.current.workspaces,
        }),
      };
    } catch {
      if (mine === detailSequence.current) view.detail.value = { kind: "missing", id };
    }
  }

  // Selecting a task loads its detail; clearing the selection clears the pane.
  const selectedId = context.selectedTaskId.value;
  useEffect(() => {
    if (selectedId === null) {
      detailSequence.current += 1;
      view.detail.value = { kind: "none" };
      view.dirty.value = false;
      return;
    }
    void loadDetail(selectedId, false);
    // loadDetail reads only refs and stable holders.
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the selection alone
  }, [selectedId]);

  // Back to tasks: once the pane has gone, focus returns to the row's title button.
  useEffect(() => {
    const id = restoreFocusTo.current;
    if (selectedId !== null || id === null) return;
    restoreFocusTo.current = null;
    const row = [...(layoutRef.current?.querySelectorAll("[data-task-id]") ?? [])].find(
      (element) => element.getAttribute("data-task-id") === id,
    );
    row?.querySelector<HTMLElement>(".ccc-task-title")?.focus();
  }, [selectedId]);

  // The heading takes focus once, when a task the owner chose has loaded.
  const detail = view.detail.value;
  useEffect(() => {
    if (detail.kind === "ready" && focusRequest.current === detail.task.id) {
      focusRequest.current = null;
      headingRef.current?.focus();
    }
  }, [detail]);

  /** Runs `proceed` now, or after the pane's own confirmation when it has unsaved edits. */
  function requestLeave(proceed: () => void): void {
    if (!view.dirty.peek()) {
      proceed();
      return;
    }
    pendingLeave.current = proceed;
    view.leaveRequest.value = true;
  }

  function onLeaveDecision(decision: "discard" | "keep"): void {
    view.leaveRequest.value = false;
    const proceed = pendingLeave.current;
    pendingLeave.current = null;
    if (decision === "discard") {
      view.dirty.value = false;
      proceed?.();
    }
  }

  function selectTask(id: string): void {
    requestLeave(() => {
      focusRequest.current = id;
      context.select(id);
    });
  }

  function goBack(): void {
    const id = context.selectedTaskId.peek();
    requestLeave(() => {
      restoreFocusTo.current = id;
      context.select(null);
    });
  }

  async function afterApplied(taskId: string | null): Promise<void> {
    await context.refresh();
    if (taskId !== null && context.selectedTaskId.peek() === taskId) {
      await loadDetail(taskId, true);
    }
  }

  async function run(
    kind: TaskDetailAction,
    target: { readonly path: string; readonly expectedPriorContent?: string },
  ) {
    const port = taskActionsPort();
    switch (kind) {
      case "mark-done":
        return port.complete(target);
      case "reopen":
        return port.reopen(target);
      case "accept":
        return port.accept(target);
      case "dismiss":
        return port.dismiss(target);
    }
  }

  async function onRowAction(action: TaskRowAction, row: { id: string; title: string }) {
    const kind = ROW_ACTION_KIND[action];
    let path: string;
    try {
      path = (await tasksApi().get({ taskId: row.id })).task.path;
    } catch {
      view.status.value = actionFailedLine(kind, failureReason({ kind: "missing" }));
      return;
    }
    const outcome = toDetailResult(await run(kind, { path }));
    if (outcome.kind === "applied") {
      const text = kind === "mark-done" ? "Marked done." : actionNotice(kind, row.title);
      view.status.value = text;
      notify(text);
      await afterApplied(row.id);
    } else {
      view.status.value = actionFailedLine(kind, failureReason(outcome));
    }
  }

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

  function pane(): VNode {
    if (selectedId === null) {
      return renderDetail();
    }
    if (detail.kind === "loading") {
      return (
        <div className="ccc-task-detail-state" aria-busy="true">
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <div className="ccc-skeleton-line" aria-hidden="true" />
        </div>
      );
    }
    if (detail.kind === "missing") {
      return <p className="ccc-state-body">{detailLoadFailedLine()}</p>;
    }
    return renderDetail();
  }

  function renderDetail(): VNode {
    const task = detail.kind === "ready" ? detail.task : null;
    return (
      <TaskDetail
        task={task}
        projects={props.projects}
        connected={effectiveConnected}
        zone={props.zone}
        nowMs={props.now}
        headingRef={headingRef}
        leaveRequest={view.leaveRequest.value}
        onLeaveDecision={onLeaveDecision}
        onDirtyChange={(dirty) => {
          view.dirty.value = dirty;
        }}
        onStatus={(text) => {
          view.status.value = text;
        }}
        onNotice={notify}
        onOpenNote={(path) => taskActionsPort().openNote(path)}
        onSelectTask={selectTask}
        onReload={async () => {
          if (task !== null) await loadDetail(task.id, true);
        }}
        onSave={async (edit: TaskDetailEdit, expected: string): Promise<TaskDetailResult> => {
          if (task === null) return { kind: "missing" };
          const result = toDetailResult(
            await taskActionsPort().save(
              { path: task.path, expectedPriorContent: expected },
              detailInput(edit, props.zone),
            ),
          );
          if (result.kind === "applied") await afterApplied(task.id);
          return result;
        }}
        onAction={async (action: TaskDetailAction): Promise<TaskDetailResult> => {
          if (task === null) return { kind: "missing" };
          const result = toDetailResult(
            await run(action, { path: task.path, expectedPriorContent: task.content }),
          );
          if (result.kind === "applied") await afterApplied(task.id);
          return result;
        }}
      />
    );
  }

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
      <div
        className="ccc-tasks-layout"
        ref={layoutRef}
        data-detail={selectedId === null ? "closed" : "open"}
      >
        <div className="ccc-tasks-list-column">
          <TaskList
            filter={context.filter.value}
            rows={rows}
            total={context.total.value}
            selectedId={selectedId}
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
            onSelect={selectTask}
            onAction={(action, row) => onRowAction(action, row)}
          />
        </div>
        <div
          className="ccc-tasks-pane"
          data-empty={selectedId === null ? "true" : undefined}
          data-dimmed={effectiveConnected ? undefined : "true"}
        >
          {selectedId === null ? null : (
            <button type="button" className="ccc-tasks-back" onClick={goBack}>
              Back to tasks
            </button>
          )}
          {pane()}
        </div>
      </div>
    </>
  );
}
