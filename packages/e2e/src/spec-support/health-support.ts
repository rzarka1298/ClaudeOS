import { join } from "node:path";
import {
  BUNDLE_MAX_BYTES,
  buildDenylist,
  COLLECTORS_REASON_STATUS,
  CORPUS_DENYLIST_INPUT,
  DiagnosticBundleSchema,
  HOOKS_REASON_STATUS,
  HOSTILE_SHAPE_SAMPLES,
  LAUNCHERS_REASON_STATUS,
  SCHEDULER_REASON_STATUS,
  SERVICE_REASON_STATUS,
  SUBSYSTEM_STATUS_DISPLAY,
  type SubsystemStatus,
  VAULT_REASON_STATUS,
  verifyBundle,
} from "@ccc/domain";
import { type DriverBrowser, type PollOptions, pollUntil } from "../driver.js";
import type { RunRootPaths } from "../run-root.js";
import {
  HEALTH_ATTRS,
  HEALTH_CLASSES,
  HEALTH_TEXT,
  hasReasonMirror,
  reasonTextMatches,
} from "./health-copy.js";
import { pluginCommandId, rendererClick, WAIT } from "./tasks-support.js";

/**
 * Support for the health specs (plan 08-20, DIAG-02, DIAG-03, DIAG-04, D-09, D-27, D-28): the typed
 * reader of Settings > Diagnostics, the click path that opens it, the verdict of item 1 of the
 * section (a fresh install), and the judging helpers the break drills share. Everything here runs
 * spec side except the renderer function, which wdio serialises and evaluates inside Obsidian.
 *
 * Nothing in this module reaches the owner's desktop, store, vault or Keychain: it reads the page
 * and clicks controls the owner could click. Failure messages name a row, a status or a reason CODE,
 * never the text of the page or a path, so a failed run can be pasted without leaking anything.
 */

// ---------------------------------------------------------------------------
// The section as the page shows it

export interface HealthPartRead {
  readonly partId: string;
  readonly status: string | null;
  /** The part's `data-reason` code. */
  readonly reason: string | null;
  readonly name: string;
  /** The first paragraph of the part: the reason sentence. */
  readonly reasonText: string;
  /** The visible text of the whole part. */
  readonly text: string;
  readonly buttons: readonly string[];
}

export interface HealthRowRead {
  readonly scope: "subsystem" | "not-in-version";
  /** The `data-subsystem` id, or an empty string for a Not part of this version row. */
  readonly subsystem: string;
  readonly name: string;
  readonly status: string | null;
  /** The status chip's word (`Running`, `Needs setup`, ...). */
  readonly chip: string;
  /** The row's `data-reason` code, or null. */
  readonly reason: string | null;
  /** The reason sentence (the first paragraph of the row's second block). */
  readonly reasonText: string;
  readonly detail: string | null;
  readonly checkedAt: string | null;
  readonly freshness: string | null;
  readonly freshnessLabel: string | null;
  readonly nextStep: string | null;
  /** The repository-relative command shown on the row, or null. */
  readonly command: string | null;
  /** The labels of the buttons in the row's setup callout. */
  readonly actions: readonly string[];
  /** The labels of every button in the row. */
  readonly buttons: readonly string[];
  readonly toggle: { readonly label: string | null; readonly expanded: boolean } | null;
  readonly parts: readonly HealthPartRead[];
  /** True for a loading skeleton: the row names itself and claims nothing. */
  readonly skeleton: boolean;
}

export interface HealthRead {
  /** The health list is on the page. */
  readonly mounted: boolean;
  /** The list carries `aria-busy`: the first answer is on its way. */
  readonly busy: boolean;
  readonly heading: string;
  /** The label of the current item of the Settings section nav. */
  readonly navCurrent: string | null;
  /** The destination's one status line. */
  readonly statusLine: string;
  readonly runChecks: {
    readonly label: string;
    readonly name: string | null;
    readonly busy: boolean;
    readonly disabled: boolean;
  } | null;
  /** The `datetime` of the toolbar's `Checked ...` time: the answer's own time. */
  readonly toolbarGeneratedAt: string | null;
  readonly error: string | null;
  readonly stale: string | null;
  readonly summary: {
    readonly lead: string;
    readonly chips: readonly { readonly status: string | null; readonly text: string }[];
  } | null;
  readonly rows: readonly HealthRowRead[];
  /** The visible text of the whole section (hidden parts removed). */
  readonly text: string;
}

/** The class and attribute names the renderer reader needs, from the mirrored tables. */
export interface HealthDomConfig {
  readonly content: string;
  readonly list: string;
  readonly row: string;
  readonly detail: string;
  readonly meta: string;
  readonly part: string;
  readonly partName: string;
  readonly command: string;
  readonly callout: string;
  readonly stateBody: string;
  readonly badge: string;
  readonly badgeLabel: string;
  readonly hidden: string;
  readonly toolbar: string;
  readonly summary: string;
  readonly stale: string;
  readonly error: string;
  readonly nav: string;
  readonly status: string;
  readonly itemTitle: string;
  readonly attrSubsystem: string;
  readonly attrStatus: string;
  readonly attrReason: string;
  readonly attrPart: string;
  readonly attrBadge: string;
  readonly attrScope: string;
  readonly attrBusy: string;
  readonly attrCurrent: string;
  readonly attrExpanded: string;
  readonly attrDisabled: string;
  readonly notInVersion: string;
}

export const HEALTH_DOM_CONFIG: HealthDomConfig = {
  content: HEALTH_CLASSES.settingsContent,
  list: HEALTH_CLASSES.health,
  row: HEALTH_CLASSES.healthRow,
  detail: HEALTH_CLASSES.healthDetail,
  meta: HEALTH_CLASSES.healthMeta,
  part: HEALTH_CLASSES.healthPart,
  partName: HEALTH_CLASSES.healthPartName,
  command: HEALTH_CLASSES.healthCommand,
  callout: HEALTH_CLASSES.setupCallout,
  stateBody: HEALTH_CLASSES.stateBody,
  badge: HEALTH_CLASSES.badge,
  badgeLabel: HEALTH_CLASSES.badgeLabel,
  hidden: HEALTH_CLASSES.hidden,
  toolbar: HEALTH_CLASSES.healthToolbar,
  summary: HEALTH_CLASSES.healthSummary,
  stale: HEALTH_CLASSES.healthStale,
  error: HEALTH_CLASSES.healthError,
  nav: HEALTH_CLASSES.settingsNav,
  status: HEALTH_CLASSES.settingsStatus,
  itemTitle: HEALTH_CLASSES.settingsItemTitle,
  attrSubsystem: HEALTH_ATTRS.subsystem,
  attrStatus: HEALTH_ATTRS.status,
  attrReason: HEALTH_ATTRS.reason,
  attrPart: HEALTH_ATTRS.part,
  attrBadge: HEALTH_ATTRS.badge,
  attrScope: HEALTH_ATTRS.scope,
  attrBusy: HEALTH_ATTRS.busy,
  attrCurrent: HEALTH_ATTRS.current,
  attrExpanded: HEALTH_ATTRS.expanded,
  attrDisabled: HEALTH_ATTRS.disabled,
  notInVersion: HEALTH_TEXT.notInVersionScope,
};

interface RNode {
  textContent: string | null;
  children: ArrayLike<RNode>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
  cloneNode(deep: boolean): RNode;
  remove(): void;
  click(): void;
  tagName: string;
  nextElementSibling: RNode | null;
}

declare const window: { setTimeout(callback: () => void, ms: number): unknown };

declare const document: {
  getElementById(id: string): RNode | null;
  activeElement: RNode | null;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
};

/**
 * Reads the Settings > Diagnostics section into plain data. SELF-CONTAINED (renderer function):
 * no outer variable, no call to another export, no named inner function; shared helpers are arrow
 * functions held in an array literal, because wdio's tsx loader compiles with keepNames and a
 * nested named function would call a `__name` helper the page does not have.
 */
