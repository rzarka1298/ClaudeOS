import type { ConfidenceState } from "@ccc/domain/note-schema.js";
import { TASK_STATUSES, type TaskPriority, type TaskStatus } from "@ccc/domain/task-schema.js";
import {
  TASK_PRIORITY_DISPLAY,
  TASK_STATUS_DISPLAY,
  type TaskBlockedByEntry,
} from "@ccc/domain/tasks.js";
import type { Ref, VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  cleanTitle,
  EMPTY_FORM_VALUES,
  type TaskFormErrors,
  type TaskFormOption,
  validateCreateValues,
} from "./task-form.js";
import { blockedLine, DISCONNECTED_REASON, MARK_DONE_LABEL } from "./tasks-copy.js";
import { formatTaskInstant } from "./tasks-format.js";
import {
  ACCEPT_TASK_LABEL,
  AI_GENERATED_BADGE,
  ASSIGNEE_LABELS,
  actionFailedLine,
  actionNotice,
  BLOCKED_NO_DEPENDENCIES,
  CHANGED_OUTSIDE_LINE,
  CONFLICT_LINE,
  confidenceBadge,
  DESCRIPTION_INVALID_MESSAGE,
  DESCRIPTION_TOO_LONG_MESSAGE,
  DETAIL_EMPTY_PROMPT,
  DETAIL_HINT,
  type DetailActionKind,
  DISCARD_CHANGES_LABEL,
  DISMISS_TASK_LABEL,
  dependencyMissing,
  discardPrompt,
  FACT_LABELS,
  FIELD_LABELS,
  INVALID_DATE_MESSAGE,
  KEEP_EDITING_LABEL,
  NO_PROJECT_LABEL,
  NONE_LABEL,
  NOT_PROVIDED_LABEL,
  OPEN_NOTE_LABEL,
  PROJECT_NOT_REGISTERED_LABEL,
  parentMissing,
  providedBy,
  RELOAD_REPLACE_PROMPT,
  RELOAD_TASK_LABEL,
  REOPEN_TASK_LABEL,
  REPLACE_MY_EDITS_LABEL,
  REVERT_CHANGES_LABEL,
  SAVE_CHANGES_LABEL,
  SAVE_REASONS,
  SAVED_STATUS,
  SAVING_STATUS,
  SOURCE_UNTOUCHED_NOTE,
  STATUS_FIELD_LABEL,
  SUGGESTED_BY_UNNAMED,
  SUGGESTIONS_NOTE,
  saveFailedLine,
  suggestedBy,
  TAG_INVALID_MESSAGE,
  TAG_TOO_LONG_MESSAGE,
  TAGS_HELP,
  TASK_ACTIONS_LABEL,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
  TOO_MANY_TAGS_MESSAGE,
  UNSAVED_CHANGES_LABEL,
} from "./tasks-forms-copy.js";

/**
 * The task detail and edit pane (UI-SPEC S3 "Detail and edit pane", "Proposed
 * tasks"; TASK-01, TASK-04, TASK-05, TASK-08; E8, E10). Always a form: the saved
 * task, the project list, the connection fact, the owner's clock and zone and
 * every function arrive as props, so the pane imports no service client,
 * connector, executor, signal or `obsidian` and reads no clock. Its only
 * outward calls are the injected save, action, reload and open-note functions
 * (T-06-24).
 *
 * Every task-supplied string (title, description, tags, the generated-by label,
 * the source link, the scope and project names) renders as a text node or a
 * form control value; a source link is plain monospace text and never an anchor
 * (T-06-25, R-19). A save is always checked against the content the form
 * started from: if the note changed meanwhile the result is a conflict and the
 * pane offers a reload, never a force save (T-06-22, D-35).
 */

