import { resolvedZone } from "@ccc/domain/task-time.js";
import type { TaskCountsResponse } from "@ccc/domain/tasks.js";
import type { VNode } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { projectsSnapshot } from "../projects/projects-state.js";
import { taskActionsPort } from "../tasks/actions-port.js";
import { globalTasksContext, type TasksContext } from "../tasks/contexts.js";
import { tasksGeneration } from "../tasks/events.js";
import {
  loadAttention,
  loadMoreAttention,
  tasksAttention,
  tasksRebuilding,
} from "../tasks/rebuild.js";
import { WidgetFooter } from "../widgets/footer.js";
import type { FooterModel } from "../widgets/presentation.js";
import { AttentionList } from "./attention-list.js";
import type { TaskFormOption } from "./task-form.js";
import { CREATE_TASK_LABEL, DISCONNECTED_REASON, formatCount } from "./tasks-copy.js";
import {
  globalTasksViewState,
  loadTaskWorkspaces,
  resetTasksViewState,
  type TasksViewState,
} from "./tasks-view-state.js";
import { TasksWorkspace } from "./tasks-workspace.js";

/**
 * The Tasks destination (plan 06-22; UI-SPEC S3): the global query context's
 * container. It reads the global context, the view state and the API and actions
 * holders, and hands the shared components their props; it never imports
 * `obsidian` or the service client. The shell's own `h2` is the destination's
 * title, so this surface adds none.
 */
export interface TasksDestinationProps {
  readonly connection: ConnectionState;
  readonly now: number;
  /** Defaults to the global context; tests and the harness pass their own. */
  readonly context?: TasksContext | undefined;
  readonly view?: TasksViewState | undefined;
  /** The owner's IANA zone; defaults to the runtime's own. */
  readonly zone?: string | undefined;
  /** Registered projects for the selects and names; defaults to the projects snapshot. */
  readonly projects?: readonly TaskFormOption[] | undefined;
  /** Workspaces for the Scope selects; defaults to the configured loader's answer. */
  readonly workspaces?: readonly TaskFormOption[] | undefined;
}

/** `12 open · 1 overdue · 2 proposed`; a segment at zero is omitted. */
export function summaryLine(counts: TaskCountsResponse | null): string {
  if (counts === null) return "";
  const parts: string[] = [];
  if (counts.open > 0) parts.push(`${formatCount(counts.open)} open`);
  if (counts.counts.overdue > 0) parts.push(`${formatCount(counts.counts.overdue)} overdue`);
  if (counts.counts.proposed > 0) parts.push(`${formatCount(counts.counts.proposed)} proposed`);
  return parts.join(" · ");
}

const SOURCE_LABEL = "Task index";

function footerModel(
  connected: boolean,
  observedAt: string | null,
  hasCounts: boolean,
): FooterModel {
  if (!connected) {
    return {
      observedAt,
      freshness: "unavailable",
      partiality: null,
      sources: [{ label: SOURCE_LABEL, status: "disconnected" }],
    };
  }
  return {
    observedAt,
    freshness: hasCounts ? "live" : null,
    partiality: null,
    sources: [{ label: SOURCE_LABEL, status: hasCounts ? "ok" : "no-source" }],
  };
}

/** `2 task notes need attention and are left out` (the Partial chip's accessible name tail, R-28). */
function partialText(count: number): string {
  return count === 1
    ? "1 task note needs attention and is left out"
    : `${formatCount(count)} task notes need attention and are left out`;
}

export function projectOptions(): readonly TaskFormOption[] {
  const snapshot = projectsSnapshot.value;
  return (snapshot?.projects ?? []).map((project) => ({
    id: project.projectId,
    name: project.displayName,
  }));
}