export function rendererReadHealth(c: HealthDomConfig): HealthRead {
  const H = [
    // 0: the visible text of a node, hidden parts removed, white space collapsed
    (n: RNode | null): string => {
      if (n === null) return "";
      const copy = n.cloneNode(true);
      const gone = copy.querySelectorAll(`.${c.hidden}`);
      for (let i = 0; i < gone.length; i += 1) (gone[i] as RNode).remove();
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    },
    // 1: the labels of the buttons below a node
    (n: RNode | null): string[] => {
      const out: string[] = [];
      if (n === null) return out;
      const found = n.querySelectorAll("button");
      for (let i = 0; i < found.length; i += 1) {
        out.push(((found[i] as RNode).textContent ?? "").replace(/\s+/g, " ").trim());
      }
      return out;
    },
  ];
  const text = H[0] as (n: RNode | null) => string;
  const buttonsOf = H[1] as (n: RNode | null) => string[];
  const content = document.querySelector(`.${c.content}`);
  const list = document.querySelector(`.${c.list}`);
  const toolbar = document.querySelector(`.${c.toolbar}`);
  const nav = document.querySelector(`nav.${c.nav} [${c.attrCurrent}="page"]`);
  const statusLine = document.querySelector(`.${c.status}`);
  const heading = content === null ? null : content.querySelector("h3");
  const rows: HealthRowRead[] = [];
  if (list !== null) {
    const found = list.querySelectorAll(`li.${c.row}`);
    for (let i = 0; i < found.length; i += 1) {
      const row = found[i] as RNode;
      const scope =
        row.getAttribute(c.attrScope) === c.notInVersion ? "not-in-version" : "subsystem";
      const blocks = row.children;
      const reasonBlock = blocks.length > 1 ? (blocks[1] as RNode) : null;
      const meta = row.querySelector(`.${c.meta}`);
      const time = meta === null ? null : meta.querySelector("time");
      const fresh = meta === null ? null : meta.querySelector(`[${c.attrBadge}]`);
      const chip = row.querySelector(`.${c.badge}[${c.attrStatus}]`);
      const callout = row.querySelector(`.${c.callout}`);
      const nextStep = callout === null ? null : callout.querySelector(`.${c.stateBody}`);
      const command = callout === null ? null : callout.querySelector(`.${c.command}`);
      const toggle = row.querySelector(`button[${c.attrExpanded}]`);
      const parts: HealthPartRead[] = [];
      const partNodes = row.querySelectorAll(`li.${c.part}`);
      for (let j = 0; j < partNodes.length; j += 1) {
        const part = partNodes[j] as RNode;
        parts.push({
          partId: part.getAttribute(c.attrPart) ?? "",
          status: part.getAttribute(c.attrStatus),
          reason: part.getAttribute(c.attrReason),
          name: text(part.querySelector(`.${c.partName}`)),
          reasonText: text(part.querySelector("p")),
          text: text(part),
          buttons: buttonsOf(part),
        });
      }
      const status = row.getAttribute(c.attrStatus);
      rows.push({
        scope,
        subsystem: row.getAttribute(c.attrSubsystem) ?? "",
        name: text(row.querySelector(`.${c.itemTitle}`)),
        status,
        chip: text(chip === null ? null : chip.querySelector(`.${c.badgeLabel}`)),
        reason: row.getAttribute(c.attrReason),
        reasonText: text(reasonBlock === null ? null : reasonBlock.querySelector("p")),
        detail:
          row.querySelector(`.${c.detail}`) === null
            ? null
            : text(row.querySelector(`.${c.detail}`)),
        checkedAt: time === null ? null : time.getAttribute("datetime"),
        freshness: fresh === null ? null : fresh.getAttribute(c.attrBadge),
        freshnessLabel: fresh === null ? null : text(fresh.querySelector(`.${c.badgeLabel}`)),
        nextStep: nextStep === null ? null : text(nextStep),
        command: command === null ? null : text(command),
        actions: buttonsOf(callout),
        buttons: buttonsOf(row),
        toggle:
          toggle === null
            ? null
            : {
                label: toggle.getAttribute("aria-label"),
                expanded: toggle.getAttribute(c.attrExpanded) === "true",
              },
        parts,
        skeleton: scope === "subsystem" && status === null,
      });
    }
  }
  const runButton = toolbar === null ? null : toolbar.querySelector("button");
  const toolbarTime = toolbar === null ? null : toolbar.querySelector("time");
  const summaryNode = list === null ? null : list.querySelector(`.${c.summary}`);
  let summary: HealthRead["summary"] = null;
  if (summaryNode !== null) {
    const chips: { status: string | null; text: string }[] = [];
    const chipNodes = summaryNode.querySelectorAll(`.${c.badge}`);
    for (let i = 0; i < chipNodes.length; i += 1) {
      const node = chipNodes[i] as RNode;
      chips.push({
        status: node.getAttribute(c.attrStatus),
        text: text(node.querySelector(`.${c.badgeLabel}`)),
      });
    }
    const lead = summaryNode.children.length > 0 ? text(summaryNode.children[0] as RNode) : "";
    summary = { lead, chips };
  }
  const error = list === null ? null : list.querySelector(`.${c.error}`);
  const stale = list === null ? null : list.querySelector(`.${c.stale}`);
  return {
    mounted: list !== null,
    busy: list !== null && list.getAttribute(c.attrBusy) === "true",
    heading: text(heading),
    navCurrent: nav === null ? null : text(nav),
    statusLine: text(statusLine),
    runChecks:
      runButton === null
        ? null
        : {
            label: text(runButton),
            name: runButton.getAttribute("aria-label"),
            busy: runButton.getAttribute(c.attrBusy) === "true",
            disabled: runButton.getAttribute(c.attrDisabled) === "true",
          },
    toolbarGeneratedAt: toolbarTime === null ? null : toolbarTime.getAttribute("datetime"),
    error: error === null ? null : text(error),
    stale: stale === null ? null : text(stale),
    summary,
    rows,
    text: text(content),
  };
}

// ---------------------------------------------------------------------------
// Reaching and reading the section

/** The slice of the wdio browser the health helpers use. */
export interface HealthBrowser extends DriverBrowser {
  executeObsidian<T, A extends unknown[]>(
    fn: (ctx: never, ...args: A) => T | Promise<T>,
    ...args: A
  ): Promise<T>;
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
}

export function asHealthBrowser(browser: unknown): HealthBrowser {
  return browser as HealthBrowser;
}

export interface ClickStep {
  readonly selector: string;
  /** The exact trimmed text of the element to press, or null for the first match. */
  readonly text: string | null;
}

const SETTINGS_TAB: ClickStep = {
  selector: `#${HEALTH_CLASSES.tabPrefix}${HEALTH_TEXT.settingsTabId}`,
  text: null,
};

function navStep(label: string): ClickStep {
  return {
    selector: `nav[aria-label="${HEALTH_TEXT.settingsNavLabel}"] button.${HEALTH_CLASSES.settingsNavItem}`,
    text: label,
  };
}

/** The clicks that reach Settings > Diagnostics once the command center is open. */
export function diagnosticsClickPath(): ClickStep[] {
  return [SETTINGS_TAB, navStep(HEALTH_TEXT.navDiagnostics)];
}

/**
 * The clicks that leave Diagnostics for another section and come back, so the section mounts
 * again and fetches again (opening the section is the owner gesture that sends the check).
 */
export function reopenClickPath(): ClickStep[] {
  return [SETTINGS_TAB, navStep(HEALTH_TEXT.navVisual), navStep(HEALTH_TEXT.navDiagnostics)];
}

export async function readHealth(browser: HealthBrowser): Promise<HealthRead> {
  return browser.execute(rendererReadHealth, HEALTH_DOM_CONFIG);
}

type WaitOptions = Pick<PollOptions, "timeoutMs" | "intervalMs">;

/**
 * Waits until `check` finds nothing wrong with the section. A timeout names the problems seen
 * last, so a failed run says what the page showed instead of only that a wait ended.
 */
