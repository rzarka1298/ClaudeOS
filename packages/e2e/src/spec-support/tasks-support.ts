import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOTE_ID_PATTERN, taskSlug } from "@ccc/domain";
import {
  type AuthenticatedSocketApiClient,
  createAuthenticatedClient,
  createTasksClient,
  type TasksClient,
} from "@ccc/service-api-client";
import { type DriverBrowser, parseCountInWords, pollUntil, runPluginCommand } from "../driver.js";
import { isStrictlyInside, PLUGIN_ID, realResolve } from "../plugin-data.js";
import { installResultRecorder, type MochaTestLike } from "../results.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../spec-context.js";
import { TASKS_CLASSES, TASKS_TEXT } from "./tasks-copy.js";

/**
 * Support for the tasks specs (05.2-07, E2E-04, E2E-10): pure checks of raw note bytes, the
 * renderer-side DOM readers and the spec-side start-up helpers. The pure parts are unit-tested;
 * the renderer functions and the helpers that drive Obsidian run only in the live runner (D-15).
 *
 * Every `renderer*` function is SELF-CONTAINED (no imports, no outer variables, no calls to
 * another export) because wdio serialises its body with `toString()` and evaluates it in the
 * Obsidian renderer. Results are plain serialisable data. Waits are conditions (`pollUntil`).
 */

// ---------------------------------------------------------------------------
// Note bytes (pure)

export type FrontmatterParse =
  | { ok: true; entries: Array<[string, string]>; map: Record<string, string> }
  | { ok: false; reason: "no-opening" | "unterminated" };

const SCALAR_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

/**
 * Reads the leading frontmatter block of a note into key and value pairs, in file order. Only
 * lines at column zero count (indented and list lines belong to a block key and are skipped); a
 * block key such as `tags:` keeps an empty value. Quotes in a value are preserved as written.
 */
export function parseNoteFrontmatter(text: string): FrontmatterParse {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[0] !== "---") return { ok: false, reason: "no-opening" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { ok: false, reason: "unterminated" };
  const entries: Array<[string, string]> = [];
  const map: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = SCALAR_LINE.exec(line);
    if (match?.[1] === undefined) continue;
    const value = (match[2] ?? "").trimEnd();
    entries.push([match[1], value]);
    map[match[1]] = value;
  }
  return { ok: true, entries, map };
}