export function TasksDestination(props: TasksDestinationProps): VNode {
  const context = props.context ?? globalTasksContext;
  const view = props.view ?? globalTasksViewState;
  const zone = props.zone ?? resolvedZone();
  const connected = props.connection.kind !== "disconnected";
  const projects = props.projects ?? projectOptions();
  const [loadedWorkspaces, setLoadedWorkspaces] = useState<readonly TaskFormOption[]>([]);
  const hasWorkspacesProp = props.workspaces !== undefined;
  const workspaces = props.workspaces ?? loadedWorkspaces;
  const opener = useRef<HTMLButtonElement | null>(null);
  const reasonId = useId();
  const receivedAt = useRef<string | null>(null);
  const nowRef = useRef(props.now);
  nowRef.current = props.now;

  const counts = context.counts.value;
  const attentionTotal = tasksAttention.total.value;
  useMemo(() => {
    if (counts !== null) receivedAt.current = new Date(nowRef.current).toISOString();
  }, [counts]);

  // First load, and a fresh view state on the way out (nothing here is persisted).
  useEffect(() => {
    void context.load();
    void loadAttention();
    if (!hasWorkspacesProp) {
      void loadTaskWorkspaces().then(setLoadedWorkspaces);
    }
    return () => {
      resetTasksViewState(view);
      context.select(null);
    };
  }, [context, view, hasWorkspacesProp]);

  // A `tasks.changed` generation advance asks again; the first read is the mount's own load.
  const generation = tasksGeneration.value;
  const seenGeneration = useRef(generation);
  useEffect(() => {
    if (generation === seenGeneration.current) return;
    seenGeneration.current = generation;
    void context.refresh();
    void loadAttention();
  }, [generation, context]);

  // Coming back from a drop re-asks; the generation resets with the service.
  const previousKind = useRef(props.connection.kind);
  useEffect(() => {
    if (previousKind.current !== "live" && props.connection.kind === "live") {
      void context.refresh();
      void loadAttention();
    }
    previousKind.current = props.connection.kind;
  }, [props.connection.kind, context]);

  return (
    <section className="ccc-tasks" aria-label="Tasks">
      <div className="ccc-tasks-header">
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
      </div>
      <p className="ccc-tasks-summary">{summaryLine(counts)}</p>
      <div className="ccc-tasks-strip">
        <WidgetFooter
          model={footerModel(connected, receivedAt.current, counts !== null)}
          panelTitle="tasks"
          now={props.now}
          dimmed={!connected}
        />
        {attentionTotal > 0 ? (
          <span className="ccc-badge" data-badge="partial">
            <span className="ccc-badge-glyph" aria-hidden="true">
              ◈
            </span>
            <span className="ccc-badge-label">Partial</span>
            <span className="ccc-visually-hidden">{` — ${partialText(attentionTotal)}`}</span>
          </span>
        ) : null}
      </div>
      <TasksWorkspace
        context={context}
        view={view}
        connected={connected}
        now={props.now}
        zone={zone}
        projects={projects}
        workspaces={workspaces}
        openerRef={opener}
        rebuilding={tasksRebuilding.value}
        toolbarLead={
          <>
            <label className="ccc-tasks-select">
              <span className="ccc-field-label">Scope</span>
              <select
                className="ccc-text-input"
                value={context.scope.value}
                onChange={(event) => {
                  context.setScope(event.currentTarget.value);
                  void context.load();
                }}
              >
                <option value="all">All scopes</option>
                <option value="global">Global</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            {context.filter.value === "project" ? (
              <label className="ccc-tasks-select">
                <span className="ccc-field-label">Project</span>
                <select
                  className="ccc-text-input"
                  value={context.projectId.value ?? ""}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    context.setProject(value === "" ? undefined : value);
                    void context.load();
                  }}
                >
                  <option value="">Choose a project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        }
      />
      {attentionTotal > 0 ? (
        <AttentionList
          items={tasksAttention.items.value}
          total={attentionTotal}
          hasMore={tasksAttention.nextCursor.value !== null}
          connected={connected}
          onShowMore={() => {
            void loadMoreAttention();
          }}
          onOpenNote={(path) => taskActionsPort().openNote(path)}
        />
      ) : null}
    </section>
  );
}