export async function waitForHealth(
  browser: HealthBrowser,
  check: (read: HealthRead) => string[],
  describe: string,
  options: WaitOptions = { timeoutMs: 30_000, intervalMs: 500 },
): Promise<HealthRead> {
  let last: string[] = ["the section was never read"];
  try {
    return await pollUntil(
      async () => {
        const read = await readHealth(browser);
        last = check(read);
        return last.length === 0 ? read : null;
      },
      { ...options, describe },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; the problems were: ${last.join("; ")}`);
  }
}

/** The section is on the page and its first answer has landed. */
export function checkSettled(read: HealthRead): string[] {
  if (!read.mounted) return ["the Diagnostics section is not on the page"];
  if (read.busy) return ["the section is still loading"];
  return [];
}

async function clickPath(browser: HealthBrowser, path: readonly ClickStep[]): Promise<void> {
  for (const step of path) {
    await pollUntil(() => browser.executeObsidian(rendererClick, step.selector, step.text), {
      ...WAIT.short,
      describe: `the control ${step.text ?? step.selector}`,
    });
  }
}

/**
 * Opens the command center, goes to Settings > Diagnostics and waits for the first answer. The
 * section's opening sends one `gesture` check, which is why a sandboxed service that can be asked
 * must come from `startResearchEnvironment()` (it carries the nonexistent research-key account).
 */
export async function openDiagnostics(
  browser: HealthBrowser,
  options: WaitOptions = WAIT.connect,
): Promise<HealthRead> {
  await browser.executeObsidianCommand(pluginCommandId("open-overview"));
  await clickPath(browser, diagnosticsClickPath());
  return waitForHealth(browser, checkSettled, "Diagnostics to show its first answer", options);
}

// ---------------------------------------------------------------------------
// Reading a read

export function rowOf(read: HealthRead, subsystem: string): HealthRowRead | undefined {
  return read.rows.find((row) => row.scope === "subsystem" && row.subsystem === subsystem);
}

export function partOf(row: HealthRowRead | undefined, partId: string): HealthPartRead | undefined {
  return row?.parts.find((part) => part.partId === partId);
}

/** The six subsystem rows in the fixed display order, with the name each shows. */
export const SUBSYSTEMS: readonly { readonly id: string; readonly name: string }[] = Object.freeze([
  { id: "service", name: HEALTH_TEXT.rowService },
  { id: "vault", name: HEALTH_TEXT.rowVault },
  { id: "hooks", name: HEALTH_TEXT.rowHooks },
  { id: "collectors", name: HEALTH_TEXT.rowCollectors },
  { id: "scheduler", name: HEALTH_TEXT.rowScheduler },
  { id: "launchers", name: HEALTH_TEXT.rowLaunchers },
]);

/** The three accounts and services that are not part of this version, in display order. */
export const NOT_IN_VERSION_NAMES: readonly string[] = Object.freeze([
  HEALTH_TEXT.nameGmail,
  HEALTH_TEXT.nameCalendar,
  HEALTH_TEXT.nameGithub,
]);

/** The chip word the plugin shows for a status (the reachable service row reads Running). */
export function chipWord(status: string, subsystem: string): string {
  if (subsystem === "service" && status === "ok") return HEALTH_TEXT.chipRunning;
  const display = (SUBSYSTEM_STATUS_DISPLAY as Record<string, { word: string }>)[status];
  return display?.word ?? status;
}

const RAW_ERROR_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["a home path", /\/(?:Users|home)\/\S+/],
  ["a temporary run folder", /\/(?:tmp|private|var)\/\S*/],
  ["a tilde path", /(?:^|[\s"'(])~\/\S/],
  [
    "an errno name",
    /\bE(?:NOENT|ACCES|PERM|ROFS|NOTDIR|ISDIR|EXIST|XDEV|BUSY|MFILE|NOTEMPTY|CONNREFUSED|CONNRESET|PIPE|TIMEDOUT)\b/,
  ],
  ["an error prefix", /\b(?:[A-Z][a-z]+)?Error:/],
  ["a stack frame", /\bat\s+[^\n]*:\d+:\d+/],
  ["an object dump", /\[object \w+\]/],
  ["an undefined value", /\b(?:undefined|NaN)\b/],
];

/**
 * The kinds of raw error text in `text`: a path, an errno name, an error prefix, a stack frame, an
 * object dump or an undefined value. It returns names of kinds, never the matched text, so a
 * failure message cannot carry a path.
 */
export function findRawErrorText(text: string): string[] {
  return RAW_ERROR_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

interface ReasonBearer {
  readonly reason: string | null;
  readonly reasonText: string;
}

/**
 * Throws unless `target` carries the reason code `code` and the sentence the plugin writes for it
 * (the mirrored copy). A code with no mirrored sentence is itself an error, so a drill cannot pass
 * on a code it cannot judge. The message names the codes involved, never the page text.
 */
export function expectReason(target: ReasonBearer | undefined, code: string): void {
  if (target === undefined)
    throw new Error(`There is no row to judge for the reason code "${code}".`);
  if (target.reason !== code) {
    throw new Error(`The row reads the reason code "${target.reason ?? "none"}", not "${code}".`);
  }
  if (!hasReasonMirror(code)) {
    throw new Error(`There is no mirrored sentence for the reason code "${code}".`);
  }
  if (!reasonTextMatches(code, target.reasonText)) {
    throw new Error(
      `The reason sentence of the row with the code "${code}" is not the one the plugin writes for it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Item 22: the fresh install

function problemsOfRow(
  row: HealthRowRead | undefined,
  id: string,
  name: string,
  status: SubsystemStatus,
  code: string | null,
): string[] {
  if (row === undefined) return [`there is no ${name} row`];
  if (row.skeleton) return [`${name} is still a loading placeholder`];
  const problems: string[] = [];
  if (row.status !== status)
    problems.push(`${name} is ${row.status ?? "unreadable"}, not ${status}`);
  if (row.chip !== chipWord(status, id)) {
    problems.push(`${name} shows the chip "${row.chip}", not "${chipWord(status, id)}"`);
  }
  if (code !== null && row.reason !== code) {
    problems.push(`${name} reads the reason code "${row.reason ?? "none"}", not "${code}"`);
  }
  return problems;
}

/**
 * Item 22 (DIAG-02, DIAG-03, SC2, D-34): on a fresh sandbox the Companion service reads Running,
 * the other five rows read Needs setup each with its next step and an action, nothing is failing or
 * degraded, the summary says "Nothing is failing.", Gmail, Google Calendar and GitHub sit under
 * Not part of this version with no control, and no raw error text is anywhere in the section.
 */
export function checkFreshInstall(read: HealthRead): string[] {
  const settled = checkSettled(read);
  if (settled.length > 0) return settled;
  const problems: string[] = [];
  if (read.heading !== HEALTH_TEXT.navDiagnostics) {
    problems.push(`the section heading is "${read.heading}", not "${HEALTH_TEXT.navDiagnostics}"`);
  }
  const subsystemRows = read.rows.filter((row) => row.scope === "subsystem");
  if (
    subsystemRows.map((row) => row.subsystem).join(",") !== SUBSYSTEMS.map((s) => s.id).join(",")
  ) {
    problems.push("the subsystem rows are not the six expected ones in the fixed order");
  }
  for (const { id, name } of SUBSYSTEMS) {
    const row = rowOf(read, id);
    if (id === "service") {
      problems.push(...problemsOfRow(row, id, name, "ok", "service-live"));
      continue;
    }
    const found = problemsOfRow(row, id, name, "setup-needed", null);
    problems.push(...found);
    if (found.length === 0 && row !== undefined) {
      if (row.nextStep === null || row.nextStep === "") problems.push(`${name} shows no next step`);
      if (row.actions.length === 0) problems.push(`${name} offers no action`);
    }
  }
  for (const row of subsystemRows) {
    if (row.status === "failing" || row.status === "degraded") {
      problems.push(`${row.name} is ${row.status}, and nothing may fail on a fresh install`);
    }
  }
  if (read.summary?.lead !== HEALTH_TEXT.nothingFailing) {
    problems.push(
      `the summary reads "${read.summary?.lead ?? "nothing"}", not "${HEALTH_TEXT.nothingFailing}"`,
    );
  }
  const chips = (read.summary?.chips ?? []).map((chip) => chip.text).join(" | ");
  if (chips !== "1 working | 5 need setup") {
    problems.push(`the summary chips read "${chips}", not "1 working | 5 need setup"`);
  }
  const outside = read.rows.filter((row) => row.scope === "not-in-version");
  for (const name of NOT_IN_VERSION_NAMES) {
    const row = outside.find((entry) => entry.name === name);
    if (row === undefined) {
      problems.push(`there is no ${HEALTH_TEXT.notInVersionHeading} row for ${name}`);
    } else {
      if (row.chip !== HEALTH_TEXT.notInVersionHeading) {
        problems.push(`${name} does not read "${HEALTH_TEXT.notInVersionHeading}"`);
      }
      if (row.buttons.length > 0) problems.push(`${name} has a control and must have none`);
    }
  }
  const raw = findRawErrorText(read.text);
  if (raw.length > 0) problems.push(`the section shows raw error text (${raw.join(", ")})`);
  return problems;
}

// ---------------------------------------------------------------------------
// Drill discipline: every step that changes the sandbox is undone in a finally

/**
 * Runs `fn` and then `restore`, in a finally block, whether `fn` returned or threw. When `fn`
 * threw, its error is the one thrown (a failing restore never hides it); when only `restore`
 * failed, that error is thrown.
 */
export async function withRestore<T>(
  restore: () => void | Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let stepError: { readonly error: unknown } | undefined;
  try {
    result = await fn();
  } catch (error) {
    stepError = { error };
  }
  // The restore runs whether the step returned or threw, before anything is rethrown.
  try {
    await restore();
  } catch (restoreError) {
    if (stepError === undefined) throw restoreError;
  }
  if (stepError !== undefined) throw stepError.error;
  return result as T;
}

/**
 * The calls that change a sandbox file, folder, mode, setting or Keychain item. The health drills
 * spec may make each one only inside `withRestore(...)` or `withMode(...)` (D-09, T-08-50).
 */
export const MUTATING_HELPERS: readonly string[] = Object.freeze([
  "replaceFileInRunRoot",
  "removeFileInRunRoot",
  "renameInRunRoot",
  "makeDirInRunRoot",
  "removeEmptyDirInRunRoot",
  "ageFileInRunRoot",
  "writeSpoolDrops",
  "runHookInstaller",
  "writeFakeExecutable",
  "requestVaultSetup",
  "setTranscriptAnalysis",
  "setSecret",
  "deleteUatAccount",
  "registerProject",
  "renameProject",
  "removeProject",
]);

const GUARD_CALLS: readonly string[] = ["withRestore", "withMode"];

/** `source` with comments and the inside of string and template literals blanked (newlines kept). */
function blankedSource(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (char === "'" || char === '"' || char === "`") {
      out += char;
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") {
          out += " ";
          index += 1;
        }
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** The index just after the parenthesis that closes the one opened at `open`. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/**
 * The mutating calls in `source` that sit outside every `withRestore(...)` and `withMode(...)`
 * call, with their line numbers. A call in the restore argument counts as guarded.
 */
export function findUnguardedMutations(
  source: string,
  names: readonly string[] = MUTATING_HELPERS,
): { call: string; line: number }[] {
  const text = blankedSource(source);
  const extents: [number, number][] = [];
  for (const guard of GUARD_CALLS) {
    for (const match of text.matchAll(new RegExp(`\\b${guard}\\(`, "g"))) {
      const open = (match.index as number) + match[0].length - 1;
      extents.push([open, closingParen(text, open)]);
    }
  }
  const found: { call: string; line: number; at: number }[] = [];
  for (const name of names) {
    for (const match of text.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
      const at = match.index as number;
      if (extents.some(([from, to]) => at > from && at < to)) continue;
      found.push({ call: name, line: text.slice(0, at).split("\n").length, at });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ call, line }) => ({ call, line }));
}

// ---------------------------------------------------------------------------
// Sandbox files the drills touch, and the text recipes that break them

export interface DrillFiles {
  /** Claude's settings in the scratch config folder (the hooks installer writes its entries here). */
  readonly claudeSettings: string;
  /** The record the installer leaves in the runtime folder: `{ nodePath }`. */
  readonly installJson: string;
  /** The dropped-records file of the sandbox spool. */
  readonly spoolDropped: string;
  /** The fake `claude` the hook installer is pointed at. */
  readonly fakeClaude: string;
}

/** The sandbox files the drills touch, all strictly below the run root. */
export function drillFiles(paths: RunRootPaths): DrillFiles {
  return {
    claudeSettings: join(paths.claudeConfigDir, "settings.json"),
    installJson: join(paths.runtimeDir, "hooks", "install.json"),
    spoolDropped: join(paths.runtimeDir, "spool", "hooks.dropped"),
    fakeClaude: join(paths.root, "fake-bin", "claude"),
  };
}

function objectOf(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The ${what} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The ${what} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Claude's settings text with `disableAllHooks` set; every other key is kept. */
export function settingsWithAllHooksDisabled(text: string): string {
  const settings = objectOf(text, "Claude settings text");
  return `${JSON.stringify({ ...settings, disableAllHooks: true }, null, 2)}\n`;
}

/** Claude's settings text without `disableAllHooks`; every other key is kept. */
export function settingsWithoutDisableAll(text: string): string {
  const { disableAllHooks: _removed, ...rest } = objectOf(text, "Claude settings text");
  return `${JSON.stringify(rest, null, 2)}\n`;
}

/** The install record with its `nodePath` replaced; every other key is kept. */
export function installJsonWithNodePath(text: string, nodePath: string): string {
  const record = objectOf(text, "install record");
  return `${JSON.stringify({ ...record, nodePath }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Item 23: the service stopped, then restarted

function problemsOfReason(
  row: HealthRowRead,
  expected: { status: string; reason: string },
): string[] {
  const problems: string[] = [];
  const name = row.name;
  if (row.status !== expected.status) {
    problems.push(`${name} is ${row.status ?? "unreadable"}, not ${expected.status}`);
  }
  if (row.chip !== chipWord(expected.status, row.subsystem)) {
    problems.push(
      `${name} shows the chip "${row.chip}", not "${chipWord(expected.status, row.subsystem)}"`,
    );
  }
  if (row.reason !== expected.reason) {
    problems.push(
      `${name} reads the reason code "${row.reason ?? "none"}", not "${expected.reason}"`,
    );
  } else if (
    hasReasonMirror(expected.reason) &&
    !reasonTextMatches(expected.reason, row.reasonText)
  ) {
    problems.push(`${name} does not show the sentence the plugin writes for "${expected.reason}"`);
  }
  return problems;
}

/**
 * Item 23, with the service stopped (D-03, D-43): the Companion service reads Failing "The plugin
 * can't reach the companion service."; every other row reads Unknown "Can't be checked while the
 * companion service isn't running." with no last value (no detail, no checked time, no parts) and
 * no error text anywhere in the section.
 */
export function checkServiceStopped(read: HealthRead): string[] {
  const settled = checkSettled(read);
  if (settled.length > 0) return settled;
  const problems: string[] = [];
  for (const { id, name } of SUBSYSTEMS) {
    const row = rowOf(read, id);
    if (row === undefined) {
      problems.push(`there is no ${name} row`);
      continue;
    }
    if (id === "service") {
      problems.push(...problemsOfReason(row, { status: "failing", reason: "service-unreachable" }));
      continue;
    }
    problems.push(...problemsOfReason(row, { status: "unknown", reason: "service-not-running" }));
    if (row.detail !== null || row.checkedAt !== null || row.parts.length > 0) {
      problems.push(`${name} still shows a last value`);
    }
  }
  const raw = findRawErrorText(read.text);
  if (raw.length > 0) problems.push(`the section shows raw error text (${raw.join(", ")})`);
  return problems;
}

/** Item 23, after the restart and Run checks again: the service is Running and no row is cleared. */
export function checkServiceRestored(read: HealthRead): string[] {
  const settled = checkSettled(read);
  if (settled.length > 0) return settled;
  const problems: string[] = [];
  for (const { id, name } of SUBSYSTEMS) {
    const row = rowOf(read, id);
    if (row === undefined) {
      problems.push(`there is no ${name} row`);
    } else if (id === "service") {
      problems.push(...problemsOfReason(row, { status: "ok", reason: "service-live" }));
    } else if (row.skeleton || row.reason === "service-not-running" || row.status === null) {
      problems.push(`${name} is still cleared`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Items 24 to 28: a row or a part by status, reason code and sentence

export interface RowExpectation {
  readonly status: string;
  readonly reason: string;
  /** A button the row must offer, in its callout or in any of its parts. */
  readonly button?: string;
  /** The row must show a next step. */
  readonly nextStep?: boolean;
}

/** What is wrong with a subsystem row against `expected`; an empty list is a pass. */
export function checkRowIs(
  read: HealthRead,
  subsystem: string,
  expected: RowExpectation,
): string[] {
  const row = rowOf(read, subsystem);
  if (row === undefined) return [`there is no ${subsystem} row`];
  if (row.skeleton) return [`${row.name} is still a loading placeholder`];
  const problems = problemsOfReason(row, expected);
  if (expected.button !== undefined) {
    const offered = [...row.buttons, ...row.parts.flatMap((part) => part.buttons)];
    if (!offered.includes(expected.button)) {
      problems.push(`${row.name} offers no "${expected.button}" control`);
    }
  }
  if (expected.nextStep === true && (row.nextStep === null || row.nextStep === "")) {
    problems.push(`${row.name} shows no next step`);
  }
  return problems;
}

export interface PartExpectation {
  readonly status: string;
  readonly reason: string;
  readonly button?: string;
}

/** What is wrong with one part of a row against `expected`; an empty list is a pass. */
export function checkPartIs(
  read: HealthRead,
  subsystem: string,
  partId: string,
  expected: PartExpectation,
): string[] {
  const row = rowOf(read, subsystem);
  if (row === undefined) return [`there is no ${subsystem} row`];
  const part = partOf(row, partId);
  if (part === undefined) return [`there is no ${partId} part on ${row.name}`];
  const problems: string[] = [];
  if (part.status !== expected.status) {
    problems.push(
      `the ${partId} part of ${row.name} is ${part.status ?? "unreadable"}, not ${expected.status}`,
    );
  }
  if (part.reason !== expected.reason) {
    problems.push(
      `the ${partId} part of ${row.name} reads the reason code "${part.reason ?? "none"}", not "${expected.reason}"`,
    );
  } else if (
    hasReasonMirror(expected.reason) &&
    !reasonTextMatches(expected.reason, part.reasonText)
  ) {
    problems.push(
      `the ${partId} part of ${row.name} does not show the sentence for "${expected.reason}"`,
    );
  }
  if (expected.button !== undefined && !part.buttons.includes(expected.button)) {
    problems.push(`the ${partId} part of ${row.name} offers no "${expected.button}" control`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Pressing controls and re-checking

/**
 * Clicks the button of a subsystem row whose visible text is `label`; false when there is none.
 * SELF-CONTAINED (renderer function).
 */
export function rendererClickInRow(c: HealthDomConfig, subsystem: string, label: string): boolean {
  const rows = document.querySelectorAll(`li.${c.row}[${c.attrSubsystem}="${subsystem}"]`);
  for (let i = 0; i < rows.length; i += 1) {
    const buttons = (rows[i] as RNode).querySelectorAll("button");
    for (let j = 0; j < buttons.length; j += 1) {
      const button = buttons[j] as RNode;
      if ((button.textContent ?? "").replace(/\s+/g, " ").trim() === label) {
        button.click();
        return true;
      }
    }
  }
  return false;
}

export async function pressInRow(
  browser: HealthBrowser,
  subsystem: string,
  label: string,
): Promise<void> {
  await pollUntil(() => browser.execute(rendererClickInRow, HEALTH_DOM_CONFIG, subsystem, label), {
    ...WAIT.short,
    describe: `the "${label}" control of the ${subsystem} row`,
  });
}

/** The answer cache keeps one run per trigger for two seconds; a re-check waits this long first. */
export const CHECK_CACHE_GAP_MS = 2_100;

export interface CheckClock {
  /**
   * When the page last SHOWED a new answer (or a gesture's answer was seen), in epoch milliseconds
   * (0: never). The name stays from when it was set at the press: the service caches an answer from
   * the moment its run finishes, which is later than the press, so a gap measured from the press can
   * be shorter than two seconds of cache age (FIX6A M2). The moment the page shows the answer is at
   * or after the run's end, so a gap measured from it is never too short.
   */
  lastPressAt: number;
}

export function newCheckClock(): CheckClock {
  return { lastPressAt: 0 };
}

/**
 * Presses Run checks again once the previous answer is more than two seconds old (so the press is a
 * new run, not the cached one) and waits until the page shows a newer answer and the button is free.
 * The answer cache clock is set when the poll sees that answer, not at the press (FIX6A M2).
 * Returns the settled section. `now` is the clock (epoch milliseconds); tests pass a fake one.
 */
export async function recheck(
  browser: HealthBrowser,
  clock: CheckClock,
  options: { gapMs?: number; wait?: WaitOptions; now?: () => number } = {},
): Promise<HealthRead> {
  const gap = options.gapMs ?? CHECK_CACHE_GAP_MS;
  const now = options.now ?? Date.now;
  await pollUntil(() => now() - clock.lastPressAt >= gap, {
    timeoutMs: gap + 5_000,
    intervalMs: 50,
    describe: "the previous answer to be older than the answer cache",
  });
  const before = (await readHealth(browser)).toolbarGeneratedAt;
  await pollUntil(
    () =>
      browser.executeObsidian(
        rendererClick,
        `.${HEALTH_CLASSES.healthToolbar} button`,
        HEALTH_TEXT.runChecksLabel,
      ),
    { ...WAIT.short, describe: "the Run checks again button" },
  );
  return pollUntil(
    async () => {
      const read = await readHealth(browser);
      const done =
        read.mounted &&
        !read.busy &&
        read.runChecks !== null &&
        !read.runChecks.busy &&
        read.toolbarGeneratedAt !== null &&
        read.toolbarGeneratedAt !== before;
      if (!done) return null;
      // The page shows the new answer: the service's cache entry is at most this old.
      clock.lastPressAt = now();
      return read;
    },
    { ...(options.wait ?? WAIT.connect), describe: "Diagnostics to show a newer answer" },
  );
}

// ---------------------------------------------------------------------------
// Item 30: the busy button, the ignored second press and the cached reopening

export interface PressSnapshot {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly status: string;
}

export interface RunChecksPresses {
  readonly found: boolean;
  readonly first: PressSnapshot | null;
  readonly second: PressSnapshot | null;
}

/**
 * Presses Run checks again twice back to back and reports what the page showed after each press,
 * one task later (so the page has drawn). SELF-CONTAINED (renderer function; helpers are arrows in
 * an array literal because of keepNames).
 */
export async function rendererPressRunChecksTwice(c: HealthDomConfig): Promise<RunChecksPresses> {
  const H = [
    (n: RNode | null): string =>
      n === null ? "" : (n.textContent ?? "").replace(/\s+/g, " ").trim(),
    () =>
      new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 0);
      }),
  ];
  const text = H[0] as (n: RNode | null) => string;
  const tick = H[1] as () => Promise<void>;
  const button = document.querySelector(`.${c.toolbar} button`);
  const line = document.querySelector(`.${c.status}`);
  if (button === null) return { found: false, first: null, second: null };
  const first: PressSnapshot[] = [];
  for (let press = 0; press < 2; press += 1) {
    button.click();
    await tick();
    first.push({
      busy: button.getAttribute(c.attrBusy) === "true",
      disabled: button.getAttribute(c.attrDisabled) === "true",
      status: text(line),
    });
  }
  return { found: true, first: first[0] ?? null, second: first[1] ?? null };
}

/** Item 30: the first press makes the button busy and the line "Checking…"; the second changes nothing. */
export function checkRunChecksPresses(result: RunChecksPresses): string[] {
  if (!result.found || result.first === null || result.second === null) {
    return ["the Run checks again button is not on the page"];
  }
  const problems: string[] = [];
  if (!result.first.busy) problems.push("the button was not busy right after the first press");
  if (!result.first.disabled) problems.push("the button was not marked disabled while busy");
  if (result.first.status !== HEALTH_TEXT.checking) {
    problems.push(`the status line read "${result.first.status}", not "${HEALTH_TEXT.checking}"`);
  }
  if (
    !result.second.busy ||
    result.second.status !== result.first.status ||
    result.second.disabled !== result.first.disabled
  ) {
    problems.push("the second press was not ignored: the page changed after it");
  }
  return problems;
}

/** The statement the finished check makes: the line reads "Checked just now." and the button is free. */
export function checkChecked(read: HealthRead): string[] {
  const settled = checkSettled(read);
  if (settled.length > 0) return settled;
  const problems: string[] = [];
  if (read.runChecks === null || read.runChecks.busy) problems.push("the button is still busy");
  if (!read.statusLine.startsWith(HEALTH_TEXT.checkedJustNow)) {
    problems.push(
      `the status line reads "${read.statusLine}", not "${HEALTH_TEXT.checkedJustNow}"`,
    );
  }
  return problems;
}

/**
 * Item 30, reopening Diagnostics within two seconds of a check: the five probe rows read Cached
 * and the companion service row reads Live (the plugin derives it from the connection, so it is
 * never cached; FIX6A Codex-3), and the checked time (the toolbar's and each row's) is the one the
 * first answer had.
 */
export function checkCachedReopen(first: HealthRead, second: HealthRead): string[] {
  const settled = checkSettled(second);
  if (settled.length > 0) return settled;
  const problems: string[] = [];
  if (second.toolbarGeneratedAt !== first.toolbarGeneratedAt) {
    problems.push("the toolbar's checked time moved, so the reopening ran a new check");
  }
  for (const { id, name } of SUBSYSTEMS) {
    const row = rowOf(second, id);
    if (row === undefined) {
      problems.push(`there is no ${name} row`);
      continue;
    }
    const expected = id === "service" ? HEALTH_TEXT.freshnessLive : HEALTH_TEXT.freshnessCached;
    if (row.freshnessLabel !== expected) {
      problems.push(`${name} reads ${row.freshnessLabel ?? "no freshness"}, not ${expected}`);
    }
    if (row.checkedAt !== rowOf(first, id)?.checkedAt) {
      problems.push(`${name} shows another checked time than the first answer`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Status of a reason code, from the domain's own tables

const STATUS_TABLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  service: SERVICE_REASON_STATUS,
  vault: VAULT_REASON_STATUS,
  hooks: HOOKS_REASON_STATUS,
  collectors: COLLECTORS_REASON_STATUS,
  scheduler: SCHEDULER_REASON_STATUS,
  launchers: LAUNCHERS_REASON_STATUS,
};

/** The status the domain gives a reason code of a subsystem; throws for an unknown pair. */
export function statusOfReason(subsystem: string, code: string): string {
  const table = Object.hasOwn(STATUS_TABLES, subsystem) ? STATUS_TABLES[subsystem] : undefined;
  if (table === undefined)
    throw new Error(`There is no reason table for the subsystem "${subsystem}".`);
  const status = Object.hasOwn(table, code) ? table[code] : undefined;
  if (status === undefined) {
    throw new Error(`The reason code "${code}" is not a ${subsystem} reason code.`);
  }
  return status;
}

/** {@link checkRowIs} with the status taken from the domain for `code`. */
export function expectRow(
  read: HealthRead,
  subsystem: string,
  code: string,
  extra: { button?: string; nextStep?: boolean } = {},
): string[] {
  return checkRowIs(read, subsystem, {
    ...extra,
    status: statusOfReason(subsystem, code),
    reason: code,
  });
}

/** {@link checkPartIs} with the status taken from the domain for `code`. */
export function expectPart(
  read: HealthRead,
  subsystem: string,
  partId: string,
  code: string,
  extra: { button?: string } = {},
): string[] {
  return checkPartIs(read, subsystem, partId, {
    ...extra,
    status: statusOfReason(subsystem, code),
    reason: code,
  });
}

/** The row offers a button with this label, in its callout or in one of its parts. */
export function checkOffers(read: HealthRead, subsystem: string, label: string): string[] {
  const row = rowOf(read, subsystem);
  if (row === undefined) return [`there is no ${subsystem} row`];
  const offered = [...row.buttons, ...row.parts.flatMap((part) => part.buttons)];
  return offered.includes(label) ? [] : [`${row.name} offers no "${label}" control`];
}

/** The Scheduler row always says that nothing runs on a timer (ADR-0013, item 27). */
export function checkSchedulerLine(read: HealthRead): string[] {
  const row = rowOf(read, "scheduler");
  if (row === undefined) return ["there is no Scheduler row"];
  return (row.detail ?? "").includes(HEALTH_TEXT.schedulerFixedLine)
    ? []
    : [`the Scheduler row does not say "${HEALTH_TEXT.schedulerFixedLine}"`];
}

// ---------------------------------------------------------------------------
// Where the page is: the section after a go-to action, and the vault setup modal

export interface SectionRead {
  readonly navCurrent: string | null;
  readonly heading: string;
  /** The section's own heading holds keyboard focus (what a go-to action does). */
  readonly headingFocused: boolean;
}

/** The current section nav item, the section heading and whether it is focused. SELF-CONTAINED. */
export function rendererReadSection(c: HealthDomConfig): SectionRead {
  const H = [
    (n: RNode | null): string =>
      n === null ? "" : (n.textContent ?? "").replace(/\s+/g, " ").trim(),
  ];
  const text = H[0] as (n: RNode | null) => string;
  const content = document.querySelector(`.${c.content}`);
  const heading = content === null ? null : content.querySelector("h3");
  const current = document.querySelector(`nav.${c.nav} [${c.attrCurrent}="page"]`);
  return {
    navCurrent: current === null ? null : text(current),
    heading: text(heading),
    headingFocused: heading !== null && document.activeElement === heading,
  };
}

export async function readSection(browser: HealthBrowser): Promise<SectionRead> {
  return browser.execute(rendererReadSection, HEALTH_DOM_CONFIG);
}

/** The open modal's title and button labels, or a null title when no modal is open. SELF-CONTAINED. */
export function rendererReadModal(): { title: string | null; buttons: string[] } {
  const modal = document.querySelector(".modal");
  if (modal === null) return { title: null, buttons: [] };
  const title = modal.querySelector("h2");
  const buttons: string[] = [];
  const found = modal.querySelectorAll("button");
  for (let i = 0; i < found.length; i += 1) {
    buttons.push(((found[i] as RNode).textContent ?? "").replace(/\s+/g, " ").trim());
  }
  return { title: title === null ? null : (title.textContent ?? "").trim(), buttons };
}

export async function readModal(
  browser: HealthBrowser,
): Promise<{ title: string | null; buttons: string[] }> {
  return browser.execute(rendererReadModal);
}

/**
 * Leaves Diagnostics for another section and comes back, so the section mounts again and fetches
 * again (that fetch is an owner gesture), then waits for the first answer.
 */
export async function reopenDiagnostics(
  browser: HealthBrowser,
  options: WaitOptions = WAIT.connect,
): Promise<HealthRead> {
  await clickPath(browser, reopenClickPath());
  return waitForHealth(browser, checkSettled, "Diagnostics to show its answer again", options);
}

/** Waits until the section is settled and Run checks again is free: the service is live again. */
export async function waitForLive(
  browser: HealthBrowser,
  options: WaitOptions = WAIT.connect,
): Promise<HealthRead> {
  return waitForHealth(
    browser,
    (read) => {
      const settled = checkSettled(read);
      if (settled.length > 0) return settled;
      return read.runChecks !== null && !read.runChecks.disabled && !read.runChecks.busy
        ? []
        : ["Run checks again is still disabled, so the service is not live"];
    },
    "the service to be live and Diagnostics to be ready",
    options,
  );
}

// ---------------------------------------------------------------------------
// The diagnostic bundle block (items 31 to 33 and 35)

export interface BundleButton {
  readonly label: string;
  /** `aria-expanded`, or null for a button without it. */
  readonly expanded: boolean | null;
  readonly disabled: boolean;
  readonly busy: boolean;
  /** The text of the element the button's `aria-describedby` names, or null. */
  readonly reason: string | null;
}

export interface BundleRead {
  /** The block's heading is on the page. */
  readonly mounted: boolean;
  readonly buttons: readonly BundleButton[];
  readonly preview: {
    /** The preview's text exactly as drawn: line breaks and indentation kept. */
    readonly text: string;
    readonly role: string | null;
    readonly label: string | null;
    readonly focusable: boolean;
  } | null;
  /** The `Bundle not offered` panel: its heading and its sentence. */
  readonly refusal: { readonly heading: string; readonly text: string } | null;
  readonly stale: string | null;
  readonly sizeLine: string | null;
  readonly lines: readonly string[];
  readonly statusLine: string;
}

export interface BundleDomConfig {
  readonly content: string;
  readonly groupTitle: string;
  readonly heading: string;
  readonly preview: string;
  readonly callout: string;
  readonly itemTitle: string;
  readonly stale: string;
  readonly status: string;
  readonly hidden: string;
  readonly attrDisabled: string;
  readonly attrBusy: string;
  readonly attrExpanded: string;
}

export const BUNDLE_DOM_CONFIG: BundleDomConfig = {
  content: HEALTH_CLASSES.settingsContent,
  groupTitle: HEALTH_CLASSES.settingsGroupTitle,
  heading: HEALTH_TEXT.bundleHeading,
  preview: HEALTH_CLASSES.bundlePreview,
  callout: HEALTH_CLASSES.setupCallout,
  itemTitle: HEALTH_CLASSES.settingsItemTitle,
  stale: HEALTH_CLASSES.healthStale,
  status: HEALTH_CLASSES.settingsStatus,
  hidden: HEALTH_CLASSES.hidden,
  attrDisabled: HEALTH_ATTRS.disabled,
  attrBusy: HEALTH_ATTRS.busy,
  attrExpanded: HEALTH_ATTRS.expanded,
};

/**
 * Reads the diagnostic bundle block: everything between its `h4` heading and the next group
 * heading. SELF-CONTAINED (renderer function; helpers are arrows in an array literal because of
 * keepNames). The preview text is the node's `textContent` as it is, because the spec compares it
 * with the copied text byte for byte.
 */
export function rendererReadBundle(c: BundleDomConfig): BundleRead {
  const H = [
    (n: RNode | null): string => {
      if (n === null) return "";
      const copy = n.cloneNode(true);
      const gone = copy.querySelectorAll(`.${c.hidden}`);
      for (let i = 0; i < gone.length; i += 1) (gone[i] as RNode).remove();
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    },
    (b: RNode): BundleButton => {
      const expanded = b.getAttribute(c.attrExpanded);
      const describedBy = b.getAttribute("aria-describedby");
      const target = describedBy === null ? null : document.getElementById(describedBy);
      return {
        label: (b.textContent ?? "").replace(/\s+/g, " ").trim(),
        expanded: expanded === null ? null : expanded === "true",
        disabled: b.getAttribute(c.attrDisabled) === "true",
        busy: b.getAttribute(c.attrBusy) === "true",
        reason: target === null ? null : (target.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    },
  ];
  const text = H[0] as (n: RNode | null) => string;
  const asButton = H[1] as (b: RNode) => BundleButton;
  const content = document.querySelector(`.${c.content}`);
  const statusLine = text(document.querySelector(`.${c.status}`));
  const empty: BundleRead = {
    mounted: false,
    buttons: [],
    preview: null,
    refusal: null,
    stale: null,
    sizeLine: null,
    lines: [],
    statusLine,
  };
  if (content === null) return empty;
  let heading: RNode | null = null;
  const headings = content.querySelectorAll(`h4.${c.groupTitle}`);
  for (let i = 0; i < headings.length; i += 1) {
    if (text(headings[i] as RNode) === c.heading) heading = headings[i] as RNode;
  }
  if (heading === null) return empty;
  const buttons: BundleButton[] = [];
  const lines: string[] = [];
  let preview: BundleRead["preview"] = null;
  let refusal: BundleRead["refusal"] = null;
  let stale: string | null = null;
  let sizeLine: string | null = null;
  let node = heading.nextElementSibling;
  while (node !== null) {
    if (node.tagName === "H4") break;
    const own = node.tagName === "BUTTON" ? [node] : Array.from(node.querySelectorAll("button"));
    for (let i = 0; i < own.length; i += 1) buttons.push(asButton(own[i] as RNode));
    const pre = node.tagName === "PRE" ? node : node.querySelector(`pre.${c.preview}`);
    if (pre !== null) {
      preview = {
        text: pre.textContent ?? "",
        role: pre.getAttribute("role"),
        label: pre.getAttribute("aria-label"),
        focusable: pre.getAttribute("tabindex") === "0",
      };
    }
    const classes = node.getAttribute("class") ?? "";
    if (classes.split(" ").includes(c.callout)) {
      const title = node.querySelector(`h5.${c.itemTitle}`);
      if (title !== null) {
        const paragraphs = node.querySelectorAll("p");
        refusal = {
          heading: text(title).replace(/^\S+\s+(?=Bundle)/, ""),
          text: paragraphs.length > 0 ? text(paragraphs[0] as RNode) : "",
        };
      }
    }
    const staleNode = node.querySelector(`.${c.stale}`);
    if (staleNode !== null) stale = text(staleNode);
    const paragraphs = node.tagName === "P" ? [node] : Array.from(node.querySelectorAll("p"));
    for (let i = 0; i < paragraphs.length; i += 1) {
      const line = text(paragraphs[i] as RNode);
      if (line !== "") lines.push(line);
      if (/^\d+(?:\.\d)? (?:B|KB) · \d+ lines?$/.test(line)) sizeLine = line;
    }
    node = node.nextElementSibling;
  }
  return { mounted: true, buttons, preview, refusal, stale, sizeLine, lines, statusLine };
}

export async function readBundle(browser: HealthBrowser): Promise<BundleRead> {
  return browser.execute(rendererReadBundle, BUNDLE_DOM_CONFIG);
}

export function bundleButton(read: BundleRead, label: string): BundleButton | undefined {
  return read.buttons.find((button) => button.label === label);
}

/** Waits until `check` finds nothing wrong with the bundle block (see {@link waitForHealth}). */
export async function waitForBundle(
  browser: HealthBrowser,
  check: (read: BundleRead) => string[],
  describe: string,
  options: WaitOptions = { timeoutMs: 30_000, intervalMs: 250 },
): Promise<BundleRead> {
  let last: string[] = ["the bundle block was never read"];
  try {
    return await pollUntil(
      async () => {
        const read = await readBundle(browser);
        last = check(read);
        return last.length === 0 ? read : null;
      },
      { ...options, describe },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; the problems were: ${last.join("; ")}`);
  }
}

/** Presses a button of the bundle block by its visible text. */
export async function pressBundleButton(browser: HealthBrowser, label: string): Promise<void> {
  await pollUntil(
    () => browser.executeObsidian(rendererClick, `.${HEALTH_CLASSES.healthToolbar} button`, label),
    { ...WAIT.short, describe: `the "${label}" control` },
  );
}

/** Closed: the block is there with its toggle alone: no preview, no Copy, no Save. */
export function checkBundleClosed(read: BundleRead): string[] {
  if (!read.mounted) return ["the Diagnostic bundle block is not on the page"];
  const problems: string[] = [];
  const toggle = bundleButton(read, HEALTH_TEXT.showBundlePreview);
  if (toggle === undefined || toggle.disabled || toggle.expanded !== false) {
    problems.push(`the "${HEALTH_TEXT.showBundlePreview}" control is missing, disabled or open`);
  }
  if (read.preview !== null) problems.push("a bundle preview is open");
  for (const label of [HEALTH_TEXT.copyBundle, HEALTH_TEXT.saveBundle]) {
    if (bundleButton(read, label) !== undefined)
      problems.push(`"${label}" is offered while the preview is closed`);
  }
  return problems;
}

/**
 * Offered: the preview is a labelled, focusable region; Copy is enabled and Save is there; no
 * refusal and no stale line (the checks are fresh).
 */
export function checkBundleOffered(read: BundleRead): string[] {
  if (!read.mounted) return ["the Diagnostic bundle block is not on the page"];
  if (read.refusal !== null)
    return [`the block shows "${read.refusal.heading}" instead of a bundle`];
  const problems: string[] = [];
  const toggle = bundleButton(read, HEALTH_TEXT.hideBundlePreview);
  if (toggle === undefined || toggle.expanded !== true) {
    problems.push(
      `the "${HEALTH_TEXT.hideBundlePreview}" control is missing: the preview is not open`,
    );
  }
  if (read.preview === null) {
    problems.push("the block shows no preview");
  } else {
    if (read.preview.role !== "region" || read.preview.label !== HEALTH_TEXT.bundlePreviewLabel) {
      problems.push("the preview is not a region labelled as the Diagnostic bundle preview");
    }
    if (!read.preview.focusable) problems.push("the preview cannot be reached with the keyboard");
    if (read.preview.text === "") problems.push("the preview is empty");
  }
  const copy = bundleButton(read, HEALTH_TEXT.copyBundle);
  if (copy === undefined || copy.disabled)
    problems.push(`"${HEALTH_TEXT.copyBundle}" is missing or disabled`);
  if (bundleButton(read, HEALTH_TEXT.saveBundle) === undefined) {
    problems.push(`"${HEALTH_TEXT.saveBundle}" is missing`);
  }
  if (read.stale !== null) {
    problems.push("the bundle was built from checks older than 5 minutes");
  }
  return problems;
}

/** Refused: the panel names a closed rule, shows no preview, and Copy and Save are disabled with the reason. */
export function checkBundleRefused(read: BundleRead): string[] {
  if (!read.mounted) return ["the Diagnostic bundle block is not on the page"];
  const problems: string[] = [];
  if (read.refusal === null || read.refusal.heading !== HEALTH_TEXT.bundleNotOffered) {
    problems.push(`the block shows no refusal headed "${HEALTH_TEXT.bundleNotOffered}"`);
  }
  if (read.preview !== null) problems.push("a refused bundle is previewed");
  for (const label of [HEALTH_TEXT.copyBundle, HEALTH_TEXT.saveBundle]) {
    const found = bundleButton(read, label);
    if (found === undefined || !found.disabled || found.reason !== HEALTH_TEXT.bundleRefused) {
      problems.push(`"${label}" is not disabled with the refusal reason`);
    }
  }
  return problems;
}

/**
 * Save's presence and state (the runner cannot drive the native sheet): the control is there; when
 * it is disabled it says why.
 */
export function checkSaveButton(read: BundleRead): string[] {
  const save = bundleButton(read, HEALTH_TEXT.saveBundle);
  if (save === undefined) return [`there is no "${HEALTH_TEXT.saveBundle}" control`];
  if (save.disabled && (save.reason === null || save.reason === "")) {
    return [`"${HEALTH_TEXT.saveBundle}" is disabled without a reason`];
  }
  return [];
}

/** The copied text is the preview text, character for character and byte for byte (D-12). */
export function bundleTextsEqual(preview: string, copied: string | undefined): string[] {
  if (copied === undefined) return ["nothing was copied"];
  if (!Buffer.from(preview, "utf8").equals(Buffer.from(copied, "utf8")) || preview !== copied) {
    return ["the copied text is not the preview byte for byte"];
  }
  return [];
}

/** The saved file holds exactly the preview's bytes and is private to the owner (mode 600). */
export function checkSavedFile(preview: string, bytes: Buffer, mode: number): string[] {
  const problems: string[] = [];
  if (!Buffer.from(preview, "utf8").equals(bytes)) {
    problems.push("the saved file is not the preview's bytes");
  }
  if ((mode & 0o777) !== 0o600) {
    problems.push(`the saved file's mode is ${(mode & 0o777).toString(8)}, not 600`);
  }
  return problems;
}

const DEFAULT_BUNDLE_NAME = new RegExp(
  `^${HEALTH_TEXT.bundleFileNamePrefix}\\d{4}-\\d{2}-\\d{2}\\.json$`,
);

/**
 * What the stubbed save dialog was asked (item 35's automated part): a bare, dated default name, a
 * json filter and no overwrite confirmation (D-12a).
 */
export function checkSaveDialogCall(
  call:
    | {
        readonly defaultPath: string | null;
        readonly bareDefaultName: boolean;
        readonly filters: readonly {
          readonly name: string;
          readonly extensions: readonly string[];
        }[];
        readonly properties: readonly string[];
      }
    | undefined,
): string[] {
  if (call === undefined) return ["the stub recorded no save dialog call"];
  const problems: string[] = [];
  if (!call.bareDefaultName) problems.push("the default file name is not bare: it names a folder");
  if (call.defaultPath === null || !DEFAULT_BUNDLE_NAME.test(call.defaultPath)) {
    problems.push("the default file name is not the dated diagnostics file name");
  }
  if (!call.filters.some((filter) => filter.extensions.includes("json"))) {
    problems.push("the dialog has no json filter");
  }
  // D-12a (FIX4B): Save never replaces a file, so the dialog must not ask to confirm an overwrite.
  if (call.properties.includes("showOverwriteConfirmation")) {
    problems.push("the dialog asks for an overwrite confirmation, but Save never overwrites");
  }
  return problems;
}

export interface BundleLeakFacts {
  readonly runRoot: string;
  readonly homeFolder: string;
  readonly userName: string | null;
  readonly vaultName: string | null;
  readonly projectNames: readonly string[];
  readonly folderBasenames: readonly string[];
}

/**
 * Judges a bundle text (item 31, 32): it is JSON in the bundle format (versions, the six subsystems
 * with reason codes, counts and setting flags), under the size cap, holds none of the names, folders
 * and paths the run knows, and the domain's own verifier accepts it against a denylist built from
 * the same facts. Failures name a check or a rule, never a value.
 */
export function checkBundleClean(text: string, facts: BundleLeakFacts): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ["the bundle text is not JSON"];
  }
  const problems: string[] = [];
  const lowered = text.toLowerCase();
  const labelled: [string, string | null][] = [
    ["the run root", facts.runRoot],
    ["the home folder", facts.homeFolder],
    ["the user name", facts.userName],
    ...facts.projectNames.map((name): [string, string] => ["the project name", name]),
    ...facts.folderBasenames.map((name): [string, string] => ["a folder name", name]),
  ];
  for (const [label, value] of labelled) {
    if (value !== null && value !== "" && lowered.includes(value.toLowerCase())) {
      problems.push(`the bundle holds ${label}`);
    }
  }
  if (Buffer.byteLength(text, "utf8") > BUNDLE_MAX_BYTES)
    problems.push("the bundle is over the size cap");
  if (!DiagnosticBundleSchema.safeParse(parsed).success) {
    problems.push("the bundle does not match the bundle format");
  }
  const denylist = buildDenylist({
    projectNames: [...facts.projectNames],
    folderBasenames: [...facts.folderBasenames],
    github: [],
    vaultName: facts.vaultName,
    userName: facts.userName,
  });
  const verdict = verifyBundle(parsed, denylist);
  if (!verdict.ok) problems.push(`the domain verifier refused the bundle (rule ${verdict.rule})`);
  return problems;
}

