import { ProjectIdSchema } from "@ccc/domain/projects.js";
import type { TaskPriority } from "@ccc/domain/task-schema.js";
import {
  TASK_PRIORITY_DISPLAY,
  type TaskCreateIntent,
  type TaskCreateRequest,
} from "@ccc/domain/tasks.js";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  ADD_AS_READY_LABEL,
  ADD_TO_INBOX_LABEL,
  ADDING_STATUS,
  addedMessage,
  CLOSE_FORM_LABEL,
  FIELD_LABELS,
  GLOBAL_SCOPE_LABEL,
  NO_PROJECT_LABEL,
  TAGS_HELP,
} from "./tasks-forms-copy.js";

/**
 * The task create form (UI-SPEC S3 "Create form", TASK-03, E9): an inline panel
 * with native controls, two submit buttons and a close button. It is
 * props-driven: the create function, the status and notice callbacks, the
 * owner's zone, the connection fact and the project and workspace lists all
 * arrive as props. It imports no service client, connector, executor, signal or
 * `obsidian`, and never reads the clock, so the only call it can make outward
 * is the injected {@link TaskCreateFormProps.create} (TASK-08, T-06-24).
 *
 * Task text is untrusted. It only ever travels as a string value into the
 * request and, in the success line, as a text child.
 */

/** A project or workspace the form may choose. `id` is the value stored (a project id, or a scope string). */
export interface TaskFormOption {
  readonly id: string;
  readonly name: string;
}

export interface TaskCreateFormProps {
  /** False while the companion service is away. */
  readonly connected: boolean;
  /** The owner's IANA zone; the service turns a local date and time into an instant with it. */
  readonly zone: string;
  readonly projects: readonly TaskFormOption[];
  /** Workspaces for the Scope select; `id` is the scope value (`workspace:...`). */
  readonly workspaces: readonly TaskFormOption[];
  /** Preselects Project (the project panel). Ignored when it names no registered project. */
  readonly defaultProjectId?: string | undefined;
  /** The Scope default: `global` or a workspace scope. */
  readonly defaultScope?: string | undefined;
  readonly create: (request: TaskCreateRequest) => Promise<unknown>;
  readonly onStatus: (text: string) => void;
  readonly onNotice: (text: string) => void;
  readonly onClose: () => void;
  /** The control that opened the form; focus returns to it on close. */
  readonly getOpener?: () => HTMLElement | null;
}

/** The select lists priorities from lowest to highest after `No priority` (UI-SPEC S3). */
const PRIORITY_ORDER: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];

interface FormValues {
  readonly title: string;
  readonly description: string;
  readonly priority: TaskPriority | "";
  readonly due: string;
  readonly dueTime: string;
  readonly scheduled: string;
  readonly projectId: string;
  readonly scope: string;
  readonly tags: string;
}

function initialValues(props: TaskCreateFormProps): FormValues {
  const project =
    props.defaultProjectId !== undefined &&
    props.projects.some((option) => option.id === props.defaultProjectId)
      ? props.defaultProjectId
      : "";
  return {
    title: "",
    description: "",
    priority: "",
    due: "",
    dueTime: "",
    scheduled: "",
    projectId: project,
    scope: props.defaultScope ?? "global",
    tags: "",
  };
}

