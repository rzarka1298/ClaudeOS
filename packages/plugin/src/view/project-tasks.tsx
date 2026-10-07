import { resolvedZone } from "@ccc/domain/task-time.js";
import { TASK_PROJECT_PANEL_FILTERS } from "@ccc/domain/tasks.js";
import type { Ref, VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { createProjectTasksContext, type TasksContext } from "../tasks/contexts.js";
import { tasksGeneration } from "../tasks/events.js";
import { tasksRebuilding } from "../tasks/rebuild.js";
import type { TaskFormOption } from "./task-form.js";
import { CREATE_TASK_LABEL, DISCONNECTED_REASON } from "./tasks-copy.js";
import {
  createTasksViewState,
  loadTaskWorkspaces,
  resetTasksViewState,
  type TasksViewState,
} from "./tasks-view-state.js";
import { TasksWorkspace } from "./tasks-workspace.js";

/**
 * The project tasks panel (plan 06-22; UI-SPEC S4, D-34, TASK-07). It owns a
 * context and a view state made for ONE project when the panel mounts, so it
 * shares no state with the global destination or with any other panel: there is
 * nothing shared to disturb. It reuses the destination's components through
 * {@link TasksWorkspace} with seven chips (no Project), default All and no Scope
 * select; its create form preselects the project and keeps Scope editable.
 */
export interface ProjectTasksPanelProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly zone?: string | undefined;
  /** Registered projects for the form's Project select. */
  readonly projects: readonly TaskFormOption[];
  readonly workspaces?: readonly TaskFormOption[] | undefined;
  /** Closes the panel; the host returns focus to the Show tasks button. */
  readonly onClose: () => void;
  /** Tests and the harness may pass their own context and view state. */
  readonly context?: TasksContext | undefined;
  readonly view?: TasksViewState | undefined;
  readonly headingRef?: Ref<HTMLHeadingElement> | undefined;
}

export function ProjectTasksPanel(props: ProjectTasksPanelProps): VNode {
  const [owned] = useState(() => ({
    context: createProjectTasksContext(props.projectId),
    view: createTasksViewState(),
  }));
  const context = props.context ?? owned.context;
  const view = props.view ?? owned.view;
  const zone = props.zone ?? resolvedZone();
  const connected = props.connection.kind !== "disconnected";
  const hasWorkspacesProp = props.workspaces !== undefined;
  const [loadedWorkspaces, setLoadedWorkspaces] = useState<readonly TaskFormOption[]>([]);
  const workspaces = props.workspaces ?? loadedWorkspaces;
  const heading = useRef<HTMLHeadingElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const reasonId = useId();
  const swallow = useRef(false);

  useEffect(() => {
    void context.load();
    if (!hasWorkspacesProp) void loadTaskWorkspaces().then(setLoadedWorkspaces);
    heading.current?.focus();
    return () => {
      resetTasksViewState(view);
      context.select(null);
    };
  }, [context, view, hasWorkspacesProp]);

  const generation = tasksGeneration.value;
  const seenGeneration = useRef(generation);
  useEffect(() => {
    if (generation === seenGeneration.current) return;
    seenGeneration.current = generation;
    void context.refresh();
  }, [generation, context]);

  const previousKind = useRef(props.connection.kind);
  useEffect(() => {
    if (previousKind.current !== "live" && props.connection.kind === "live") {
      void context.refresh();
    }
    previousKind.current = props.connection.kind;
  }, [props.connection.kind, context]);

  return (
    <section
      className="ccc-project-tasks"
      aria-label={`Tasks · ${props.projectName}`}
      onKeyDownCapture={(event) => {
        // An Escape that is about to close the create form or a confirmation is not the panel's.
        swallow.current =
          event.key === "Escape" && (view.formOpen.peek() || view.leaveRequest.peek());
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || swallow.current) return;
        event.preventDefault();
        props.onClose();
      }}
    >
      <div className="ccc-project-tasks-header">
        <h3
          ref={(element) => {
            heading.current = element;
            if (typeof props.headingRef === "function") props.headingRef(element);
          }}
          tabIndex={-1}
        >
          {`Tasks · ${props.projectName}`}
        </h3>
        <button
          type="button"
          ref={opener}
          className="ccc-connect-button"
          data-variant="primary"
          aria-disabled={connected ? undefined : "true"}
          aria-describedby={connected ? undefined : reasonId}
          onClick={() => {
            if (connected) view.formOpen.value = true;
          }}
        >
          {CREATE_TASK_LABEL}
        </button>
        {connected ? null : (
          <span id={reasonId} className="ccc-visually-hidden">
            {DISCONNECTED_REASON}
          </span>
        )}
        <button
          type="button"
          className="ccc-list-more"
          data-variant="tertiary"
          onClick={props.onClose}
        >
          Close project tasks
        </button>
      </div>
      <TasksWorkspace
        context={context}
        view={view}
        connected={connected}
        now={props.now}
        zone={zone}
        projects={props.projects}
        workspaces={workspaces}
        filters={TASK_PROJECT_PANEL_FILTERS}
        defaultProjectId={props.projectId}
        projectName={props.projectName}
        openerRef={opener}
        rebuilding={tasksRebuilding.value}
        listensForFormIntent={false}
      />
    </section>
  );
}