/**
 * The hostile names item 32 registers, from the domain's own corpus: folder names that are safe on
 * disk (a private-looking project name, a folder name, a GitHub owner, the synthetic user, an
 * email-like name) and display names that are not (a home-path-like string and an email-like one).
 * `projectNames` and `folderBasenames` are what the bundle must keep out.
 */
export function hostileProjectNames(): {
  projectNames: string[];
  folderBasenames: string[];
  folders: string[];
  displayNames: string[];
} {
  const emailSample = HOSTILE_SHAPE_SAMPLES.find(
    (sample) => sample.rule === "email" && !/[\\/\0\s]/.test(sample.value),
  );
  const homeSample = HOSTILE_SHAPE_SAMPLES.find((sample) => sample.rule === "home-path");
  const projectNames = [...CORPUS_DENYLIST_INPUT.projectNames];
  const folderBasenames = [...CORPUS_DENYLIST_INPUT.folderBasenames];
  const safe = (name: string): boolean =>
    name.length > 0 && name.length <= 80 && !/[\\/\0]/.test(name);
  const folders = [
    ...projectNames,
    ...folderBasenames,
    ...CORPUS_DENYLIST_INPUT.github.map((entry) => entry.owner),
    ...(emailSample === undefined ? [] : [emailSample.value]),
  ].filter(safe);
  const displayNames = [
    ...(homeSample === undefined ? [] : [homeSample.value]),
    ...(emailSample === undefined ? [] : [emailSample.value]),
    ...projectNames,
  ];
  return { projectNames, folderBasenames, folders, displayNames };
}

/** Presses Show bundle preview and waits for the offered preview. */
export async function openBundlePreview(
  browser: HealthBrowser,
  options: WaitOptions = WAIT.connect,
): Promise<BundleRead> {
  await pressBundleButton(browser, HEALTH_TEXT.showBundlePreview);
  return waitForBundle(browser, checkBundleOffered, "the bundle preview to be offered", options);
}

/** Presses Hide bundle preview and waits for the closed block. */
export async function closeBundlePreview(
  browser: HealthBrowser,
  options: WaitOptions = WAIT.short,
): Promise<BundleRead> {
  await pressBundleButton(browser, HEALTH_TEXT.hideBundlePreview);
  return waitForBundle(browser, checkBundleClosed, "the bundle preview to close", options);
}
