import { SUBSYSTEM_STATUS_DISPLAY, type SubsystemStatus } from "@ccc/domain";
import { type DriverBrowser, type PollOptions, pollUntil } from "../driver.js";
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
}

declare const document: {
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
  ["an errno name", /\bE(?:NOENT|ACCES|PERM|ROFS|NOTDIR|ISDIR|EXIST|XDEV|BUSY|MFILE|NOTEMPTY)\b/],
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