function unquote(value: string | undefined): string {
  if (value === undefined) return "";
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

export type CreatedNoteCode =
  | "not-a-note"
  | "id-invalid"
  | "type-not-task"
  | "status-mismatch"
  | "created-missing"
  | "updated-missing"
  | "title-not-in-file-name";

export type CreatedNoteVerdict = { ok: true } | { ok: false; code: CreatedNoteCode };

/**
 * Checks a note the Create a task form wrote (test 14): a 25-character id from the id alphabet,
 * `type: task`, the chosen status, created and updated stamps, and the typed title in the file
 * name (the file name carries the title's slug, then the last eight characters of the id).
 */
export function checkCreatedNote(
  text: string,
  fileName: string,
  expected: { status: "inbox" | "ready"; title: string },
): CreatedNoteVerdict {
  const parsed = parseNoteFrontmatter(text);
  if (!parsed.ok) return { ok: false, code: "not-a-note" };
  const { map } = parsed;
  if (unquote(map["type"]) !== "task") return { ok: false, code: "type-not-task" };
  if (!NOTE_ID_PATTERN.test(unquote(map["id"]))) return { ok: false, code: "id-invalid" };
  if (unquote(map["status"]) !== expected.status) return { ok: false, code: "status-mismatch" };
  if (unquote(map["created"]) === "") return { ok: false, code: "created-missing" };
  if (unquote(map["updated"]) === "") return { ok: false, code: "updated-missing" };
  if (!fileName.startsWith(`${taskSlug(expected.title)}-`)) {
    return { ok: false, code: "title-not-in-file-name" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The sandbox vault copy (spec side)

/** The folders that hold task notes, relative to a vault. */
const TASK_FOLDERS_GLOBAL = join("global", "tasks");

export interface NoteFile {
  /** Vault-relative path with forward slashes. */
  readonly path: string;
  readonly name: string;
  readonly text: string;
}

/** Throws unless the vault the renderer opened is strictly inside this run's root. */
export function assertVaultInsideRunRoot(vaultPath: string, runRoot: string): void {
  if (vaultPath === "" || !isStrictlyInside(realResolve(runRoot), realResolve(vaultPath))) {
    throw new Error("Refusing a vault that is not inside the run root.");
  }
}

function taskNoteNames(folder: string): string[] {
  try {
    return readdirSync(folder).filter((name) => name.endsWith(".md") && name !== "index.md");
  } catch {
    return [];
  }
}

/**
 * Reads every task note of the global scope from the sandbox vault. Only `.md` files directly in
 * `global/tasks` are read, and only after the vault has been checked against the run root.
 */
export function readGlobalTaskNotes(vaultPath: string, runRoot: string): NoteFile[] {
  assertVaultInsideRunRoot(vaultPath, runRoot);
  const folder = join(vaultPath, TASK_FOLDERS_GLOBAL);
  return taskNoteNames(folder).map((name) => ({
    path: `global/tasks/${name}`,
    name,
    text: readFileSync(join(folder, name), "utf8"),
  }));
}

/** The notes whose file name starts with the slug of `title`. */
export function notesForTitle(files: readonly NoteFile[], title: string): NoteFile[] {
  const prefix = `${taskSlug(title)}-`;
  return files.filter((file) => file.name.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Status change, decisions, dates, duplicates (pure)

export type StatusDiffCode =
  | "not-a-note"
  | "status-unchanged"
  | "status-wrong"
  | "due-missing"
  | "due-quoted"
  | "due-changed"
  | "completed-missing"
  | "updated-unchanged"
  | "extra-change";
export type StatusDiffVerdict = { ok: true } | { ok: false; code: StatusDiffCode };

/** The keys a status change is allowed to touch. */
const STATUS_CHANGE_KEYS: ReadonlySet<string> = new Set(["status", "updated", "completed"]);

function noteLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function keyOfLine(line: string): string | null {
  return /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)?.[1] ?? null;
}

/**
 * Checks the raw diff of a status change made by the plugin (test 15, U-6): the status moved to
 * the expected value, `updated` moved, `completed` is set when done is expected, the `due` line
 * is byte-identical and unquoted, and every other line of the note is unchanged.
 */
export function checkStatusChangeDiff(
  before: string,
  after: string,
  options: { expectStatus: string },
): StatusDiffVerdict {
  const was = parseNoteFrontmatter(before);
  const now = parseNoteFrontmatter(after);
  if (!was.ok || !now.ok) return { ok: false, code: "not-a-note" };
  const statusAfter = unquote(now.map["status"]);
  if (unquote(was.map["status"]) === statusAfter) return { ok: false, code: "status-unchanged" };
  if (statusAfter !== options.expectStatus) return { ok: false, code: "status-wrong" };

  const dueBefore = noteLines(before).find((line) => keyOfLine(line) === "due");
  const dueAfter = noteLines(after).find((line) => keyOfLine(line) === "due");
  if (dueBefore === undefined) return { ok: false, code: "due-missing" };
  if (dueAfter !== undefined && /^due:[ \t]*["']/.test(dueAfter)) {
    return { ok: false, code: "due-quoted" };
  }
  if (dueAfter !== dueBefore) return { ok: false, code: "due-changed" };

  if (options.expectStatus === "done") {
    const completed = now.map["completed"];
    if (completed === undefined || completed === "" || completed === was.map["completed"]) {
      return { ok: false, code: "completed-missing" };
    }
  }
  const updated = now.map["updated"];
  if (updated === undefined || updated === was.map["updated"]) {
    return { ok: false, code: "updated-unchanged" };
  }

  const rest = (text: string): string =>
    noteLines(text)
      .filter((line) => !STATUS_CHANGE_KEYS.has(keyOfLine(line) ?? ""))
      .join("\n");
  if (rest(before) !== rest(after)) return { ok: false, code: "extra-change" };
  return { ok: true };
}

/** The outcome of the nested `decision` map of a note, or null when none is recorded. */
export function readDecisionOutcome(text: string): "accepted" | "dismissed" | null {
  const parsed = parseNoteFrontmatter(text);
  if (!parsed.ok) return null;
  const lines = noteLines(text);
  const start = lines.findIndex((line) => /^decision:[ \t]*$/.test(line));
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (!/^[ \t]/.test(line)) break;
    const outcome = /^[ \t]+outcome:[ \t]*(accepted|dismissed)[ \t]*$/.exec(line)?.[1];
    if (outcome === "accepted" || outcome === "dismissed") return outcome;
  }
  return null;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rewrites the `due` line to an unquoted date and leaves every other byte alone. The fixture
 * vault is generated against a fixed clock, so a spec re-dates a note to the machine's today
 * before it asserts what Today shows; writing the line directly keeps the unquoted form.
 */
export function redateDueLine(text: string, date: string): string {
  if (!PLAIN_DATE.test(date)) throw new Error("A due date must be a plain YYYY-MM-DD date.");
  if (!/^due:/m.test(text)) throw new Error("The note has no due line to re-date.");
  return text.replace(/^due:[^\r\n]*/m, `due: ${date}`);
}

/** `YYYY-MM-DD` of an instant in a named IANA zone. */
export function localDateIn(zone: string, ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** A calendar date moved by whole days. */
export function shiftLocalDate(date: string, days: number): string {
  if (!PLAIN_DATE.test(date)) throw new Error("A date must be a plain YYYY-MM-DD date.");
  const moved = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return moved.toISOString().slice(0, 10);
}

/**
 * True only when the original and its copy both sit under Notes need attention (the title is
 * listed twice) and the task appears in no list.
 */
export function classifyDuplicateAttention(
  attentionTitles: readonly string[],
  originalTitle: string,
  listTitles: readonly string[] = [],
): boolean {
  const held = attentionTitles.filter((title) => title === originalTitle).length;
  return held >= 2 && !listTitles.includes(originalTitle);
}

/** True when the task is in neither the Today nor the Upcoming list. */
export function notInEitherList(
  today: readonly string[],
  upcoming: readonly string[],
  title: string,
): boolean {
  return !today.includes(title) && !upcoming.includes(title);
}

/** What the renderer found when it looked for markup made from untrusted text. */
export interface UntrustedCounts {
  scripts: number;
  anchors: number;
  titleElements: number;
  linkTextElements?: number;
}
export type UntrustedVerdict =
  | { ok: true }
  | {
      ok: false;
      code: "script-created" | "link-clickable" | "text-not-shown" | "link-text-not-shown";
    };

/** Plain-text rendering holds when nothing was created from the text and it is shown as text. */
export function untrustedRenderVerdict(
  counts: UntrustedCounts,
  options: { requireLinkText?: boolean } = {},
): UntrustedVerdict {
  if (counts.scripts > 0) return { ok: false, code: "script-created" };
  if (counts.anchors > 0) return { ok: false, code: "link-clickable" };
  if (counts.titleElements < 1) return { ok: false, code: "text-not-shown" };
  if (options.requireLinkText === true && (counts.linkTextElements ?? 0) < 1) {
    return { ok: false, code: "link-text-not-shown" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Views, movement, long tasks, panel independence (pure) -- typed skeleton

export const TASK_PAGE_LIMIT = 0;
export const MOVE_ALLOWANCE_MS = 0;
export const LONGTASK_BAR_MS = 0;

export type CountsVerdict = { ok: true } | { ok: false; view: string };

export function countsMatchLists(
  _chips: Readonly<Record<string, number | null>>,
  _listLengths: Readonly<Record<string, number>>,
): CountsVerdict {
  throw new Error("not implemented");
}

export function movedWithin(
  _before: Readonly<Record<string, number | null>>,
  _after: Readonly<Record<string, number | null>>,
  _expectedDelta: Readonly<Record<string, number>>,
  _elapsedMs: number,
  _allowanceMs: number,
): boolean {
  throw new Error("not implemented");
}

export interface LongtaskReading {
  supported: boolean;
  entries: Array<{ startTime: number; duration: number }>;
}
export type LongtaskVerdict =
  | { verdict: "pass" }
  | { verdict: "fail"; longestMs: number }
  | { verdict: "inconclusive"; reason: string };

export function evaluateLongtasks(_reading: LongtaskReading, _barMs: number): LongtaskVerdict {
  throw new Error("not implemented");
}

export type InteractionVerdict =
  | { ok: true; slowest: string }
  | { ok: false; slowest: string; slowestMs?: number };

export function measureInteractions(
  _results: ReadonlyArray<{ label: string; ms: number }>,
  _barMs: number,
): InteractionVerdict {
  throw new Error("not implemented");
}

export interface SurfaceSnapshot {
  active: string;
  counts: Readonly<Record<string, number | null>>;
}

export function panelIndependent(
  _globalBefore: SurfaceSnapshot,
  _globalAfter: SurfaceSnapshot,
  _panelBefore: SurfaceSnapshot,
  _panelAfter: SurfaceSnapshot,
): boolean {
  throw new Error("not implemented");
}

export function emptyProjectVerdict(_facts: {
  panelRowIds: readonly string[];
  globalRowIds: readonly string[];
  emptyHeading: string | null;
}): { ok: true } | { ok: false; reason: string } {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Renderer side (self-contained)

interface RElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): RElement | null;
  querySelectorAll(selector: string): ArrayLike<RElement>;
  click(): void;
  dispatchEvent(event: unknown): boolean;
  value?: string;
}

declare const document: {
  querySelector(selector: string): RElement | null;
  querySelectorAll(selector: string): ArrayLike<RElement>;
};

/** What the renderer reports about one tasks surface. */
export interface RenderedTasks {
  mounted: boolean;
  chips: Array<{ filter: string; name: string; pressed: boolean }>;
  rows: Array<{ id: string; title: string; status: string; datePhrase: string | null }>;
  /** The `Showing 25 of 304` line above the list, or null. */
  showing: string | null;
  /** The heading of an empty list, or null. */
  emptyHeading: string | null;
  status: string;
  attention: Array<{ title: string; reason: string; path: string }>;
  attentionHeading: string | null;
  formOpen: boolean;
  disconnected: boolean;
}

/** Selectors and text the reader needs; built from the mirror so the function has no literals. */
export interface ReaderSelectors {
  chip: string;
  row: string;
  rowTitle: string;
  date: string;
  attentionRow: string;
  attentionTitle: string;
  attentionHelp: string;
  attentionPath: string;
  listHeading: string;
  emptyHeading: string;
  attentionHeading: string;
  status: string;
  form: string;
  disconnectedText: string;
}

/** The reader's selectors, assembled from the class-name mirror. */
export function readerSelectors(): ReaderSelectors {
  const c = TASKS_CLASSES;
  return {
    chip: `button.${c.filterChip}`,
    row: `li.${c.taskRow}`,
    rowTitle: `button.${c.taskTitle}`,
    date: `.${c.taskDate}`,
    attentionRow: `li.${c.attentionRow}`,
    attentionTitle: `.${c.attentionTitle}`,
    attentionHelp: `.${c.fieldHelp}`,
    attentionPath: `.${c.attentionPath}`,
    listHeading: `.${c.taskListHeading}`,
    emptyHeading: `.${c.taskListEmpty} .${c.stateHeading}`,
    attentionHeading: `section.${c.attentionSection} h3`,
    status: `.${c.tasksStatus}`,
    form: `form.${c.taskForm}`,
    disconnectedText: TASKS_TEXT.disconnectedReason,
  };
}

/**
 * Clicks the first element matching `selector` whose trimmed text equals `text` (any text when
 * `text` is null). Returns whether something was clicked.
 */
export function rendererClick(_ctx: unknown, selector: string, text: string | null): boolean {
  const found = document.querySelectorAll(selector);
  for (let index = 0; index < found.length; index += 1) {
    const element = found[index];
    if (element === undefined) continue;
    if (text === null || (element.textContent ?? "").trim() === text) {
      element.click();
      return true;
    }
  }
  return false;
}

/**
 * Types `value` into the field of the form at `formSelector` whose label reads `labelText`, with
 * the native setter and an `input` event so the form's own handlers see an ordinary edit.
 */
export function rendererSetInput(
  _ctx: unknown,
  formSelector: string,
  labelText: string,
  value: string,
): boolean {
  const form = document.querySelector(formSelector);
  if (form === null) return false;
  const labels = form.querySelectorAll("label");
  let id: string | null = null;
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    if (label !== undefined && (label.textContent ?? "").trim() === labelText) {
      id = label.getAttribute("for");
      break;
    }
  }
  if (id === null) return false;
  const input = form.querySelector(`[id="${id}"]`);
  if (input === null) return false;
  const proto = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter === undefined) return false;
  setter.call(input, value);
  const EventCtor = (
    globalThis as unknown as { Event: new (type: string, init: object) => unknown }
  ).Event;
  input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  return true;
}

/**
 * Reads one tasks surface: the chips with their accessible names, the rows, the volume line, the
 * attention list and the create form. `rootSelector` picks the global destination or a project
 * panel. Class names and the disconnected sentence arrive as arguments (the function has no
 * outer variables).
 */
export function rendererReadTasks(
  _ctx: unknown,
  rootSelector: string,
  cfg: ReaderSelectors,
): RenderedTasks {
  const root = document.querySelector(rootSelector);
  const empty: RenderedTasks = {
    mounted: false,
    chips: [],
    rows: [],
    showing: null,
    emptyHeading: null,
    status: "",
    attention: [],
    attentionHeading: null,
    formOpen: false,
    disconnected: false,
  };
  if (root === null) return empty;
  const text = (element: RElement | null): string => (element?.textContent ?? "").trim();
  const chips: RenderedTasks["chips"] = [];
  const chipNodes = root.querySelectorAll(cfg.chip);
  for (let index = 0; index < chipNodes.length; index += 1) {
    const chip = chipNodes[index];
    if (chip === undefined) continue;
    chips.push({
      filter: chip.getAttribute("data-filter") ?? "",
      name: chip.getAttribute("aria-label") ?? text(chip),
      pressed: chip.getAttribute("aria-pressed") === "true",
    });
  }
  const rows: RenderedTasks["rows"] = [];
  const rowNodes = root.querySelectorAll(cfg.row);
  for (let index = 0; index < rowNodes.length; index += 1) {
    const row = rowNodes[index];
    if (row === undefined) continue;
    const title = row.querySelector(cfg.rowTitle);
    const date = row.querySelector(cfg.date);
    rows.push({
      id: row.getAttribute("data-task-id") ?? "",
      title: title?.getAttribute("title") ?? text(title),
      status: row.getAttribute("data-status") ?? "",
      datePhrase: date === null ? null : text(date),
    });
  }
  const attention: RenderedTasks["attention"] = [];
  const attentionNodes = root.querySelectorAll(cfg.attentionRow);
  for (let index = 0; index < attentionNodes.length; index += 1) {
    const item = attentionNodes[index];
    if (item === undefined) continue;
    attention.push({
      title: text(item.querySelector(cfg.attentionTitle)),
      reason: text(item.querySelector(cfg.attentionHelp)),
      path: text(item.querySelector(cfg.attentionPath)),
    });
  }
  const heading = root.querySelector(cfg.listHeading);
  const emptyHeading = root.querySelector(cfg.emptyHeading);
  const attentionSection = root.querySelector(cfg.attentionHeading);
  return {
    mounted: true,
    chips,
    rows,
    showing: heading === null ? null : text(heading),
    emptyHeading: emptyHeading === null ? null : text(emptyHeading),
    status: text(root.querySelector(cfg.status)),
    attention,
    attentionHeading: attentionSection === null ? null : text(attentionSection),
    formOpen: root.querySelector(cfg.form) !== null,
    disconnected: (root.textContent ?? "").includes(cfg.disconnectedText),
  };
}

// ---------------------------------------------------------------------------
// Spec-side helpers

/**
 * Looks, inside the surface at `rootSelector`, for anything made from untrusted text: script
 * elements, anchors whose address is on the synthetic host of `linkText`, and elements whose own
 * text is the title or contains the link text (proof the text is shown as text).
 */
export function inspectUntrustedRender(
  _ctx: unknown,
  rootSelector: string,
  title: string,
  linkText: string,
): UntrustedCounts {
  const root = document.querySelector(rootSelector);
  if (root === null) return { scripts: 0, anchors: 0, titleElements: 0, linkTextElements: 0 };
  const host = linkText.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
  const scripts = root.querySelectorAll("script").length;
  let anchors = 0;
  const links = root.querySelectorAll("a[href]");
  for (let index = 0; index < links.length; index += 1) {
    const href = links[index]?.getAttribute("href") ?? "";
    if (host !== "" && href.includes(host)) anchors += 1;
  }
  let titleElements = 0;
  let linkTextElements = 0;
  const everything = root.querySelectorAll("*");
  for (let index = 0; index < everything.length; index += 1) {
    const text = (everything[index]?.textContent ?? "").trim();
    if (text === title) titleElements += 1;
    if (linkText !== "" && text.includes(linkText)) linkTextElements += 1;
  }
  return { scripts, anchors, titleElements, linkTextElements };
}

/** The slice of the wdio-obsidian-service browser the tasks helpers use. */
export interface TasksBrowser extends DriverBrowser {
  executeObsidian<T, A extends unknown[]>(
    fn: (ctx: never, ...args: A) => T | Promise<T>,
    ...args: A
  ): Promise<T>;
}

/** Narrows the wdio browser to the structural slice the helpers use. */
export function asTasksBrowser(browser: unknown): TasksBrowser {
  return browser as TasksBrowser;
}

/** How long the helpers wait for a condition; named so no spec carries a bare number. */
export const WAIT = {
  /** A control or list that should appear at once. */
  short: { timeoutMs: 15_000, intervalMs: 250 },
  /** The service answering and the plugin connecting after a start. */
  connect: { timeoutMs: 90_000, intervalMs: 1_000 },
} as const;

/** The plugin command id as Obsidian registers it. */
export function pluginCommandId(command: string): string {
  return `${PLUGIN_ID}:${command}`;
}

/** The valid tasks `--live-check` adds to the 300 generated ones: one dated, three proposed. */
export const LIVE_CHECK_VALID_TASKS = 4;

/** The selector of the global Tasks destination and of a project panel. */
export const GLOBAL_ROOT = `section.${TASKS_CLASSES.tasksSection}`;
export const PROJECT_ROOT = `section.${TASKS_CLASSES.projectPanel}`;

export async function readTasks(browser: TasksBrowser, root: string): Promise<RenderedTasks> {
  return browser.executeObsidian(rendererReadTasks, root, readerSelectors());
}

/** Parsed chip counts by filter; a chip without a count yet is null. */
export function chipCounts(tasks: RenderedTasks): Record<string, number | null> {
  const counts: Record<string, number | null> = {};
  for (const chip of tasks.chips) counts[chip.filter] = parseCountInWords(chip.name)?.count ?? null;
  return counts;
}

/** The tasks surface of the sandbox run: the context, the service and its typed clients. */
export interface TasksEnvironment {
  readonly context: RunContext;
  readonly client: AuthenticatedSocketApiClient;
  readonly tasks: TasksClient;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Loads the run context, resets and starts a normal-kind throwaway service inside the run root
 * and returns an authenticated client for the sandbox socket. The CLI parent owns the teardown;
 * `stop` is the spec's own tidy-up.
 */
export async function startTasksEnvironment(
  options: { waitAttempts?: number } = {},
): Promise<TasksEnvironment> {
  const context = loadRunContext();
  const fixture = serviceFixtureFor(context);
  await fixture.resetData();
  await fixture.start({
    kind: "normal",
    ...(options.waitAttempts === undefined ? {} : { waitAttempts: options.waitAttempts }),
  });
  const client = createAuthenticatedClient({ socketPath: context.socketPath });
  return {
    context,
    client,
    tasks: createTasksClient(client),
    restart: () => fixture.restart(),
    stop: () => fixture.stop(),
  };
}

/** Wires the result recorder (plan 05.2-05) into the suite's mocha `afterEach`. */
export function recordResults(
  context: RunContext,
  mochaAfterEach: (hook: (this: { currentTest?: MochaTestLike }) => void) => void,
): void {
  installResultRecorder({ afterEach: mochaAfterEach, resultsPath: context.paths.resultsPath });
}

/** Opens the command center on the Tasks destination and waits for it to mount. */
export async function openTasks(browser: TasksBrowser): Promise<void> {
  await runPluginCommand(browser, pluginCommandId(TASKS_TEXT.openOverviewCommand));
  await pollUntil(
    async () => {
      await browser.executeObsidian(
        rendererClick,
        `#${TASKS_CLASSES.tabPrefix}${TASKS_TEXT.tabTasksId}`,
        null,
      );
      return (await readTasks(browser, GLOBAL_ROOT)).mounted;
    },
    { ...WAIT.short, describe: "the Tasks destination to mount" },
  );
}

/** Presses one filter chip of a surface. */
export async function clickChip(
  browser: TasksBrowser,
  root: string,
  filter: string,
): Promise<void> {
  const selector = `${root} button.${TASKS_CLASSES.filterChip}[data-filter="${filter}"]`;
  await pollUntil(() => browser.executeObsidian(rendererClick, selector, null), {
    ...WAIT.short,
    describe: `the ${filter} chip to be pressable`,
  });
}

/** Waits until every chip shows a count and `accept` approves them; returns the final counts. */
export async function waitForChipCounts(
  browser: TasksBrowser,
  root: string,
  accept: (counts: Record<string, number | null>) => boolean,
  options: { timeoutMs: number; intervalMs: number; describe: string },
): Promise<Record<string, number | null>> {
  return pollUntil(async () => {
    const counts = chipCounts(await readTasks(browser, root));
    return Object.keys(counts).length > 0 && accept(counts) ? counts : null;
  }, options);
}

/**
 * Runs the Set up managed vault command, confirms its plan and waits until the Tasks
 * destination counts at least `minAll` tasks under All. The command is retried until the plugin
 * has connected to the service (a failed attempt only shows a notice).
 */
export async function runSetUpManagedVault(browser: TasksBrowser, minAll: number): Promise<void> {
  await openTasks(browser);
  const command = pluginCommandId(TASKS_TEXT.setupCommand);
  await pollUntil(
    async () => {
      await runPluginCommand(browser, command);
      return pollUntil(
        () => browser.executeObsidian(rendererClick, ".modal button", TASKS_TEXT.setupConfirm),
        { timeoutMs: 4_000, intervalMs: 250, describe: "the setup confirmation" },
      );
    },
    { ...WAIT.connect, describe: "the managed vault setup to be confirmed" },
  );
  await waitForChipCounts(browser, GLOBAL_ROOT, (counts) => (counts["all"] ?? 0) >= minAll, {
    ...WAIT.connect,
    describe: `the Tasks destination to count at least ${minAll} tasks`,
  });
}

/** Opens the create form with the Create task command and waits for it. */
export async function openCreateForm(browser: TasksBrowser): Promise<string> {
  await runPluginCommand(browser, pluginCommandId(TASKS_TEXT.createTaskCommand));
  const form = `${GLOBAL_ROOT} form.${TASKS_CLASSES.taskForm}[aria-label="${TASKS_TEXT.createTask}"]`;
  await pollUntil(async () => (await readTasks(browser, GLOBAL_ROOT)).formOpen, {
    ...WAIT.short,
    describe: "the create form to open",
  });
  return form;
}

/** Types a title into the open create form and presses one of its two submit buttons. */
export async function submitCreateForm(
  browser: TasksBrowser,
  form: string,
  title: string,
  intent: "inbox" | "ready",
): Promise<void> {
  const typed = await browser.executeObsidian(rendererSetInput, form, TASKS_TEXT.fieldTitle, title);
  if (!typed) throw new Error("The create form's title field could not be typed into.");
  const label = intent === "inbox" ? TASKS_TEXT.addToInbox : TASKS_TEXT.addAsReady;
  await pollUntil(() => browser.executeObsidian(rendererClick, `${form} button`, label), {
    ...WAIT.short,
    describe: `the ${label} button to be pressable`,
  });
}

// ---------------------------------------------------------------------------
// Rows, details, note files and vault operations (spec side)

/** The facts Obsidian's Properties view shows for the `due` property. */
export interface DueProperty {
  found: boolean;
  inputType: string | null;
  value: string | null;
}

export type DuePropertyVerdict =
  | { ok: true }
  | { ok: false; code: "property-missing" | "not-a-date-input" | "has-time" };

/** The Properties view shows `due` as a date input holding a plain date, no time. */
export function duePropertyVerdict(property: DueProperty): DuePropertyVerdict {
  if (!property.found) return { ok: false, code: "property-missing" };
  if (property.inputType !== "date") return { ok: false, code: "not-a-date-input" };
  if (property.value === null || !PLAIN_DATE.test(property.value)) {
    return { ok: false, code: "has-time" };
  }
  return { ok: true };
}

/**
 * Reads Obsidian's own Properties view for the `due` property of the open note. The markup is
 * Obsidian's, so the lookup is defensive: the property container by its key attribute, then
 * its first input.
 */
export function rendererInspectDue(_ctx: unknown): DueProperty {
  const container = document.querySelector('.metadata-property[data-property-key="due"]');
  if (container === null) return { found: false, inputType: null, value: null };
  const input = container.querySelector("input");
  return {
    found: true,
    inputType: input === null ? null : input.getAttribute("type"),
    value: input === null ? null : (input.value ?? null),
  };
}

interface VaultFileApi {
  app: {
    vault: {
      getAbstractFileByPath(path: string): unknown;
      copy(file: unknown, newPath: string): Promise<unknown>;
      delete(file: unknown): Promise<void>;
    };
  };
}

/** Copies or deletes one note through the Obsidian vault API; `missing` when it is not there. */
export async function rendererVaultOp(
  ctx: VaultFileApi,
  operation: "copy" | "delete",
  path: string,
  target: string,
): Promise<"ok" | "missing"> {
  const file = ctx.app.vault.getAbstractFileByPath(path);
  if (file === null || file === undefined) return "missing";
  if (operation === "copy") await ctx.app.vault.copy(file, target);
  else await ctx.app.vault.delete(file);
  return "ok";
}

/** Throws unless `name` is one plain note file name (no folder, no dot-dot). */
function assertNoteName(name: string): void {
  if (!/^[^/\\]+\.md$/.test(name) || name.startsWith(".") || name === "index.md") {
    throw new Error("Refusing a note file name that is not one plain task note.");
  }
}

/** Overwrites one global task note of the sandbox vault; nothing else is ever written. */
export function writeGlobalTaskNote(
  vaultPath: string,
  runRoot: string,
  name: string,
  text: string,
): void {
  assertVaultInsideRunRoot(vaultPath, runRoot);
  assertNoteName(name);
  writeFileSync(join(vaultPath, TASK_FOLDERS_GLOBAL, name), text);
}

/** The note whose frontmatter id is `id`. */
export function noteById(files: readonly NoteFile[], id: string): NoteFile | undefined {
  return files.find((file) => {
    const parsed = parseNoteFrontmatter(file.text);
    return parsed.ok && unquote(parsed.map["id"]) === id;
  });
}

/** The row with this exact title, if the surface lists one. */
export function rowByTitle(
  tasks: RenderedTasks,
  title: string,
): RenderedTasks["rows"][number] | undefined {
  return tasks.rows.find((row) => row.title === title);
}

/** Presses a chip and waits for the surface to answer for it. */
export async function showFilter(
  browser: TasksBrowser,
  root: string,
  filter: string,
): Promise<void> {
  await clickChip(browser, root, filter);
  await pollUntil(
    async () => {
      const tasks = await readTasks(browser, root);
      return tasks.chips.some((chip) => chip.filter === filter && chip.pressed);
    },
    { ...WAIT.short, describe: `the ${filter} chip to be pressed` },
  );
}

/**
 * Presses Show more until every wanted title is listed or no more pages remain; returns the last
 * reading. A short list needs no press.
 */
export async function loadRowsFor(
  browser: TasksBrowser,
  root: string,
  titles: readonly string[],
): Promise<RenderedTasks> {
  const more = `${root} button.${TASKS_CLASSES.taskMore}`;
  for (let page = 0; page < 40; page += 1) {
    const tasks = await readTasks(browser, root);
    if (titles.every((title) => rowByTitle(tasks, title) !== undefined)) return tasks;
    if (!(await browser.executeObsidian(rendererClick, more, null))) return tasks;
    await pollUntil(async () => (await readTasks(browser, root)).rows.length > tasks.rows.length, {
      ...WAIT.short,
      describe: "the next page of tasks",
    });
  }
  return readTasks(browser, root);
}

const rowSelector = (root: string, id: string): string =>
  `${root} li.${TASKS_CLASSES.taskRow}[data-task-id="${id}"]`;

/** Opens a row's detail pane by pressing its title button. */
export async function selectRow(browser: TasksBrowser, root: string, id: string): Promise<void> {
  const selector = `${rowSelector(root, id)} button.${TASKS_CLASSES.taskTitle}`;
  await pollUntil(() => browser.executeObsidian(rendererClick, selector, null), {
    ...WAIT.short,
    describe: "the row's title button",
  });
  await pollUntil(
    async () => (await readTasks(browser, `${root} section.${TASKS_CLASSES.taskDetail}`)).mounted,
    { ...WAIT.short, describe: "the detail pane to load" },
  );
}

/** Presses a button of the open detail pane's Task actions group by its label. */
export async function pressDetailAction(
  browser: TasksBrowser,
  root: string,
  label: string,
): Promise<void> {
  const group = `${root} section.${TASKS_CLASSES.taskDetail} [role="group"][aria-label="${TASKS_TEXT.taskActionsLabel}"] button`;
  await pollUntil(() => browser.executeObsidian(rendererClick, group, label), {
    ...WAIT.short,
    describe: `the ${label} button of the detail pane`,
  });
}

/** Presses a row's Accept or Dismiss pill. */
export async function pressRowAction(
  browser: TasksBrowser,
  root: string,
  id: string,
  action: "accept" | "dismiss" | "mark-done",
): Promise<void> {
  const selector = `${rowSelector(root, id)} button.${TASKS_CLASSES.taskAction}[data-action="${action}"]`;
  await pollUntil(() => browser.executeObsidian(rendererClick, selector, null), {
    ...WAIT.short,
    describe: `the ${action} pill of the row`,
  });
}

/** Opens one note in Obsidian so its Properties view renders. */
export async function readDueProperty(browser: TasksBrowser): Promise<DueProperty> {
  return pollUntil(
    async () => {
      const property = await browser.executeObsidian(rendererInspectDue);
      return property.found ? property : null;
    },
    { ...WAIT.short, describe: "the Properties view to show the due property" },
  );
}