/** The saved task as the pane shows it: the note's own values plus the service's read-only facts. */
export interface TaskDetailTask {
  readonly id: string;
  readonly title: string;
  /** The note body, verbatim. */
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority | null;
  /** Local wall-clock values; `time` is an empty string for an all-day due date. */
  readonly due: { readonly date: string; readonly time: string } | null;
  readonly scheduled: string | null;
  readonly projectId: string | null;
  readonly tags: readonly string[];
  /** `Global` or a workspace name. */
  readonly scopeLabel: string;
  readonly parent: { readonly id: string; readonly title: string | null } | null;
  readonly blockedBy: readonly TaskBlockedByEntry[];
  readonly sourceType: string;
  readonly sourceLink: string | null;
  readonly assignee: "user" | "claude" | "automation" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  /** Vault-relative path of the note. Never absolute. */
  readonly path: string;
  readonly aiGenerated: boolean;
  /** The label of whatever generated the task (a skill, an automation or a model), untrusted text. */
  readonly generatedByLabel: string | null;
  readonly confidence: ConfidenceState;
  /** The note's full content when it was read; the base every save is checked against. */
  readonly content: string;
}

/** What the form changed. A key is present only when its field differs from the saved note. */
export interface TaskDetailEdit {
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority | null;
  readonly due?: { readonly date: string; readonly time: string | null } | null;
  readonly scheduled?: { readonly date: string } | null;
  readonly projectId?: string | null;
  readonly tags?: readonly string[];
}

export type TaskDetailAction = DetailActionKind;

export type TaskDetailResult =
  | { readonly kind: "applied" }
  | { readonly kind: "conflict" }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "invalid"; readonly fields: Readonly<Record<string, string>> };

export interface TaskDetailProps {
  readonly task: TaskDetailTask | null;
  readonly projects: readonly TaskFormOption[];
  readonly connected: boolean;
  readonly zone: string;
  readonly nowMs: number;
  readonly onSave: (
    edit: TaskDetailEdit,
    expectedPriorContent: string,
  ) => Promise<TaskDetailResult>;
  readonly onAction: (action: TaskDetailAction) => Promise<TaskDetailResult>;
  readonly onReload: () => Promise<void>;
  readonly onOpenNote: (path: string) => void;
  readonly onSelectTask: (id: string) => void;
  readonly onStatus: (text: string) => void;
  readonly onNotice: (text: string) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** Set by the container when the owner tries to leave while the pane is dirty. */
  readonly leaveRequest?: boolean;
  readonly onLeaveDecision?: (decision: "discard" | "keep") => void;
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

// ---------------------------------------------------------------------------
// Form values

interface DetailValues {
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority | "";
  readonly due: string;
  readonly dueTime: string;
  readonly scheduled: string;
  readonly projectId: string;
  readonly tags: string;
}

function valuesOf(task: TaskDetailTask): DetailValues {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority ?? "",
    due: task.due?.date ?? "",
    dueTime: task.due?.time ?? "",
    scheduled: task.scheduled ?? "",
    projectId: task.projectId ?? "",
    tags: task.tags.join(", "),
  };
}

/** Comma-separated tags as a trimmed, de-duplicated list (a leading `#` is not part of a tag). */
function splitTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim().replace(/^#/, "");
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function sameValues(a: DetailValues, b: DetailValues): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.due === b.due &&
    a.dueTime === b.dueTime &&
    a.scheduled === b.scheduled &&
    a.projectId === b.projectId &&
    splitTags(a.tags).join("\n") === splitTags(b.tags).join("\n")
  );
}

/** The fields that differ from the saved note; an untouched field is absent. */
function buildEdit(values: DetailValues, base: DetailValues): TaskDetailEdit {
  const edit: { -readonly [K in keyof TaskDetailEdit]: TaskDetailEdit[K] } = {};
  if (values.title !== base.title) edit.title = cleanTitle(values.title);
  if (values.description !== base.description) edit.description = values.description;
  if (values.status !== base.status) edit.status = values.status;
  if (values.priority !== base.priority) {
    edit.priority = values.priority === "" ? null : values.priority;
  }
  if (values.due !== base.due || values.dueTime !== base.dueTime) {
    edit.due =
      values.due === ""
        ? null
        : { date: values.due, time: values.dueTime === "" ? null : values.dueTime };
  }
  if (values.scheduled !== base.scheduled) {
    edit.scheduled = values.scheduled === "" ? null : { date: values.scheduled };
  }
  if (values.projectId !== base.projectId) {
    edit.projectId = values.projectId === "" ? null : values.projectId;
  }
  if (splitTags(values.tags).join("\n") !== splitTags(base.tags).join("\n")) {
    edit.tags = splitTags(values.tags);
  }
  return edit;
}