/** Maps the form values to the domain request; an empty optional field sends nothing. */
function buildRequest(
  values: FormValues,
  intent: TaskCreateIntent,
  zone: string,
): TaskCreateRequest {
  const tags = values.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  const project = ProjectIdSchema.safeParse(values.projectId);
  return {
    title: values.title.trim(),
    intent,
    zone,
    scope: values.scope,
    ...(values.description !== "" ? { description: values.description } : {}),
    ...(values.due !== "" ? { dueDate: values.due } : {}),
    ...(values.due !== "" && values.dueTime !== "" ? { dueTime: values.dueTime } : {}),
    ...(values.scheduled !== "" ? { scheduledDate: values.scheduled } : {}),
    ...(project.success ? { projectId: project.data } : {}),
    ...(values.priority !== "" ? { priority: values.priority } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function TaskCreateForm(props: TaskCreateFormProps): VNode {
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [values, setValues] = useState<FormValues>(() => initialValues(props));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async (intent: TaskCreateIntent): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    props.onStatus(ADDING_STATUS);
    setBusy(true);
    const request = buildRequest(values, intent, props.zone);
    try {
      await props.create(request);
      const message = addedMessage(request.title, intent);
      props.onStatus(message);
      props.onNotice(message);
      setValues(initialValues(props));
      titleRef.current?.focus();
    } catch {
      // The typed text stays; the failure wording arrives with the validation pass.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const id = (name: string): string => `${uid}-${name}`;
  const busyAria = busy ? "true" : undefined;

  return (
    <form
      className="ccc-task-form"
      data-panel="true"
      aria-label="Create a task"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit("inbox");
      }}
    >
      <div className="ccc-task-form-fields">
        <div className="ccc-task-field" data-wide="true">
          <label className="ccc-field-label" htmlFor={id("title")}>
            {FIELD_LABELS.title}
          </label>
          <input
            ref={titleRef}
            id={id("title")}
            type="text"
            className="ccc-text-input"
            value={values.title}
            onInput={(event) => set("title", event.currentTarget.value)}
          />
        </div>
        <div className="ccc-task-field" data-wide="true">
          <label className="ccc-field-label" htmlFor={id("description")}>
            {FIELD_LABELS.description}
          </label>
          <textarea
            id={id("description")}
            className="ccc-text-input"
            rows={4}
            value={values.description}
            onInput={(event) => set("description", event.currentTarget.value)}
          />
        </div>
        <div className="ccc-task-field">
          <label className="ccc-field-label" htmlFor={id("priority")}>
            {FIELD_LABELS.priority}
          </label>
          <select
            id={id("priority")}
            className="ccc-text-input"
            value={values.priority}
            onChange={(event) => set("priority", event.currentTarget.value as TaskPriority | "")}
          >
            <option value="">{TASK_PRIORITY_DISPLAY.none.label}</option>
            {PRIORITY_ORDER.map((priority) => (
              <option key={priority} value={priority}>
                {TASK_PRIORITY_DISPLAY[priority].label}
              </option>
            ))}
          </select>
        </div>
        <div className="ccc-task-field">
          <label className="ccc-field-label" htmlFor={id("due")}>
            {FIELD_LABELS.due}
          </label>
          <input
            id={id("due")}
            type="date"
            className="ccc-text-input"
            value={values.due}
            onInput={(event) => set("due", event.currentTarget.value)}
          />
        </div>
        <div className="ccc-task-field">
          <label className="ccc-field-label" htmlFor={id("due-time")}>
            {FIELD_LABELS.dueTime}
          </label>
          <input
            id={id("due-time")}
            type="time"
            className="ccc-text-input"
            value={values.dueTime}
            onInput={(event) => set("dueTime", event.currentTarget.value)}
          />
        </div>
        <div className="ccc-task-field">
          <label className="ccc-field-label" htmlFor={id("scheduled")}>
            {FIELD_LABELS.scheduled}
          </label>
          <input
            id={id("scheduled")}
            type="date"
            className="ccc-text-input"
            value={values.scheduled}
            onInput={(event) => set("scheduled", event.currentTarget.value)}
          />
        </div>
        <div className="ccc-task-field">
          <label className="ccc-field-label" htmlFor={id("project")}>
            {FIELD_LABELS.project}
          </label>
          <select
            id={id("project")}
            className="ccc-text-input"
            value={values.projectId}
            onChange={(event) => set("projectId", event.currentTarget.value)}
          >
            <option value="">{NO_PROJECT_LABEL}</option>
            {props.projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ccc-task-field">
          <label className="ccc-field-label" htmlFor={id("scope")}>
            {FIELD_LABELS.scope}
          </label>
          <select
            id={id("scope")}
            className="ccc-text-input"
            value={values.scope}
            onChange={(event) => set("scope", event.currentTarget.value)}
          >
            <option value="global">{GLOBAL_SCOPE_LABEL}</option>
            {props.workspaces.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ccc-task-field" data-wide="true">
          <label className="ccc-field-label" htmlFor={id("tags")}>
            {FIELD_LABELS.tags}
          </label>
          <input
            id={id("tags")}
            type="text"
            className="ccc-text-input"
            aria-describedby={id("tags-help")}
            value={values.tags}
            onInput={(event) => set("tags", event.currentTarget.value)}
          />
          <p className="ccc-field-help" id={id("tags-help")}>
            {TAGS_HELP}
          </p>
        </div>
      </div>
      <div className="ccc-task-form-actions">
        <button
          type="submit"
          className="ccc-connect-button"
          data-variant="primary"
          aria-busy={busyAria}
          aria-disabled={busyAria}
        >
          {ADD_TO_INBOX_LABEL}
        </button>
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          aria-busy={busyAria}
          aria-disabled={busyAria}
          onClick={() => void submit("ready")}
        >
          {ADD_AS_READY_LABEL}
        </button>
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="tertiary"
          onClick={() => props.onClose()}
        >
          {CLOSE_FORM_LABEL}
        </button>
      </div>
    </form>
  );
}
