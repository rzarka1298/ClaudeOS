import { ProjectIdSchema } from "@ccc/domain/projects.js";
import { type TaskPriority, TaskTagSchema, TaskTitleSchema } from "@ccc/domain/task-schema.js";
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
  createFailedMessage,
  DISCONNECTED_REASON,
  FIELD_LABELS,
  GLOBAL_SCOPE_LABEL,
  INVALID_DATE_MESSAGE,
  NO_PROJECT_LABEL,
  TAG_INVALID_MESSAGE,
  TAG_TOO_LONG_MESSAGE,
  TAGS_HELP,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
  TOO_MANY_TAGS_MESSAGE,
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

export interface TaskFormValues {
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

function initialValues(props: TaskCreateFormProps): TaskFormValues {
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

/** The empty form (no defaults). */
export const EMPTY_FORM_VALUES: TaskFormValues = {
  title: "",
  description: "",
  priority: "",
  due: "",
  dueTime: "",
  scheduled: "",
  projectId: "",
  scope: "global",
  tags: "",
};

/** Whitespace runs that a paste can carry into a one-line title. */
const TITLE_WHITESPACE = /[\t\r\n]+/g;
/** Control, format and separator characters a title may not contain (matches the domain's rule). */
const TITLE_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A title as the owner meant it: newlines and tabs become a single space,
 * control, format and separator characters are removed, and the ends are
 * trimmed (UI-SPEC E9). Pure.
 */
export function cleanTitle(raw: string): string {
  return raw.replace(TITLE_WHITESPACE, " ").replace(TITLE_INVISIBLE, "").trim();
}

/** The title bound of the domain schema (UI-SPEC E9). */
const TITLE_MAX = 200;
const TAG_MAX = 40;
const TAGS_MAX = 20;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in `YYYY-MM-DD` form (February 31st is not one). */
function isCalendarDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

type TagsResult =
  | { readonly tags: string[]; readonly error?: undefined }
  | { readonly tags?: undefined; readonly error: string };

/** Splits on commas, strips one leading `#`, drops empty and repeated tags, applies the length and Obsidian rules. */
function parseTags(raw: string): TagsResult {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim().replace(/^#/, "");
    if (tag === "" || seen.has(tag)) continue;
    if (tag.length > TAG_MAX) return { error: TAG_TOO_LONG_MESSAGE };
    if (!TaskTagSchema.safeParse(tag).success) return { error: TAG_INVALID_MESSAGE };
    seen.add(tag);
    tags.push(tag);
  }
  return tags.length > TAGS_MAX ? { error: TOO_MANY_TAGS_MESSAGE } : { tags };
}

export type TaskFormErrors = Partial<Record<"title" | "due" | "scheduled" | "tags", string>>;

/** The fixed field messages for the values as they stand (UI-SPEC E9). Pure; an empty object means valid. */
export function validateCreateValues(values: TaskFormValues): TaskFormErrors {
  const errors: { -readonly [K in keyof TaskFormErrors]: string } = {};
  const title = cleanTitle(values.title);
  if (title === "") errors.title = TITLE_REQUIRED_MESSAGE;
  else if (title.length > TITLE_MAX) errors.title = TITLE_TOO_LONG_MESSAGE;
  else if (!TaskTitleSchema.safeParse(title).success) errors.title = TITLE_REQUIRED_MESSAGE;
  if (values.due !== "" ? !isCalendarDate(values.due) : values.dueTime !== "") {
    errors.due = INVALID_DATE_MESSAGE;
  }
  if (values.scheduled !== "" && !isCalendarDate(values.scheduled)) {
    errors.scheduled = INVALID_DATE_MESSAGE;
  }
  const tags = parseTags(values.tags);
  if (tags.error !== undefined) errors.tags = tags.error;
  return errors;
}

/** The form field an input belongs to for error purposes. */
const ERROR_FIELD: Readonly<Record<keyof TaskFormValues, keyof TaskFormErrors | null>> = {
  title: "title",
  description: null,
  priority: null,
  due: "due",
  dueTime: "due",
  scheduled: "scheduled",
  projectId: null,
  scope: null,
  tags: "tags",
};

/** Maps validated form values to the domain request; an empty optional field sends nothing. */
function buildRequest(
  values: TaskFormValues,
  intent: TaskCreateIntent,
  zone: string,
): TaskCreateRequest {
  const tags = parseTags(values.tags).tags ?? [];
  const project = ProjectIdSchema.safeParse(values.projectId);
  return {
    title: cleanTitle(values.title),
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
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const focusInvalidRef = useRef(false);
  const [values, setValues] = useState<TaskFormValues>(() => initialValues(props));
  const [errors, setErrors] = useState<TaskFormErrors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // After a failed submit, move focus to the first field that now carries an error.
  useEffect(() => {
    if (!focusInvalidRef.current) return;
    focusInvalidRef.current = false;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  /** Shows or clears one field's message from the values as they stand. */
  const check = (field: keyof TaskFormErrors, next: TaskFormValues): void => {
    const message = validateCreateValues(next)[field];
    setErrors((current) => {
      if (current[field] === message) return current;
      const copy = { ...current };
      if (message === undefined) delete copy[field];
      else copy[field] = message;
      return copy;
    });
  };

  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]): void => {
    const next = { ...values, [key]: value };
    setValues(next);
    // A shown message re-checks as the owner types, so it clears the moment the value is fixed.
    const field = ERROR_FIELD[key];
    if (field !== null && errors[field] !== undefined) check(field, next);
  };

  const close = (): void => {
    props.onClose();
    props.getOpener?.()?.focus();
  };

  const submit = async (intent: TaskCreateIntent): Promise<void> => {
    if (busyRef.current || !props.connected) return;
    const found = validateCreateValues(values);
    if (Object.keys(found).length > 0) {
      focusInvalidRef.current = true;
      setErrors(found);
      return;
    }
    busyRef.current = true;
    props.onStatus(ADDING_STATUS);
    setBusy(true);
    setErrors({});
    const request = buildRequest(values, intent, props.zone);
    try {
      await props.create(request);
      const message = addedMessage(request.title, intent);
      props.onStatus(message);
      props.onNotice(message);
      setValues(initialValues(props));
      titleRef.current?.focus();
    } catch (error) {
      // The typed text stays. Only a fixed reason chosen by error code is shown.
      const message = createFailedMessage(error);
      props.onStatus(message);
      props.onNotice(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onTitlePaste = (event: ClipboardEvent & { currentTarget: HTMLInputElement }): void => {
    const pasted = event.clipboardData?.getData("text") ?? "";
    if (!/[\t\r\n]/.test(pasted)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const text = pasted.replace(TITLE_WHITESPACE, " ");
    input.setRangeText(
      text,
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.value.length,
      "end",
    );
    set("title", input.value);
  };

  const id = (name: string): string => `${uid}-${name}`;
  const busyAria = busy ? "true" : undefined;
  const submitDisabled = busy || !props.connected;
  const reasonId = id("reason");

  /** The aria wiring for a field that may carry a message (and optionally a help line). */
  const described = (field: keyof TaskFormErrors, extra?: string) => {
    const ids = [extra, errors[field] !== undefined ? id(`${field}-error`) : undefined].filter(
      (value): value is string => value !== undefined,
    );
    return {
      "aria-invalid": errors[field] !== undefined ? ("true" as const) : undefined,
      "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
    };
  };
  const message = (field: keyof TaskFormErrors): VNode | null =>
    errors[field] === undefined ? null : (
      <p className="ccc-field-error" id={id(`${field}-error`)}>
        {errors[field]}
      </p>
    );

  return (
    <form
      ref={formRef}
      className="ccc-task-form"
      data-panel="true"
      aria-label="Create a task"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit("inbox");
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
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
            {...described("title")}
            onInput={(event) => set("title", event.currentTarget.value)}
            onBlur={() => check("title", values)}
            onPaste={onTitlePaste}
          />
          {message("title")}
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
            {...described("due")}
            onInput={(event) => set("due", event.currentTarget.value)}
            onBlur={() => check("due", values)}
          />
          {message("due")}
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
            onBlur={() => check("due", values)}
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
            {...described("scheduled")}
            onInput={(event) => set("scheduled", event.currentTarget.value)}
            onBlur={() => check("scheduled", values)}
          />
          {message("scheduled")}
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
            value={values.tags}
            {...described("tags", id("tags-help"))}
            onInput={(event) => set("tags", event.currentTarget.value)}
            onBlur={() => check("tags", values)}
          />
          <p className="ccc-field-help" id={id("tags-help")}>
            {TAGS_HELP}
          </p>
          {message("tags")}
        </div>
      </div>
      {!props.connected && (
        <p className="ccc-field-help" id={reasonId}>
          {DISCONNECTED_REASON}
        </p>
      )}
      <div className="ccc-task-form-actions">
        <button
          type="submit"
          className="ccc-connect-button"
          data-variant="primary"
          aria-busy={busyAria}
          aria-disabled={submitDisabled ? "true" : undefined}
          aria-describedby={props.connected ? undefined : reasonId}
        >
          {ADD_TO_INBOX_LABEL}
        </button>
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          aria-busy={busyAria}
          aria-disabled={submitDisabled ? "true" : undefined}
          aria-describedby={props.connected ? undefined : reasonId}
          onClick={() => void submit("ready")}
        >
          {ADD_AS_READY_LABEL}
        </button>
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="tertiary"
          onClick={close}
        >
          {CLOSE_FORM_LABEL}
        </button>
      </div>
    </form>
  );
}