/**
 * The field messages for the values, limited to fields the owner changed: a value the note already
 * held (an over-long title, say) never blocks saving some other field.
 */
function validate(values: DetailValues, base: DetailValues): TaskFormErrors {
  const found = validateCreateValues({
    ...EMPTY_FORM_VALUES,
    title: values.title,
    description: values.description,
    due: values.due,
    dueTime: values.dueTime,
    scheduled: values.scheduled,
    tags: values.tags,
  });
  const changed: Readonly<Record<keyof TaskFormErrors, boolean>> = {
    title: values.title !== base.title,
    description: values.description !== base.description,
    due: values.due !== base.due || values.dueTime !== base.dueTime,
    scheduled: values.scheduled !== base.scheduled,
    tags: splitTags(values.tags).join("\n") !== splitTags(base.tags).join("\n"),
  };
  const kept: { -readonly [K in keyof TaskFormErrors]: string } = {};
  for (const key of Object.keys(found) as (keyof TaskFormErrors)[]) {
    const message = found[key];
    if (changed[key] && message !== undefined) kept[key] = message;
  }
  return kept;
}

const ERROR_FIELD: Readonly<Record<keyof DetailValues, keyof TaskFormErrors | null>> = {
  title: "title",
  description: "description",
  status: null,
  priority: null,
  due: "due",
  dueTime: "due",
  scheduled: "scheduled",
  projectId: null,
  tags: "tags",
};

/** Field codes from a rejected save (06-18) mapped to the fixed messages; unmapped codes yield nothing. */
function serviceErrors(fields: Readonly<Record<string, string>>): TaskFormErrors {
  const errors: { -readonly [K in keyof TaskFormErrors]: string } = {};
  if (fields.title === "required") errors.title = TITLE_REQUIRED_MESSAGE;
  else if (fields.title === "too-long") errors.title = TITLE_TOO_LONG_MESSAGE;
  else if (fields.title !== undefined) errors.title = TITLE_REQUIRED_MESSAGE;
  if (fields.description === "too-long") errors.description = DESCRIPTION_TOO_LONG_MESSAGE;
  else if (fields.description !== undefined) errors.description = DESCRIPTION_INVALID_MESSAGE;
  if (fields.due !== undefined) errors.due = INVALID_DATE_MESSAGE;
  if (fields.scheduled !== undefined) errors.scheduled = INVALID_DATE_MESSAGE;
  if (fields.tags === "too-many-tags") errors.tags = TOO_MANY_TAGS_MESSAGE;
  else if (fields.tags === "too-long") errors.tags = TAG_TOO_LONG_MESSAGE;
  else if (fields.tags !== undefined) errors.tags = TAG_INVALID_MESSAGE;
  return errors;
}

/** The fixed reason a non-applied result gives (UI-SPEC "Saving"). */
function reasonFor(result: Exclude<TaskDetailResult, { kind: "applied" }>): string {
  switch (result.kind) {
    case "conflict":
      return SAVE_REASONS.changed;
    case "missing":
      return SAVE_REASONS.missing;
    default:
      return SAVE_REASONS.unreadable;
  }
}

type Outcome = { readonly kind: "conflict" } | { readonly kind: "failure"; readonly line: string };
type Busy = "save" | "reload" | DetailActionKind | null;

const OPEN_STATUSES: readonly TaskStatus[] = ["inbox", "ready", "in-progress", "blocked"];
const PRIORITY_ORDER: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];

// ---------------------------------------------------------------------------
// The pane

export function TaskDetail(props: TaskDetailProps): VNode {
  const { task } = props;
  if (task === null) return <p className="ccc-state-body">{DETAIL_EMPTY_PROMPT}</p>;
  // Keyed by the task: another selection is a fresh form, so an in-flight result of the old one
  // can never land on it.
  return <TaskDetailForm key={task.id} {...props} task={task} />;
}

type FormProps = TaskDetailProps & { readonly task: TaskDetailTask };

function TaskDetailForm(props: FormProps): VNode {
  const { task, connected } = props;
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const reloadKeepRef = useRef<HTMLButtonElement>(null);
  const initial = valuesOf(task);
  const [base, setBase] = useState(() => ({
    taskId: task.id,
    values: initial,
    content: task.content,
  }));
  const [values, setValues] = useState<DetailValues>(initial);
  const [errors, setErrors] = useState<TaskFormErrors>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [changedOutside, setChangedOutside] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [reloadPrompt, setReloadPrompt] = useState(false);

  // Refs hold the latest values so an effect or an async continuation never reads a stale closure.
  const baseRef = useRef(base);
  const valuesRef = useRef(values);
  const taskRef = useRef(task);
  const busyRef = useRef(false);
  const reloadRequested = useRef(false);
  const savedRef = useRef(false);
  const focusInvalidRef = useRef(false);
  const mountedRef = useRef(true);
  const dirtyCallbackRef = useRef(props.onDirtyChange);
  const wasConfirmOpenRef = useRef(false);
  dirtyCallbackRef.current = props.onDirtyChange;
  baseRef.current = base;
  valuesRef.current = values;
  taskRef.current = task;

  const dirty = !sameValues(values, base.values);

  /** Makes `next` the saved task: the form values, the base content and every message follow it. */
  const sync = (next: TaskDetailTask): void => {
    const nextBase = { taskId: next.id, values: valuesOf(next), content: next.content };
    baseRef.current = nextBase;
    valuesRef.current = nextBase.values;
    setBase(nextBase);
    setValues(nextBase.values);
    setErrors({});
    setOutcome(null);
    setChangedOutside(false);
    setReloadPrompt(false);
  };

  /** Puts focus back on the first field, for when a confirmation that held it closes. */
  const focusForm = (): void => {
    formRef.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  };

  const differsFromBase = (next: TaskDetailTask): boolean =>
    next.content !== baseRef.current.content || !sameValues(valuesOf(next), baseRef.current.values);

  // A new saved task: another selection starts over; a change to the same task follows a clean form
  // and warns a dirty one (the form keeps its edits and its original base content).
  useEffect(() => {
    if (task.id !== baseRef.current.taskId) {
      sync(task);
      return;
    }
    if (!differsFromBase(task)) return;
    const dirtyNow = !sameValues(valuesRef.current, baseRef.current.values);
    if (!dirtyNow || reloadRequested.current || savedRef.current) {
      savedRef.current = false;
      sync(task);
      return;
    }
    setChangedOutside(true);
  }, [task]);

  // After Reload task resolves, show the latest saved task whatever the form held.
  useEffect(() => {
    if (reloadTick === 0) return;
    reloadRequested.current = false;
    sync(taskRef.current);
  }, [reloadTick]);

  useEffect(() => {
    props.onDirtyChange?.(dirty);
  }, [dirty]);

  // Leaving the pane (another task, no task) must not leave the container believing it is dirty.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dirtyCallbackRef.current?.(false);
    };
  }, []);

  const confirmOpen = props.leaveRequest === true && dirty;
  useEffect(() => {
    if (props.leaveRequest === true && !dirty) props.onLeaveDecision?.("discard");
  }, [props.leaveRequest, dirty]);
  useEffect(() => {
    if (confirmOpen) keepRef.current?.focus();
    else if (wasConfirmOpenRef.current) focusForm();
    wasConfirmOpenRef.current = confirmOpen;
  }, [confirmOpen]);

  // The reload confirmation is only meaningful while there is something to replace.
  const reloadConfirmOpen = reloadPrompt && dirty && !confirmOpen;
  useEffect(() => {
    if (reloadConfirmOpen) reloadKeepRef.current?.focus();
  }, [reloadConfirmOpen]);

  // After a failed save check, move focus to the first field that now carries an error.
  useEffect(() => {
    if (!focusInvalidRef.current) return;
    focusInvalidRef.current = false;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  const check = (field: keyof TaskFormErrors, next: DetailValues): void => {
    const message = validate(next, baseRef.current.values)[field];
    setErrors((current) => {
      if (current[field] === message) return current;
      const copy = { ...current };
      if (message === undefined) delete copy[field];
      else copy[field] = message;
      return copy;
    });
  };

  const set = <K extends keyof DetailValues>(key: K, value: DetailValues[K]): void => {
    const next = { ...valuesRef.current, [key]: value };
    valuesRef.current = next;
    setValues(next);
    const field = ERROR_FIELD[key];
    if (field !== null && errors[field] !== undefined) check(field, next);
  };

  const revert = (): void => {
    if (busyRef.current || !dirty) return;
    valuesRef.current = baseRef.current.values;
    setValues(baseRef.current.values);
    setErrors({});
    setReloadPrompt(false);
  };

  const save = async (): Promise<void> => {
    if (busyRef.current || !connected || !dirty) return;
    const found = validate(valuesRef.current, baseRef.current.values);
    if (Object.keys(found).length > 0) {
      focusInvalidRef.current = true;
      setErrors(found);
      return;
    }
    const edit = buildEdit(valuesRef.current, baseRef.current.values);
    const expected = baseRef.current.content;
    const startedOn = baseRef.current.taskId;
    busyRef.current = true;
    setBusy("save");
    setOutcome(null);
    props.onStatus(SAVING_STATUS);
    let result: TaskDetailResult;
    try {
      result = await props.onSave(edit, expected);
    } catch {
      result = { kind: "unreadable" };
    }
    if (!mountedRef.current || taskRef.current.id !== startedOn) {
      // Another task is showing now; only the truthful "Saved." may still be announced.
      if (result.kind === "applied") props.onStatus(SAVED_STATUS);
      return;
    }
    busyRef.current = false;
    setBusy(null);
    if (result.kind === "applied") {
      setErrors({});
      props.onStatus(SAVED_STATUS);
      savedRef.current = true;
      if (differsFromBase(taskRef.current)) {
        savedRef.current = false;
        sync(taskRef.current);
      }
      return;
    }
    if (result.kind === "conflict") {
      setOutcome({ kind: "conflict" });
      props.onStatus(CONFLICT_LINE);
      return;
    }
    if (result.kind === "invalid") {
      const mapped = serviceErrors(result.fields);
      if (Object.keys(mapped).length > 0) {
        focusInvalidRef.current = true;
        setErrors(mapped);
        return;
      }
    }
    const line = saveFailedLine(reasonFor(result));
    setOutcome({ kind: "failure", line });
    props.onStatus(line);
  };

  const act = async (action: DetailActionKind): Promise<void> => {
    if (busyRef.current || !connected) return;
    const title = taskRef.current.title;
    busyRef.current = true;
    setBusy(action);
    let result: TaskDetailResult;
    try {
      result = await props.onAction(action);
    } catch {
      result = { kind: "unreadable" };
    }
    busyRef.current = false;
    if (mountedRef.current) setBusy(null);
    const line =
      result.kind === "applied"
        ? actionNotice(action, title)
        : actionFailedLine(action, reasonFor(result));
    props.onStatus(line);
    props.onNotice(line);
  };

  const reload = async (): Promise<void> => {
    if (busyRef.current || !connected) return;
    busyRef.current = true;
    reloadRequested.current = true;
    setReloadPrompt(false);
    setBusy("reload");
    let reloaded = false;
    try {
      await props.onReload();
      reloaded = true;
    } catch {
      // The form keeps its edits and the conflict line stays, so the owner can try again.
    }
    busyRef.current = false;
    if (!mountedRef.current) return;
    setBusy(null);
    if (reloaded) setReloadTick((tick) => tick + 1);
    else reloadRequested.current = false;
  };

  /** Reload task: over unsaved edits it first asks before replacing them. */
  const requestReload = (): void => {
    if (busyRef.current || !connected) return;
    if (!sameValues(valuesRef.current, baseRef.current.values)) {
      setReloadPrompt(true);
      return;
    }
    void reload();
  };

  const keepReloadOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    keepEditingAfterReloadPrompt();
  };

  const keepEditingAfterReloadPrompt = (): void => {
    setReloadPrompt(false);
    focusForm();
  };

  /** Escape on either confirmation button equals Keep editing. */
  const keepOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onLeaveDecision?.("keep");
  };

  // ---- rendering helpers ----------------------------------------------------

  const id = (name: string): string => `${uid}-${name}`;
  const reasonId = id("reason");
  const serviceAria = (extra = false): Record<string, string | undefined> => ({
    "aria-disabled": !connected || busy !== null || extra ? "true" : undefined,
    "aria-describedby": connected ? undefined : reasonId,
  });
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

  const isSuggested =
    task.status === "proposed" || task.assignee === "automation" || task.generatedByLabel !== null;
  const label = task.generatedByLabel;
  const unmet = task.blockedBy.length;
  const projectListed = props.projects.some((option) => option.id === values.projectId);

  const descriptionField = (
    <>
      <label className="ccc-field-label" htmlFor={id("description")}>
        {FIELD_LABELS.description}
      </label>
      <textarea
        id={id("description")}
        className="ccc-text-input"
        rows={4}
        value={values.description}
        {...described("description")}
        onInput={(event) => set("description", event.currentTarget.value)}
        onBlur={() => check("description", valuesRef.current)}
      />
      {message("description")}
    </>
  );

  const dependencyList =
    unmet > 0 ? (
      <ul className="ccc-task-dependencies">
        {task.blockedBy.map((entry) => (
          <li key={entry.id}>
            {entry.resolved ? (
              <button
                type="button"
                className="ccc-task-dependency"
                onClick={() => props.onSelectTask(entry.id)}
              >
                {entry.title} {TASK_STATUS_DISPLAY[entry.status].glyph}{" "}
                {TASK_STATUS_DISPLAY[entry.status].label}
              </button>
            ) : (
              <span className="ccc-text-input--mono">{dependencyMissing(entry.id)}</span>
            )}
          </li>
        ))}
      </ul>
    ) : task.status === "blocked" ? (
      BLOCKED_NO_DEPENDENCIES
    ) : (
      NONE_LABEL
    );

  const status = TASK_STATUS_DISPLAY[task.status];

  return (
    <section className="ccc-task-detail" aria-label="Task details">
      <h3 {...(props.headingRef === undefined ? {} : { ref: props.headingRef })} tabIndex={-1}>
        {task.title}
      </h3>
      <p className="ccc-task-detail-state">
        <span className="ccc-task-status">
          {status.glyph} {status.label}
        </span>
        {unmet > 0 && <span className="ccc-task-row-blocked">{blockedLine(unmet)}</span>}
      </p>
      {isSuggested && (
        <p className="ccc-task-provenance">
          <span>{label === null ? SUGGESTED_BY_UNNAMED : suggestedBy(label)}</span>
          {task.aiGenerated && <span className="ccc-badge">{AI_GENERATED_BADGE}</span>}
          <span className="ccc-badge">{confidenceBadge(task.confidence)}</span>
        </p>
      )}

      <form
        ref={formRef}
        className="ccc-task-form"
        aria-label="Edit task"
        noValidate
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="ccc-task-form-fields">
          <div className="ccc-task-field" data-wide="true">
            <label className="ccc-field-label" htmlFor={id("title")}>
              {FIELD_LABELS.title}
            </label>
            <input
              id={id("title")}
              type="text"
              className="ccc-text-input"
              value={values.title}
              {...described("title")}
              onInput={(event) => set("title", event.currentTarget.value)}
              onBlur={() => check("title", valuesRef.current)}
            />
            {message("title")}
          </div>
          <div className="ccc-task-field" data-wide="true">
            {isSuggested && label !== null ? (
              <div className="ccc-task-block" data-origin="requester">
                <span className="ccc-task-block-caption">{providedBy(label)}</span>
                {descriptionField}
              </div>
            ) : (
              descriptionField
            )}
          </div>
          <div className="ccc-task-field">
            <label className="ccc-field-label" htmlFor={id("status")}>
              {STATUS_FIELD_LABEL}
            </label>
            <select
              id={id("status")}
              className="ccc-text-input"
              value={values.status}
              onChange={(event) => set("status", event.currentTarget.value as TaskStatus)}
            >
              {TASK_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {TASK_STATUS_DISPLAY[value].label}
                </option>
              ))}
            </select>
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
              {PRIORITY_ORDER.map((value) => (
                <option key={value} value={value}>
                  {TASK_PRIORITY_DISPLAY[value].label}
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
              onBlur={() => check("due", valuesRef.current)}
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
              onBlur={() => check("due", valuesRef.current)}
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
              onBlur={() => check("scheduled", valuesRef.current)}
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
              {values.projectId !== "" && !projectListed && (
                <option value={values.projectId}>{PROJECT_NOT_REGISTERED_LABEL}</option>
              )}
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
              onBlur={() => check("tags", valuesRef.current)}
            />
            <p className="ccc-field-help" id={id("tags-help")}>
              {TAGS_HELP}
            </p>
            {message("tags")}
          </div>
        </div>
      </form>

      {outcome?.kind === "conflict" && <p className="ccc-task-note">{CONFLICT_LINE}</p>}
      {outcome?.kind === "failure" && <p className="ccc-task-note">{outcome.line}</p>}
      {changedOutside && <p className="ccc-task-dirty">{CHANGED_OUTSIDE_LINE}</p>}
      {(outcome?.kind === "conflict" || changedOutside) &&
        (reloadConfirmOpen ? (
          <div className="ccc-task-confirm">
            <p className="ccc-task-note">{RELOAD_REPLACE_PROMPT}</p>
            <div className="ccc-task-form-actions">
              <button
                type="button"
                className="ccc-connect-button"
                data-variant="secondary"
                onKeyDown={keepReloadOnEscape}
                onClick={() => void reload()}
              >
                {REPLACE_MY_EDITS_LABEL}
              </button>
              <button
                ref={reloadKeepRef}
                type="button"
                className="ccc-connect-button"
                data-variant="primary"
                onKeyDown={keepReloadOnEscape}
                onClick={keepEditingAfterReloadPrompt}
              >
                {KEEP_EDITING_LABEL}
              </button>
            </div>
          </div>
        ) : (
          <div className="ccc-task-form-actions">
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="secondary"
              aria-busy={busy === "reload" ? "true" : undefined}
              {...serviceAria()}
              onClick={requestReload}
            >
              {RELOAD_TASK_LABEL}
            </button>
          </div>
        ))}
      {!connected && (
        <p className="ccc-field-help" id={reasonId}>
          {DISCONNECTED_REASON}
        </p>
      )}

      {confirmOpen ? (
        <div className="ccc-task-confirm">
          <p className="ccc-task-note">{discardPrompt(task.title)}</p>
          <div className="ccc-task-form-actions">
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="secondary"
              onKeyDown={keepOnEscape}
              onClick={() => props.onLeaveDecision?.("discard")}
            >
              {DISCARD_CHANGES_LABEL}
            </button>
            <button
              ref={keepRef}
              type="button"
              className="ccc-connect-button"
              data-variant="primary"
              onKeyDown={keepOnEscape}
              onClick={() => props.onLeaveDecision?.("keep")}
            >
              {KEEP_EDITING_LABEL}
            </button>
          </div>
        </div>
      ) : (
        <>
          {dirty && <p className="ccc-task-dirty">{UNSAVED_CHANGES_LABEL}</p>}
          {/* biome-ignore lint/a11y/useSemanticElements: UI-SPEC S3 specifies `role="group"` with aria-label "Task actions"; a `<fieldset>` is form-associated and brings native legend styling a row of pills does not want. */}
          <div className="ccc-task-form-actions" role="group" aria-label={TASK_ACTIONS_LABEL}>
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="primary"
              aria-busy={busy === "save" ? "true" : undefined}
              {...serviceAria(!dirty)}
              onClick={() => void save()}
            >
              {SAVE_CHANGES_LABEL}
            </button>
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="tertiary"
              aria-disabled={!dirty || busy !== null ? "true" : undefined}
              onClick={revert}
            >
              {REVERT_CHANGES_LABEL}
            </button>
            {OPEN_STATUSES.includes(task.status) && (
              <button
                type="button"
                className="ccc-connect-button"
                data-variant="secondary"
                aria-busy={busy === "mark-done" ? "true" : undefined}
                {...serviceAria()}
                onClick={() => void act("mark-done")}
              >
                {MARK_DONE_LABEL}
              </button>
            )}
            {(task.status === "done" || task.status === "cancelled") && (
              <button
                type="button"
                className="ccc-connect-button"
                data-variant="secondary"
                aria-busy={busy === "reopen" ? "true" : undefined}
                {...serviceAria()}
                onClick={() => void act("reopen")}
              >
                {REOPEN_TASK_LABEL}
              </button>
            )}
            {task.status === "proposed" && (
              <>
                <button
                  type="button"
                  className="ccc-connect-button"
                  data-variant="secondary"
                  aria-busy={busy === "accept" ? "true" : undefined}
                  {...serviceAria()}
                  onClick={() => void act("accept")}
                >
                  {ACCEPT_TASK_LABEL}
                </button>
                <button
                  type="button"
                  className="ccc-connect-button"
                  data-variant="secondary"
                  aria-busy={busy === "dismiss" ? "true" : undefined}
                  {...serviceAria()}
                  onClick={() => void act("dismiss")}
                >
                  {DISMISS_TASK_LABEL}
                </button>
              </>
            )}
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="tertiary"
              onClick={() => props.onOpenNote(task.path)}
            >
              {OPEN_NOTE_LABEL}
            </button>
          </div>
        </>
      )}
      {task.status === "proposed" && <p className="ccc-task-note">{SUGGESTIONS_NOTE}</p>}
      {task.sourceType !== "manual" && OPEN_STATUSES.includes(task.status) && (
        <p className="ccc-task-note">{SOURCE_UNTOUCHED_NOTE}</p>
      )}

      <dl className="ccc-detail-fields">
        <dt>{FACT_LABELS.scope}</dt>
        <dd>{task.scopeLabel}</dd>
        <dt>{FACT_LABELS.parent}</dt>
        <dd>
          {task.parent === null ? (
            NONE_LABEL
          ) : (
            <button
              type="button"
              className="ccc-task-dependency"
              onClick={() => props.onSelectTask(task.parent?.id ?? "")}
            >
              {task.parent.title ?? parentMissing(task.parent.id)}
            </button>
          )}
        </dd>
        <dt>{FACT_LABELS.blockedBy}</dt>
        <dd>{dependencyList}</dd>
        <dt>{FACT_LABELS.source}</dt>
        <dd>
          <div>{task.sourceType}</div>
          {task.sourceLink !== null && (
            <div className="ccc-text-input--mono">{task.sourceLink}</div>
          )}
        </dd>
        <dt>{FACT_LABELS.assignee}</dt>
        <dd>{task.assignee === null ? NOT_PROVIDED_LABEL : ASSIGNEE_LABELS[task.assignee]}</dd>
        <dt>{FACT_LABELS.created}</dt>
        <dd>{formatTaskInstant(task.createdAt, props.nowMs, props.zone)}</dd>
        <dt>{FACT_LABELS.updated}</dt>
        <dd>{formatTaskInstant(task.updatedAt, props.nowMs, props.zone)}</dd>
        <dt>{FACT_LABELS.completed}</dt>
        <dd>
          {task.completedAt === null
            ? NONE_LABEL
            : formatTaskInstant(task.completedAt, props.nowMs, props.zone)}
        </dd>
        <dt>{FACT_LABELS.taskId}</dt>
        <dd className="ccc-text-input--mono">{task.id}</dd>
        <dt>{FACT_LABELS.note}</dt>
        <dd className="ccc-text-input--mono">{task.path}</dd>
      </dl>
      <p className="ccc-task-note">{DETAIL_HINT}</p>
    </section>
  );
}
