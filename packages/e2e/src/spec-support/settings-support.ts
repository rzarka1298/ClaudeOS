import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVACY_RULES } from "@ccc/domain";
import {
  canonicalPath,
  isStrictlyInside,
  isSymlinkOnDisk,
  MSG_PATH_LINK,
} from "../canonical-path.js";
import { type PollOptions, pollUntil } from "../driver.js";
import { PLUGIN_DATA_KEYS, PLUGIN_ID } from "../plugin-data.js";
import type { RunContext } from "../spec-context.js";
import { copyStore, queryStore } from "../store-copy.js";
import {
  contrastFailures,
  type ObsidianBase,
  rendererSetBase,
  type ThemeReading,
  type ThemeSwitch,
} from "./contrast-probe.js";
import { allMotionOff, anyMotionOn, focusRingVisible, type MotionSample } from "./cross-support.js";
import { type ClickStep, type HealthBrowser, MUTATING_HELPERS } from "./health-support.js";
import { OVERVIEW_TEXT } from "./overview-copy.js";
import {
  SETTINGS_ATTRS,
  SETTINGS_CLASSES,
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_LABELS,
  SETTINGS_TEXT,
  type SettingsSectionKey,
  sectionLabel,
} from "./settings-copy.js";
import { pluginCommandId, rendererClick, WAIT } from "./tasks-support.js";

/**
 * Support for the Settings specs (plan 08-22, DIAG-01, SC3, D-15 to D-18, D-44): the typed reader
 * of the Settings destination (the frame, the nav, the active section, its facts, setting rows and
 * buttons), the click path that opens a section, the verdicts for the nav and for focus, and the
 * absolute-path finder behind the privacy items. Everything here runs spec side except the
 * renderer functions, which wdio serialises and evaluates inside Obsidian.
 *
 * Nothing in this module reaches the owner's desktop, store, vault or Keychain: it reads the page
 * and clicks controls the owner could click. Failure messages name a section, a control or a
 * category, never the text of the page or a path, so a failed run can be pasted without leaking
 * anything.
 */

// ---------------------------------------------------------------------------
// The destination as the page shows it

export interface SettingsNavRead {
  readonly label: string;
  /** `aria-current="page"`. */
  readonly current: boolean;
  /** The raw `tabindex` attribute (`0` for the one tab stop, `-1` for the rest). */
  readonly tabIndex: string | null;
  /** The nav item holds keyboard focus. */
  readonly focused: boolean;
}

export interface SettingsChipRead {
  readonly status: string | null;
  /** The chip's word (`Present`, `Needs setup`, ...). */
  readonly word: string;
}

/** One `dt` / `dd` pair of a `dl.ccc-detail-fields`. */
export interface SettingsFactRead {
  readonly name: string;
  /** The visible text of the value, hidden parts removed. */
  readonly text: string;
  /** The value's paragraphs, one entry each. */
  readonly lines: readonly string[];
  readonly chips: readonly SettingsChipRead[];
  /** A Stale freshness badge sits on the value. */
  readonly stale: boolean;
  /** The text of every `code` element of the value (display paths, commands, hosts). */
  readonly code: readonly string[];
  /** The value reads `Unknown` (`p.ccc-setting-unknown`). */
  readonly unknown: boolean;
  /** The value is a loading skeleton line. */
  readonly loading: boolean;
  readonly buttons: readonly string[];
}

export interface SettingsControlRead {
  readonly kind: "switch" | "select" | "button" | "none";
  /** The switch word, the selected option's text, or the button label. */
  readonly label: string;
  readonly checked: boolean | null;
  /** A select's value. */
  readonly value: string | null;
  readonly options: readonly string[];
  /** `aria-disabled="true"` or the native attribute. */
  readonly disabled: boolean;
  readonly busy: boolean;
  /** The visible text of every element the control is `aria-describedby`. */
  readonly describedText: readonly string[];
}

export interface SettingsRowRead {
  readonly name: string;
  /** Every paragraph of the row's text block. */
  readonly paragraphs: readonly string[];
  readonly control: SettingsControlRead;
  /** The `p[data-result]` lines under the row. */
  readonly results: readonly { readonly key: string; readonly text: string }[];
}

export interface SettingsButtonRead {
  readonly label: string;
  /** The `aria-label`, or null. */
  readonly name: string | null;
  readonly disabled: boolean;
  readonly busy: boolean;
}

export interface SettingsFocusRead {
  readonly tag: string;
  readonly classes: string;
  readonly label: string;
  readonly inNav: boolean;
  readonly inContent: boolean;
  readonly inHeader: boolean;
  /** Focus is anywhere inside the Settings destination. */
  readonly inDestination: boolean;
  /** The focused element is the active section's heading. */
  readonly isSectionHeading: boolean;
  readonly focusVisible: boolean;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly boxShadow: string;
}

export interface SettingsRead {
  /** The destination is on the page. */
  readonly mounted: boolean;
  readonly heading: string;
  readonly description: string;
  /** The destination's one status line. */
  readonly statusLine: string;
  /** The status line's `role`. */
  readonly statusRole: string | null;
  readonly nav: readonly SettingsNavRead[];
  readonly section: {
    readonly heading: string;
    readonly headingFocused: boolean;
    readonly headingTabIndex: string | null;
  };
  readonly focus: SettingsFocusRead | null;
  readonly facts: readonly SettingsFactRead[];
  readonly rows: readonly SettingsRowRead[];
  readonly buttons: readonly SettingsButtonRead[];
  /** The number of `input` and `textarea` elements in the section. */
  readonly inputs: number;
  /** The text of every `code.ccc-setting-path`. */
  readonly paths: readonly string[];
  /** Every `[data-result]` line of the section. */
  readonly results: readonly { readonly key: string; readonly text: string }[];
  /** Every `h4` and `h5` text of the section. */
  readonly subheads: readonly string[];
  /** Every visible paragraph of the section. */
  readonly paragraphs: readonly string[];
  /** Every `[data-status-text]` line, by its id. */
  readonly statusTexts: readonly { readonly id: string; readonly text: string }[];
  /** The visible text of the whole section. */
  readonly text: string;
  /** Something in the section is busy (`aria-busy="true"`): a first answer or a save is on its way. */
  readonly busy: boolean;
}

/** The class and attribute names the renderer reader needs, from the mirrored tables. */
export interface SettingsDomConfig {
  readonly root: string;
  readonly header: string;
  readonly nav: string;
  readonly navItem: string;
  readonly content: string;
  readonly status: string;
  readonly row: string;
  readonly rowText: string;
  readonly rowControl: string;
  readonly detailFields: string;
  readonly badge: string;
  readonly badgeLabel: string;
  readonly hidden: string;
  readonly skeleton: string;
  readonly settingPath: string;
  readonly settingUnknown: string;
  readonly attrCurrent: string;
  readonly attrChecked: string;
  readonly attrDisabled: string;
  readonly attrBusy: string;
  readonly attrDescribedBy: string;
  readonly attrResult: string;
  readonly attrStatus: string;
  readonly attrBadge: string;
  readonly attrStatusText: string;
}

export const SETTINGS_DOM_CONFIG: SettingsDomConfig = {
  root: SETTINGS_CLASSES.settings,
  header: SETTINGS_CLASSES.settingsHeader,
  nav: SETTINGS_CLASSES.settingsNav,
  navItem: SETTINGS_CLASSES.settingsNavItem,
  content: SETTINGS_CLASSES.settingsContent,
  status: SETTINGS_CLASSES.settingsStatus,
  row: SETTINGS_CLASSES.settingRow,
  rowText: SETTINGS_CLASSES.settingRowText,
  rowControl: SETTINGS_CLASSES.settingRowControl,
  detailFields: SETTINGS_CLASSES.detailFields,
  badge: SETTINGS_CLASSES.badge,
  badgeLabel: SETTINGS_CLASSES.badgeLabel,
  hidden: SETTINGS_CLASSES.hidden,
  skeleton: SETTINGS_CLASSES.skeletonLine,
  settingPath: SETTINGS_CLASSES.settingPath,
  settingUnknown: SETTINGS_CLASSES.settingUnknown,
  attrCurrent: SETTINGS_ATTRS.current,
  attrChecked: SETTINGS_ATTRS.checked,
  attrDisabled: SETTINGS_ATTRS.disabled,
  attrBusy: SETTINGS_ATTRS.busy,
  attrDescribedBy: SETTINGS_ATTRS.describedBy,
  attrResult: SETTINGS_ATTRS.result,
  attrStatus: SETTINGS_ATTRS.status,
  attrBadge: SETTINGS_ATTRS.badge,
  attrStatusText: "data-status-text",
};

interface RNode {
  textContent: string | null;
  children: ArrayLike<RNode>;
  tagName: string;
  value?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
  cloneNode(deep: boolean): RNode;
  contains(other: RNode | null): boolean;
  matches(selector: string): boolean;
  remove(): void;
  focus(): void;
  click(): void;
  dispatchEvent(event: unknown): boolean;
  outerHTML: string;
  checked?: boolean;
  parentElement: RNode | null;
}

declare const Event: new (type: string, init?: object) => unknown;

declare const document: {
  activeElement: RNode | null;
  body: RNode;
  getElementById(id: string): RNode | null;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
};

declare const getComputedStyle: (node: RNode) => {
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
  display: string;
  visibility: string;
};

/**
 * Reads the Settings destination into plain data. SELF-CONTAINED (renderer function): no outer
 * variable, no call to another export, no named inner function; shared helpers are arrow functions
 * held in an array literal, because wdio's tsx loader compiles with keepNames and a nested named
 * function would call a `__name` helper the page does not have.
 */
export function rendererReadSettings(c: SettingsDomConfig): SettingsRead {
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
    // 2: the visible text of each paragraph below a node
    (n: RNode | null): string[] => {
      const out: string[] = [];
      if (n === null) return out;
      const found = n.querySelectorAll("p");
      for (let i = 0; i < found.length; i += 1) {
        const copy = (found[i] as RNode).cloneNode(true);
        const gone = copy.querySelectorAll(`.${c.hidden}`);
        for (let j = 0; j < gone.length; j += 1) (gone[j] as RNode).remove();
        const text = (copy.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text !== "") out.push(text);
      }
      return out;
    },
  ];
  const text = H[0] as (n: RNode | null) => string;
  const buttonsOf = H[1] as (n: RNode | null) => string[];
  const paragraphsOf = H[2] as (n: RNode | null) => string[];
  const root = document.querySelector(`.${c.root}`);
  if (root === null) {
    return {
      mounted: false,
      heading: "",
      description: "",
      statusLine: "",
      statusRole: null,
      nav: [],
      section: { heading: "", headingFocused: false, headingTabIndex: null },
      focus: null,
      facts: [],
      rows: [],
      buttons: [],
      inputs: 0,
      paths: [],
      results: [],
      subheads: [],
      paragraphs: [],
      statusTexts: [],
      text: "",
      busy: false,
    };
  }
  const header = root.querySelector(`.${c.header}`);
  const navNode = root.querySelector(`nav.${c.nav}`);
  const content = root.querySelector(`.${c.content}`);
  const statusNode = root.querySelector(`.${c.status}`);
  const frameHeading = header === null ? null : header.querySelector("h2");
  const description = header === null ? null : header.querySelector("p");
  const active = document.activeElement;

  const nav: SettingsNavRead[] = [];
  if (navNode !== null) {
    const items = navNode.querySelectorAll(`button.${c.navItem}`);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] as RNode;
      nav.push({
        label: text(item),
        current: item.getAttribute(c.attrCurrent) === "page",
        tabIndex: item.getAttribute("tabindex"),
        focused: active === item,
      });
    }
  }

  const sectionHeading = content === null ? null : content.querySelector("h3");
  let focus: SettingsFocusRead | null = null;
  if (active !== null && active !== document.body) {
    let visible = false;
    try {
      visible = active.matches(":focus-visible");
    } catch {
      visible = false;
    }
    const style = getComputedStyle(active);
    const label = active.getAttribute("aria-label");
    const own = text(active).slice(0, 120);
    focus = {
      tag: active.tagName.toLowerCase(),
      classes: active.getAttribute("class") ?? "",
      label:
        label !== null && label !== "" ? label : own !== "" ? own : active.tagName.toLowerCase(),
      inNav: navNode?.contains(active) === true,
      inContent: content?.contains(active) === true,
      inHeader: header?.contains(active) === true,
      inDestination: root.contains(active),
      isSectionHeading: sectionHeading !== null && sectionHeading === active,
      focusVisible: visible,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  }

  const facts: SettingsFactRead[] = [];
  const rows: SettingsRowRead[] = [];
  const buttons: SettingsButtonRead[] = [];
  const paths: string[] = [];
  const results: { key: string; text: string }[] = [];
  const subheads: string[] = [];
  const statusTexts: { id: string; text: string }[] = [];
  let inputs = 0;

  if (content !== null) {
    const lists = content.querySelectorAll(`dl.${c.detailFields}`);
    for (let l = 0; l < lists.length; l += 1) {
      const kids = (lists[l] as RNode).children;
      let name: string | null = null;
      for (let k = 0; k < kids.length; k += 1) {
        const kid = kids[k] as RNode;
        const tag = kid.tagName.toLowerCase();
        if (tag === "dt") {
          name = text(kid);
        } else if (tag === "dd" && name !== null) {
          const chips: SettingsChipRead[] = [];
          const chipNodes = kid.querySelectorAll(`.${c.badge}[${c.attrStatus}]`);
          for (let i = 0; i < chipNodes.length; i += 1) {
            const chip = chipNodes[i] as RNode;
            chips.push({
              status: chip.getAttribute(c.attrStatus),
              word: text(chip.querySelector(`.${c.badgeLabel}`)),
            });
          }
          const code: string[] = [];
          const codeNodes = kid.querySelectorAll("code");
          for (let i = 0; i < codeNodes.length; i += 1) code.push(text(codeNodes[i] as RNode));
          facts.push({
            name,
            text: text(kid),
            lines: paragraphsOf(kid),
            chips,
            stale: kid.querySelector(`[${c.attrBadge}="stale"]`) !== null,
            code,
            unknown: kid.querySelector(`.${c.settingUnknown}`) !== null,
            loading: kid.querySelector(`.${c.skeleton}`) !== null,
            buttons: buttonsOf(kid),
          });
          name = null;
        }
      }
    }

    const rowNodes = content.querySelectorAll(`.${c.row}`);
    for (let i = 0; i < rowNodes.length; i += 1) {
      const row = rowNodes[i] as RNode;
      const textBlock = row.querySelector(`.${c.rowText}`);
      const controlBlock = row.querySelector(`.${c.rowControl}`);
      const first =
        textBlock !== null && textBlock.children.length > 0
          ? (textBlock.children[0] as RNode)
          : null;
      const switchNode =
        controlBlock === null ? null : controlBlock.querySelector('[role="switch"]');
      const selectNode = controlBlock === null ? null : controlBlock.querySelector("select");
      const buttonNode = controlBlock === null ? null : controlBlock.querySelector("button");
      const node = switchNode ?? selectNode ?? buttonNode;
      const options: string[] = [];
      let selected = "";
      if (selectNode !== null) {
        const optionNodes = selectNode.querySelectorAll("option");
        for (let j = 0; j < optionNodes.length; j += 1) {
          const option = optionNodes[j] as RNode;
          options.push(text(option));
          if (option.value !== undefined && option.value === selectNode.value)
            selected = text(option);
        }
      }
      const described: string[] = [];
      const ids = node === null ? null : node.getAttribute(c.attrDescribedBy);
      if (ids !== null) {
        const parts = ids.split(/\s+/);
        for (let j = 0; j < parts.length; j += 1) {
          if (parts[j] === "") continue;
          const target = document.getElementById(parts[j] as string);
          if (target !== null) described.push(text(target));
        }
      }
      const rowResults: { key: string; text: string }[] = [];
      const resultNodes = row.querySelectorAll(`[${c.attrResult}]`);
      for (let j = 0; j < resultNodes.length; j += 1) {
        const result = resultNodes[j] as RNode;
        rowResults.push({ key: result.getAttribute(c.attrResult) ?? "", text: text(result) });
      }
      rows.push({
        name: text(first),
        paragraphs: paragraphsOf(textBlock),
        control: {
          kind:
            switchNode !== null
              ? "switch"
              : selectNode !== null
                ? "select"
                : buttonNode !== null
                  ? "button"
                  : "none",
          label: selectNode !== null ? selected : node === null ? "" : text(node),
          checked: switchNode === null ? null : switchNode.getAttribute(c.attrChecked) === "true",
          value: selectNode === null ? null : (selectNode.value ?? null),
          options,
          disabled:
            node !== null &&
            (node.getAttribute(c.attrDisabled) === "true" || node.hasAttribute("disabled")),
          busy: node !== null && node.getAttribute(c.attrBusy) === "true",
          describedText: described,
        },
        results: rowResults,
      });
    }

    const buttonNodes = content.querySelectorAll("button");
    for (let i = 0; i < buttonNodes.length; i += 1) {
      const button = buttonNodes[i] as RNode;
      buttons.push({
        label: text(button),
        name: button.getAttribute("aria-label"),
        disabled: button.getAttribute(c.attrDisabled) === "true" || button.hasAttribute("disabled"),
        busy: button.getAttribute(c.attrBusy) === "true",
      });
    }

    inputs = content.querySelectorAll("input, textarea").length;
    const pathNodes = content.querySelectorAll(`code.${c.settingPath}`);
    for (let i = 0; i < pathNodes.length; i += 1) paths.push(text(pathNodes[i] as RNode));
    const resultNodes = content.querySelectorAll(`[${c.attrResult}]`);
    for (let i = 0; i < resultNodes.length; i += 1) {
      const result = resultNodes[i] as RNode;
      results.push({ key: result.getAttribute(c.attrResult) ?? "", text: text(result) });
    }
    const headNodes = content.querySelectorAll("h4, h5");
    for (let i = 0; i < headNodes.length; i += 1) subheads.push(text(headNodes[i] as RNode));
    const statusNodes = content.querySelectorAll(`[${c.attrStatusText}]`);
    for (let i = 0; i < statusNodes.length; i += 1) {
      const node = statusNodes[i] as RNode;
      statusTexts.push({ id: node.getAttribute(c.attrStatusText) ?? "", text: text(node) });
    }
  }

  return {
    mounted: true,
    heading: text(frameHeading),
    description: text(description),
    statusLine: text(statusNode),
    statusRole: statusNode === null ? null : statusNode.getAttribute("role"),
    nav,
    section: {
      heading: text(sectionHeading),
      headingFocused: sectionHeading !== null && active === sectionHeading,
      headingTabIndex: sectionHeading === null ? null : sectionHeading.getAttribute("tabindex"),
    },
    focus,
    facts,
    rows,
    buttons,
    inputs,
    paths,
    results,
    subheads,
    paragraphs: paragraphsOf(content),
    statusTexts,
    text: text(content),
    busy: content !== null && content.querySelector(`[${c.attrBusy}="true"]`) !== null,
  };
}

/**
 * Puts keyboard focus on the nav item with the given label (the keyboard walks start from a nav
 * item; a programmatic focus on a nav button is enough, the arrow keys do the rest). Returns
 * whether focus landed. SELF-CONTAINED (renderer function).
 */
export function rendererFocusNavItem(navClass: string, itemClass: string, label: string): boolean {
  const items = document.querySelectorAll(`nav.${navClass} button.${itemClass}`);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as RNode;
    if ((item.textContent ?? "").replace(/\s+/g, " ").trim() === label) {
      item.focus();
      return document.activeElement === item;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reaching and reading the destination

/** The slice of the wdio browser the Settings helpers use. */
export interface SettingsBrowser extends HealthBrowser {
  keys(keys: string | string[]): Promise<unknown>;
}

export function asSettingsBrowser(browser: unknown): SettingsBrowser {
  return browser as SettingsBrowser;
}

type WaitOptions = Pick<PollOptions, "timeoutMs" | "intervalMs">;

/**
 * The clicks that reach one Settings section once the command center is open: the Settings tab,
 * then the section's nav item by its label.
 */
export function openSection(id: SettingsSectionKey): ClickStep[] {
  return [
    { selector: `#${SETTINGS_CLASSES.tabPrefix}${SETTINGS_TEXT.settingsTabId}`, text: null },
    {
      selector: `nav[aria-label="${SETTINGS_TEXT.navLabel}"] button.${SETTINGS_CLASSES.settingsNavItem}`,
      text: sectionLabel(id),
    },
  ];
}

export async function readSettings(browser: SettingsBrowser): Promise<SettingsRead> {
  return browser.execute(rendererReadSettings, SETTINGS_DOM_CONFIG);
}

/**
 * Waits until `check` finds nothing wrong with the destination. A timeout names the problems seen
 * last, so a failed run says what the page showed instead of only that a wait ended.
 */
export async function waitForSettings(
  browser: SettingsBrowser,
  check: (read: SettingsRead) => string[],
  describe: string,
  options: WaitOptions = { timeoutMs: 30_000, intervalMs: 500 },
): Promise<SettingsRead> {
  let last: string[] = ["the destination was never read"];
  try {
    return await pollUntil(
      async () => {
        const read = await readSettings(browser);
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

/** Presses each step in turn, waiting for its control to exist. */
export async function pressSteps(
  browser: SettingsBrowser,
  steps: readonly ClickStep[],
): Promise<void> {
  for (const step of steps) {
    await pollUntil(() => browser.executeObsidian(rendererClick, step.selector, step.text), {
      ...WAIT.short,
      describe: `the control ${step.text ?? step.selector}`,
    });
  }
}

/** The destination is on the page. */
export function checkMounted(read: SettingsRead): string[] {
  return read.mounted ? [] : ["the Settings destination is not on the page"];
}

/**
 * Opens the command center and presses the Settings tab, with no nav press: the destination shows
 * whichever section it was on. Focus is never moved by the opening itself (item 9).
 */
export async function openSettingsTab(
  browser: SettingsBrowser,
  options: WaitOptions = WAIT.connect,
): Promise<SettingsRead> {
  await browser.executeObsidianCommand(pluginCommandId("open-overview"));
  await pressSteps(browser, openSection("projects").slice(0, 1));
  return waitForSettings(browser, checkMounted, "the Settings destination to mount", options);
}

/**
 * Opens one section and waits until its nav item is current and its heading reads the label. The
 * nav press moves focus to the heading, which is what the keyboard walk relies on.
 */
export async function openSettingsSection(
  browser: SettingsBrowser,
  id: SettingsSectionKey,
  options: WaitOptions = WAIT.connect,
): Promise<SettingsRead> {
  await browser.executeObsidianCommand(pluginCommandId("open-overview"));
  await pressSteps(browser, openSection(id));
  const label = sectionLabel(id);
  return waitForSettings(
    browser,
    (read) => {
      if (!read.mounted) return checkMounted(read);
      const current = read.nav.find((item) => item.current)?.label;
      if (current !== label) return [`the current nav item is ${current ?? "none"}, not ${label}`];
      return read.section.heading === label
        ? []
        : [`the section heading reads "${read.section.heading}", not "${label}"`];
    },
    `the ${label} section to open`,
    options,
  );
}

// ---------------------------------------------------------------------------
// Item 9: the nav, the section headings and focus

/** The nav as the keyboard sees it: label, current item, the one tab stop, focus. */
export function readSettingsNav(read: SettingsRead): {
  readonly label: string;
  readonly current: boolean;
  readonly tabStop: boolean;
  readonly focused: boolean;
}[] {
  return read.nav.map((item) => ({
    label: item.label,
    current: item.current,
    tabStop: item.tabIndex === "0",
    focused: item.focused,
  }));
}

/**
 * The nav lists the nine sections in the fixed order, exactly one is current, and the nav is one
 * tab stop that sits on the current item (roving tabindex).
 */
export function checkNavigation(read: SettingsRead): string[] {
  if (!read.mounted) return ["the Settings destination is not on the page"];
  const problems: string[] = [];
  const nav = readSettingsNav(read);
  const labels = nav.map((item) => item.label);
  if (labels.length !== SETTINGS_SECTION_LABELS.length) {
    problems.push(`the nav lists ${labels.length} items, not nine`);
  } else if (labels.some((label, index) => label !== SETTINGS_SECTION_LABELS[index])) {
    const sameSet = [...labels].sort().join("|") === [...SETTINGS_SECTION_LABELS].sort().join("|");
    problems.push(
      sameSet
        ? "the nav items are not in the fixed order"
        : "the nav labels are not the nine section labels",
    );
  }
  const current = nav.filter((item) => item.current);
  if (current.length !== 1) problems.push(`${current.length} nav items are current, not one`);
  const stops = nav.filter((item) => item.tabStop);
  if (stops.length !== 1) problems.push(`the nav has ${stops.length} tab stops, not one`);
  else if (current.length === 1 && stops[0]?.label !== current[0]?.label) {
    problems.push("the nav tab stop is not on the current item");
  }
  return problems;
}

/** The section's heading reads `label` and holds keyboard focus (what Enter on a nav item does). */
export function checkSectionFocused(read: SettingsRead, label: string): string[] {
  if (read.section.heading !== label) {
    return [`the section heading reads "${read.section.heading}", not "${label}"`];
  }
  return read.section.headingFocused ? [] : [`the ${label} heading does not hold keyboard focus`];
}

/** Opening the Settings tab left focus outside the destination (it never moves focus into it). */
export function checkFocusNotMoved(read: SettingsRead): string[] {
  if (read.focus === null || !read.focus.inDestination) return [];
  const where = read.focus.inNav
    ? "the nav"
    : read.focus.isSectionHeading
      ? "a section heading"
      : "the destination";
  return [`focus moved into ${where} when the Settings tab opened`];
}

// ---------------------------------------------------------------------------
// Privacy: absolute paths, the run root, the home folder and the user name

export interface PathFacts {
  /** The sandbox run root. */
  readonly runRoot?: string | undefined;
  /** The macOS home folder. */
  readonly homeDir?: string | undefined;
  /** The macOS short user name. Names under four characters are too common to search for. */
  readonly userName?: string | undefined;
}

const MIN_USER_NAME_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The kinds of private location `text` names, by category only. A `/Users/` path counts unless its
 * user segment is one of the domain's documented placeholders (`USERNAME`, `you`, ...), so the
 * placeholder the register form shows is not a leak.
 */
export function findAbsolutePathProblems(text: string, facts: PathFacts = {}): string[] {
  const problems: string[] = [];
  const home = new RegExp(PRIVACY_RULES.homePath.source, "gi");
  for (const match of text.matchAll(home)) {
    let segment = match[0].slice("/Users/".length);
    if (segment.endsWith("/")) segment = segment.slice(0, -1);
    if (!(PRIVACY_RULES.homePath.placeholderSegments as readonly string[]).includes(segment)) {
      problems.push("a macOS home path");
      break;
    }
  }
  const linux = PRIVACY_RULES.pathShapes[0];
  if (linux !== undefined && new RegExp(linux).test(text)) problems.push("a Linux home path");
  const runRoot = facts.runRoot;
  if (runRoot !== undefined && runRoot !== "" && text.includes(runRoot)) {
    problems.push("the run root");
  }
  const homeDir = facts.homeDir;
  if (homeDir !== undefined && homeDir.length > 1 && text.includes(homeDir)) {
    problems.push("the home folder");
  }
  const userName = facts.userName;
  if (
    userName !== undefined &&
    userName.length >= MIN_USER_NAME_LENGTH &&
    new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(userName)}($|[^A-Za-z0-9])`, "i").test(text)
  ) {
    problems.push("the user name");
  }
  return problems;
}

/**
 * Throws when `text` names a private location. The message holds the categories, never the text,
 * so a failed run can be pasted without leaking anything.
 */
export function assertNoAbsolutePath(text: string, facts: PathFacts = {}): void {
  const problems = findAbsolutePathProblems(text, facts);
  if (problems.length > 0) {
    throw new Error(`The text names private locations: ${problems.join(", ")}.`);
  }
}

/** The ids of the nine sections, for a spec that walks them all. */
export const ALL_SECTIONS: readonly SettingsSectionKey[] = SETTINGS_SECTION_IDS;

// ===========================================================================
// Items 10 to 18 and 34: renderer helpers

/** A button to press: inside the scopes that match, optionally under a heading, the nth with this label. */
export interface PressTarget {
  readonly scope: string;
  /** The text of the scope's first `h3` or `h4`, or null for any scope. */
  readonly heading: string | null;
  /** The button's text or its `aria-label`. */
  readonly label: string;
  /** Zero-based among the buttons that match. */
  readonly nth: number;
}

/**
 * Presses the nth button with `label` in the scopes that match. Returns whether one was pressed.
 * SELF-CONTAINED (renderer function).
 */
export function rendererPressButton(target: PressTarget): boolean {
  const scopes = document.querySelectorAll(target.scope);
  let seen = 0;
  for (let i = 0; i < scopes.length; i += 1) {
    const scope = scopes[i] as RNode;
    if (target.heading !== null) {
      const head = scope.querySelector("h3, h4");
      if (head === null) continue;
      if ((head.textContent ?? "").replace(/\s+/g, " ").trim() !== target.heading) continue;
    }
    const buttons = scope.querySelectorAll("button");
    for (let j = 0; j < buttons.length; j += 1) {
      const node = buttons[j] as RNode;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text !== target.label && node.getAttribute("aria-label") !== target.label) continue;
      if (seen === target.nth) {
        node.click();
        return true;
      }
      seen += 1;
    }
  }
  return false;
}

/**
 * Types `value` into the field a `label` names, with the native setter and an `input` event so the
 * form's own handlers see an ordinary edit. SELF-CONTAINED (renderer function).
 */
export function rendererTypeByLabel(label: string, value: string): boolean {
  const labels = document.querySelectorAll("label");
  for (let i = 0; i < labels.length; i += 1) {
    const node = labels[i] as RNode;
    if ((node.textContent ?? "").replace(/\s+/g, " ").trim() !== label) continue;
    const id = node.getAttribute("for");
    if (id === null) return false;
    const input = document.getElementById(id);
    if (input === null) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (setter === undefined) return false;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}

/**
 * Chooses the option with the visible text `optionLabel` in the select of the setting row named
 * `rowName` and fires `change`, as a person choosing it would. SELF-CONTAINED (renderer function).
 */
export function rendererChooseOption(
  c: SettingsDomConfig,
  rowName: string,
  optionLabel: string,
): boolean {
  const rows = document.querySelectorAll(`.${c.row}`);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as RNode;
    const block = row.querySelector(`.${c.rowText}`);
    const first = block !== null && block.children.length > 0 ? (block.children[0] as RNode) : null;
    if (first === null) continue;
    if ((first.textContent ?? "").replace(/\s+/g, " ").trim() !== rowName) continue;
    const select = row.querySelector("select");
    if (select === null) return false;
    const options = select.querySelectorAll("option");
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j] as RNode;
      if ((option.textContent ?? "").replace(/\s+/g, " ").trim() === optionLabel) {
        select.value = option.value ?? "";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Presses the control (switch or button) of the setting row named `rowName`. SELF-CONTAINED
 * (renderer function).
 */
export function rendererPressRowControl(c: SettingsDomConfig, rowName: string): boolean {
  const rows = document.querySelectorAll(`.${c.row}`);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as RNode;
    const block = row.querySelector(`.${c.rowText}`);
    const first = block !== null && block.children.length > 0 ? (block.children[0] as RNode) : null;
    if (first === null) continue;
    if ((first.textContent ?? "").replace(/\s+/g, " ").trim() !== rowName) continue;
    const control = row.querySelector(`.${c.rowControl} button`);
    if (control === null) return false;
    control.click();
    return true;
  }
  return false;
}

/** The class and attribute names the extras reader needs. */
export interface SettingsExtrasConfig {
  readonly content: string;
  readonly scanRow: string;
  readonly displayPath: string;
  readonly listMeta: string;
  readonly panel: string;
  readonly panelTitle: string;
  readonly launchStatus: string;
  readonly projectCardName: string;
  readonly attrBadge: string;
  readonly attrDisabled: string;
}

export interface LauncherPanelRead {
  readonly title: string;
  /** `data-launcher-badge`: `not-set-up`, `set-up`, `tested` or `app-not-found`. */
  readonly badge: string | null;
  readonly buttons: readonly { readonly label: string; readonly disabled: boolean }[];
}

/** What the Projects and Launchers sections show beyond the generic reader. */
export interface SettingsExtras {
  /** Each scan folder row: its display path and first meta line. */
  readonly scanFolders: readonly { readonly path: string; readonly meta: string }[];
  readonly panels: readonly LauncherPanelRead[];
  /** `n of 3 launchers set up`, or empty. */
  readonly setUpLine: string;
  /** The app detection status line, or empty. */
  readonly detectLine: string;
  /** The names of the project cards on the Projects destination. */
  readonly projectCards: readonly string[];
}

export const SETTINGS_EXTRAS_CONFIG: SettingsExtrasConfig = {
  content: SETTINGS_CLASSES.settingsContent,
  scanRow: "ccc-scan-folder-row",
  displayPath: "ccc-display-path",
  listMeta: "ccc-list-meta",
  panel: "ccc-launcher-panel",
  panelTitle: "ccc-section-label",
  launchStatus: "ccc-launch-status",
  projectCardName: "ccc-project-card-name",
  attrBadge: "data-launcher-badge",
  attrDisabled: SETTINGS_ATTRS.disabled,
};

/** Reads scan folder rows, launcher panels and project cards. SELF-CONTAINED (renderer function). */
export function rendererReadExtras(c: SettingsExtrasConfig): SettingsExtras {
  const t = [
    (n: RNode | null): string =>
      n === null ? "" : (n.textContent ?? "").replace(/\s+/g, " ").trim(),
  ];
  const text = t[0] as (n: RNode | null) => string;
  const content = document.querySelector(`.${c.content}`);
  const scanFolders: { path: string; meta: string }[] = [];
  const panels: LauncherPanelRead[] = [];
  let setUpLine = "";
  let detectLine = "";
  if (content !== null) {
    const rows = content.querySelectorAll(`li.${c.scanRow}`);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] as RNode;
      scanFolders.push({
        path: text(row.querySelector(`.${c.displayPath}`)),
        meta: text(row.querySelector(`.${c.listMeta}`)),
      });
    }
    const found = content.querySelectorAll(`section.${c.panel}`);
    for (let i = 0; i < found.length; i += 1) {
      const panel = found[i] as RNode;
      const badge = panel.querySelector(`[${c.attrBadge}]`);
      const buttons: { label: string; disabled: boolean }[] = [];
      const nodes = panel.querySelectorAll("button");
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j] as RNode;
        buttons.push({ label: text(node), disabled: node.getAttribute(c.attrDisabled) === "true" });
      }
      panels.push({
        title: text(panel.querySelector(`.${c.panelTitle}`)),
        badge: badge === null ? null : badge.getAttribute(c.attrBadge),
        buttons,
      });
    }
    const metas = content.querySelectorAll(`.${c.listMeta}`);
    for (let i = 0; i < metas.length; i += 1) {
      const line = text(metas[i] as RNode);
      if (/launchers set up$/.test(line)) {
        setUpLine = line;
        break;
      }
    }
    detectLine = text(content.querySelector(`.${c.launchStatus}`));
  }
  const cards: string[] = [];
  const names = document.querySelectorAll(`.${c.projectCardName}`);
  for (let i = 0; i < names.length; i += 1) cards.push(text(names[i] as RNode));
  return { scanFolders, panels, setUpLine, detectLine, projectCards: cards };
}

/**
 * The markup of the Settings destination (capped), for the privacy scan only; it is searched and
 * never printed. SELF-CONTAINED (renderer function).
 */
export function rendererReadMarkup(rootClass: string): string {
  const root = document.querySelector(`.${rootClass}`);
  return root === null ? "" : root.outerHTML.slice(0, 500000);
}

/**
 * The controls Tab visits in a section, in document order: visible, not natively disabled, not
 * `tabindex="-1"`, and for a radio group the checked radio (or the first when none is checked).
 * SELF-CONTAINED (renderer function).
 */
export function rendererListFocusables(contentClass: string): { label: string; tag: string }[] {
  const out: { label: string; tag: string }[] = [];
  const content = document.querySelector(`.${contentClass}`);
  if (content === null) return out;
  const H = [
    (n: RNode): boolean => {
      let node: RNode | null = n;
      while (node !== null) {
        if (node.hasAttribute("hidden")) return false;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        node = node.parentElement;
      }
      return true;
    },
  ];
  const shown = H[0] as (n: RNode) => boolean;
  const radios = content.querySelectorAll('input[type="radio"]');
  const nodes = content.querySelectorAll("button, a[href], input, select, textarea, [tabindex]");
  const claimed: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i] as RNode;
    if (node.getAttribute("tabindex") === "-1" || node.hasAttribute("disabled")) continue;
    const type = node.getAttribute("type");
    if (type === "hidden" || !shown(node)) continue;
    if (type === "radio") {
      const name = node.getAttribute("name") ?? "";
      let groupHasChecked = false;
      for (let j = 0; j < radios.length; j += 1) {
        const other = radios[j] as RNode;
        if ((other.getAttribute("name") ?? "") === name && other.checked === true) {
          groupHasChecked = true;
        }
      }
      if (groupHasChecked ? node.checked !== true : claimed.includes(name)) continue;
      claimed.push(name);
    }
    const aria = node.getAttribute("aria-label");
    const own = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    out.push({
      label: aria !== null && aria !== "" ? aria : own !== "" ? own : node.tagName.toLowerCase(),
      tag: node.tagName.toLowerCase(),
    });
  }
  return out;
}

/** One stop of a keyboard walk: what holds focus and whether a ring shows. */
export interface FocusStop {
  readonly label: string;
  readonly tag: string;
  /** Focus is inside the section's content. */
  readonly inContent: boolean;
  readonly focusVisible: boolean;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly boxShadow: string;
}

/** The focused element as a tab stop, or null when nothing holds focus. SELF-CONTAINED (renderer function). */
export function rendererReadFocusStop(contentClass: string): FocusStop | null {
  const active = document.activeElement;
  if (active === null || active === document.body) return null;
  const content = document.querySelector(`.${contentClass}`);
  let visible = false;
  try {
    visible = active.matches(":focus-visible");
  } catch {
    visible = false;
  }
  const style = getComputedStyle(active);
  const aria = active.getAttribute("aria-label");
  const own = (active.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    label: aria !== null && aria !== "" ? aria : own !== "" ? own : active.tagName.toLowerCase(),
    tag: active.tagName.toLowerCase(),
    inContent: content?.contains(active) === true,
    focusVisible: visible,
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    boxShadow: style.boxShadow,
  };
}

// ---------------------------------------------------------------------------
// Driving the sections (every call that changes the sandbox is listed in
// SETTINGS_MUTATING_HELPERS and may only sit inside withRestore or withMode)

/** Presses a button (see {@link PressTarget}); waits for it to exist. */
export async function pressButton(
  browser: SettingsBrowser,
  target: PressTarget,
  options: WaitOptions = WAIT.short,
): Promise<void> {
  await pollUntil(() => browser.execute(rendererPressButton, target), {
    ...options,
    describe: `the button ${target.label}`,
  });
}

const CONTENT_SCOPE = `.${SETTINGS_CLASSES.settingsContent}`;

/** Types into the field a label names. */
export async function typeByLabel(
  browser: SettingsBrowser,
  label: string,
  value: string,
): Promise<void> {
  await pollUntil(() => browser.execute(rendererTypeByLabel, label, value), {
    ...WAIT.short,
    describe: `the field ${label}`,
  });
}

/** Chooses an option of a setting row's select (the Visual section's Reduced motion). */
export async function chooseOption(
  browser: SettingsBrowser,
  rowName: string,
  optionLabel: string,
): Promise<void> {
  await pollUntil(
    () => browser.execute(rendererChooseOption, SETTINGS_DOM_CONFIG, rowName, optionLabel),
    { ...WAIT.short, describe: `the option ${optionLabel} of ${rowName}` },
  );
}

/** Presses the control of a setting row: a switch, a send, a rebuild or a delete. */
export async function pressRowControl(browser: SettingsBrowser, rowName: string): Promise<void> {
  await pollUntil(() => browser.execute(rendererPressRowControl, SETTINGS_DOM_CONFIG, rowName), {
    ...WAIT.short,
    describe: `the control of ${rowName}`,
  });
}

export async function readExtras(browser: SettingsBrowser): Promise<SettingsExtras> {
  return browser.execute(rendererReadExtras, SETTINGS_EXTRAS_CONFIG);
}

export async function readMarkup(browser: SettingsBrowser): Promise<string> {
  return browser.execute(rendererReadMarkup, SETTINGS_CLASSES.settings);
}

export async function listFocusables(
  browser: SettingsBrowser,
): Promise<{ label: string; tag: string }[]> {
  return browser.execute(rendererListFocusables, SETTINGS_CLASSES.settingsContent);
}

/** Registers a folder through the Projects section's typed-path form. */
export async function registerFolder(browser: SettingsBrowser, path: string): Promise<void> {
  await pressButton(browser, {
    scope: CONTENT_SCOPE,
    heading: null,
    label: SETTINGS_TEXT.typePath,
    nth: 0,
  });
  await typeByLabel(browser, SETTINGS_TEXT.folderPath, path);
  await pressButton(browser, {
    scope: CONTENT_SCOPE,
    heading: null,
    label: SETTINGS_TEXT.registerFolder,
    nth: 0,
  });
}

/** Adds a scan folder through the Projects section's typed-path form. */
export async function addScanFolder(browser: SettingsBrowser, path: string): Promise<void> {
  await pressButton(browser, {
    scope: CONTENT_SCOPE,
    heading: null,
    label: SETTINGS_TEXT.typeScanPath,
    nth: 0,
  });
  await typeByLabel(browser, SETTINGS_TEXT.folderPath, path);
  await pressButton(browser, {
    scope: CONTENT_SCOPE,
    heading: null,
    label: SETTINGS_TEXT.addScanSubmit,
    nth: 0,
  });
}

/**
 * Saves the Claude Code launcher with a program path through the Launchers section: chooses
 * `Use a different path`, types the path and presses Save launcher in that panel. Saving only
 * stores the configuration; nothing is started.
 */
export async function saveClaudeLauncher(browser: SettingsBrowser, path: string): Promise<void> {
  const panel = { scope: "section.ccc-launcher-panel", heading: SETTINGS_TEXT.panelClaudeCode };
  await pollUntil(
    () =>
      browser.executeObsidian(
        rendererClick,
        "fieldset.ccc-radio-group label",
        SETTINGS_TEXT.useDifferentPath,
      ),
    { ...WAIT.short, describe: "the Use a different path choice" },
  );
  await typeByLabel(browser, SETTINGS_TEXT.pathToClaude, path);
  await pressButton(browser, { ...panel, label: SETTINGS_TEXT.saveLauncher, nth: 0 });
}

const TAB_KEY = "";

/**
 * Presses Tab from where focus is and records each stop until focus leaves the section's content.
 * Throws when it never leaves within `limit` presses (a focus trap or a runaway list).
 */
export async function walkTabStops(
  browser: Pick<SettingsBrowser, "keys" | "execute">,
  limit = 150,
): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  for (let press = 0; press < limit; press += 1) {
    await browser.keys(TAB_KEY);
    const stop = await browser.execute(rendererReadFocusStop, SETTINGS_CLASSES.settingsContent);
    if (stop === null || !stop.inContent) return stops;
    stops.push(stop);
  }
  throw new Error(`Keyboard focus never left the section within ${limit} Tab presses.`);
}

/** Every call that changes the sandbox from a Settings case: they sit inside withRestore or withMode. */
export const SETTINGS_MUTATING_HELPERS: readonly string[] = Object.freeze([
  ...MUTATING_HELPERS,
  "removeScanRoot",
  "addScanRoot",
  "saveLauncherConfig",
  "deleteUsageAnalytics",
  "chooseOption",
  "pressRowControl",
  "registerFolder",
  "addScanFolder",
  "saveClaudeLauncher",
  "restoreSystemMotion",
  "stopService",
  "startService",
  "sendTestApproval",
]);

declare const window: {
  matchMedia?: (query: string) => { matches: boolean };
};

/** Whether the operating system asks for reduced motion (then the full-motion baseline proves nothing). */
export function rendererOsPrefersReduced(): boolean {
  const query = window.matchMedia;
  return (
    typeof query === "function" && query.call(window, "(prefers-reduced-motion: reduce)").matches
  );
}

/** Where the plugin and the host the native tab reads hold reducedMotion, and what its file loads as. */
export interface PluginReducedMotion {
  readonly memory: unknown;
  readonly host: unknown;
  readonly saved: unknown;
}

interface PluginLike {
  settings?: { reducedMotion?: unknown };
  settingsHost?: { settings?: { reducedMotion?: unknown } };
  loadData?: () => Promise<unknown>;
}

/**
 * Reads reducedMotion from the plugin's own settings, from the `settingsHost` the native tab reads
 * it through, and from what `loadData` returns. SELF-CONTAINED (renderer function, first argument
 * is the Obsidian context).
 */
export async function rendererReadReducedMotion(
  ctx: { app?: { plugins?: { plugins?: Record<string, PluginLike | undefined> } } },
  pluginId: string,
): Promise<PluginReducedMotion> {
  const plugin = ctx.app?.plugins?.plugins?.[pluginId];
  const data = (await plugin?.loadData?.()) as { reducedMotion?: unknown } | null | undefined;
  return {
    memory: plugin?.settings?.reducedMotion,
    host: plugin?.settingsHost?.settings?.reducedMotion,
    saved: data?.reducedMotion,
  };
}

/**
 * Runs `fn` with Obsidian's body in the given base theme and puts the old one back. The theme
 * swap is a class on `body`; nothing is written to Obsidian's configuration.
 */
export async function withBase<T>(
  browser: { execute(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<unknown> },
  base: ObsidianBase,
  fn: () => Promise<T>,
): Promise<T> {
  const first = (await browser.execute(rendererSetBase, base)) as ThemeSwitch;
  try {
    return await fn();
  } finally {
    await browser.execute(rendererSetBase, first.was);
  }
}

/** The section has finished loading: it is mounted, nothing is busy and no value is a skeleton. */
export function checkSectionSettled(read: SettingsRead): string[] {
  if (!read.mounted) return ["the Settings destination is not on the page"];
  const problems: string[] = [];
  if (read.busy) problems.push("something in the section is still busy");
  const loading = read.facts.filter((fact) => fact.loading).map((fact) => fact.name);
  if (loading.length > 0) problems.push(`${loading.join(", ")} still loading`);
  return problems;
}

/** The Reduced motion select's visible choice, or an empty string when the row is not on the page. */
export function motionSelectOf(read: SettingsRead): string {
  return read.rows.find((row) => row.name === SETTINGS_TEXT.rowReducedMotion)?.control.label ?? "";
}

export interface RestoreMotionDeps {
  readonly open: () => Promise<unknown>;
  readonly read: () => Promise<SettingsRead>;
  readonly choose: (row: string, option: string) => Promise<void>;
}

/**
 * Puts Reduced motion back to System when it reads Always reduced, and does nothing otherwise. It
 * is the restore step of every case that changes the setting, and it is listed in
 * {@link SETTINGS_MUTATING_HELPERS} so a spec may call it only inside `withRestore`. Returns
 * whether it changed anything.
 */
export async function restoreSystemMotion(
  browser: SettingsBrowser,
  deps: RestoreMotionDeps = {
    open: () => openSettingsSection(browser, "visual"),
    read: () => readSettings(browser),
    choose: (row, option) => chooseOption(browser, row, option),
  },
): Promise<boolean> {
  await deps.open();
  if (motionSelectOf(await deps.read()) !== SETTINGS_TEXT.optionAlwaysReduced) return false;
  await deps.choose(SETTINGS_TEXT.rowReducedMotion, SETTINGS_TEXT.optionSystem);
  return true;
}

// ---------------------------------------------------------------------------
// The store and the plugin's data file (read only, copies and run-root guarded)

export interface ProjectStoreRows {
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly scanRoots: readonly { readonly id: string; readonly path: string }[];
}

export const PROJECT_ROWS_SQL =
  "select project_id, display_name from projects order by registered_at;";
export const SCAN_ROOT_ROWS_SQL = "select scan_root_id, path from scan_roots order by added_at;";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The registered projects and scan folders of the sandbox store, read from a copy inside the run root. */
export async function readProjectStore(context: RunContext): Promise<ProjectStoreRows> {
  const destDir = join(context.paths.tmpDir, "settings-store-copy");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const { copyPath } = copyStore({
    runtimeDir: context.paths.runtimeDir,
    destDir,
    runRoot: context.runRoot,
  });
  const projects = await queryStore({ copyPath, sql: PROJECT_ROWS_SQL, runRoot: context.runRoot });
  const roots = await queryStore({ copyPath, sql: SCAN_ROOT_ROWS_SQL, runRoot: context.runRoot });
  return {
    projects: projects.map((row) => ({
      id: str(row["project_id"]),
      name: str(row["display_name"]),
    })),
    scanRoots: roots.map((row) => ({ id: str(row["scan_root_id"]), path: str(row["path"]) })),
  };
}

const MSG_DATA_OUTSIDE = "Refusing a plugin data file outside the run root.";
const MSG_DATA_NOT_OBJECT = "The plugin data file is not a JSON object.";

/**
 * Reads the plugin's `data.json` from the sandbox vault. The path must resolve strictly inside the
 * run root (a link is followed and refused when it leads out), so the owner's own plugin file can
 * never be read. The message never echoes a path.
 */
export function readDataJson(path: string, runRoot: string): Record<string, unknown> {
  if (isSymlinkOnDisk(path)) throw new Error(MSG_PATH_LINK);
  const root = canonicalPath(runRoot);
  const target = canonicalPath(path);
  if (!isStrictlyInside(root, target)) throw new Error(MSG_DATA_OUTSIDE);
  const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(MSG_DATA_NOT_OBJECT);
  }
  return parsed as Record<string, unknown>;
}

/** The sorted key set of the sandbox plugin data file. */
export function dataJsonKeys(path: string, runRoot: string): string[] {
  return Object.keys(readDataJson(path, runRoot)).sort();
}

/** Where the sandbox vault keeps the plugin's data file. */
export function pluginDataFile(vaultPath: string, configDir: string): string {
  return join(vaultPath, configDir, "plugins", PLUGIN_ID, "data.json");
}

/** Exactly the four keys, with plain values (D-16): nothing else ever reaches the file. */
export function checkDataJson(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const expected = [...PLUGIN_DATA_KEYS].sort();
  for (const key of Object.keys(data).sort()) {
    if (!expected.includes(key)) problems.push(`the data file holds the key ${key}`);
  }
  for (const key of expected) {
    if (!(key in data)) problems.push(`the data file lacks the key ${key}`);
  }
  if (
    "reducedMotion" in data &&
    data["reducedMotion"] !== "auto" &&
    data["reducedMotion"] !== "reduced"
  ) {
    problems.push("reducedMotion holds an unknown value");
  }
  if ("notifyApprovals" in data && typeof data["notifyApprovals"] !== "boolean") {
    problems.push("notifyApprovals is not a boolean");
  }
  if ("socketPathOverride" in data && typeof data["socketPathOverride"] !== "string") {
    problems.push("socketPathOverride is not text");
  }
  if ("lastOpenedDestination" in data && typeof data["lastOpenedDestination"] !== "string") {
    problems.push("lastOpenedDestination is not text");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The service log

export interface LogFacts {
  readonly runRoot: string;
  readonly homeDir: string;
  readonly userName: string;
  readonly projectNames: readonly string[];
}

/** The credential shapes the log must never hold: the domain's prefixed forms and a Bearer value. */
const LOG_TOKEN_SHAPES: readonly RegExp[] = [
  ...PRIVACY_RULES.tokenShapes.slice(0, 8).map((source) => new RegExp(source)),
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,
];

const HOME_PATH_RULE = new RegExp(PRIVACY_RULES.homePath.source, "gi");

function lineHasHomePath(line: string, homeDir: string): boolean {
  for (const match of line.matchAll(HOME_PATH_RULE)) {
    let segment = match[0].slice("/Users/".length);
    if (segment.endsWith("/")) segment = segment.slice(0, -1);
    if (!(PRIVACY_RULES.homePath.placeholderSegments as readonly string[]).includes(segment)) {
      return true;
    }
  }
  const linux = PRIVACY_RULES.pathShapes[0];
  if (linux !== undefined && new RegExp(linux).test(line)) return true;
  return homeDir.length > 1 && line.includes(homeDir);
}

/**
 * Counts, by category, the log lines that hold a home path, the run root (the startup line that
 * names the socket is exempt), a registered project's name or a credential-shaped string. A UUID
 * or a plain hash is an identifier, not a credential, and is not counted. The result holds
 * categories and counts only, never the text.
 */
export function scanLogForPrivateText(log: string, facts: LogFacts): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (category: string): void => {
    counts[category] = (counts[category] ?? 0) + 1;
  };
  const names = facts.projectNames.filter((name) => name !== "").map((name) => name.toLowerCase());
  for (const line of log.split("\n")) {
    if (line.trim() === "") continue;
    if (lineHasHomePath(line, facts.homeDir)) bump("home path");
    if (
      facts.runRoot !== "" &&
      line.includes(facts.runRoot) &&
      !line.includes('"msg":"listening"')
    ) {
      bump("run root");
    }
    const lowered = line.toLowerCase();
    if (names.some((name) => lowered.includes(name))) bump("project name");
    if (LOG_TOKEN_SHAPES.some((shape) => shape.test(line))) bump("token shape");
  }
  return counts;
}

/** The findings of a log scan as lines a failure can print: categories and counts, no text. */
export function describeLogScan(found: Record<string, number>): string[] {
  return Object.entries(found).map(
    ([category, count]) => `the log holds ${count} ${category} line${count === 1 ? "" : "s"}`,
  );
}

// ---------------------------------------------------------------------------
// Item 10: a registered project and a scan folder

export function checkRegistered(input: {
  readonly statusLine: string;
  readonly name: string;
  readonly storeNames: readonly string[];
  readonly cardNames: readonly string[];
}): string[] {
  const problems: string[] = [];
  const expected = `${SETTINGS_TEXT.registeredPrefix}${input.name}.`;
  if (input.statusLine !== expected) {
    problems.push(`the status line reads "${input.statusLine}", not "${expected}"`);
  }
  if (!input.storeNames.includes(input.name))
    problems.push("the store holds no project with that name");
  if (!input.cardNames.includes(input.name)) {
    problems.push("the Projects destination shows no card for it");
  }
  return problems;
}

export function checkScanFolderListed(input: {
  readonly rows: readonly { readonly path: string; readonly meta: string }[];
  readonly folderName: string;
  readonly storeRoots: number;
}): string[] {
  const problems: string[] = [];
  if (!input.rows.some((row) => row.path.endsWith(input.folderName))) {
    problems.push("no scan folder row names the folder that was added");
  }
  if (input.rows.some((row) => row.path.startsWith("/"))) {
    problems.push("a scan folder row shows an absolute path");
  }
  if (input.storeRoots < 1) problems.push("the store holds no scan folder");
  return problems;
}

// ---------------------------------------------------------------------------
// Item 11: the launchers

const CONFIGURABLE_PANELS: readonly string[] = [
  SETTINGS_TEXT.panelAntigravity,
  SETTINGS_TEXT.panelClaudeCode,
  SETTINGS_TEXT.panelClaudeDesktop,
];

/** The three configurable panels are there, with a set-up count and a finished detection. */
export function checkLaunchersListed(extras: SettingsExtras): string[] {
  const problems: string[] = [];
  for (const title of CONFIGURABLE_PANELS) {
    if (!extras.panels.some((panel) => panel.title === title)) {
      problems.push(`the ${title} launcher panel is missing`);
    }
  }
  if (!/^\d of 3 launchers set up$/.test(extras.setUpLine)) {
    problems.push("the set-up count line is missing");
  }
  if (extras.detectLine.includes(SETTINGS_TEXT.detectFailed)) {
    problems.push("the app detection failed");
  } else if (!extras.detectLine.startsWith(SETTINGS_TEXT.detectedPrefix)) {
    problems.push("the app detection has not finished");
  }
  return problems;
}

/** A saved launcher reads Set up and the count says one of three. */
export function checkLauncherSaved(extras: SettingsExtras, title: string): string[] {
  const problems: string[] = [];
  const panel = extras.panels.find((entry) => entry.title === title);
  if (panel === undefined) return [`the ${title} launcher panel is missing`];
  if (panel.badge !== "set-up") problems.push(`the ${title} panel does not read Set up`);
  if (!extras.setUpLine.startsWith("1 of 3")) {
    problems.push(`the set-up count reads "${extras.setUpLine}", not 1 of 3`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Item 12: Paths

const PATH_FACTS: readonly string[] = [
  SETTINGS_TEXT.factManagedVault,
  SETTINGS_TEXT.factDataFolder,
  SETTINGS_TEXT.factSocket,
];

/** Three read-only display paths, none Unknown or loading, no input, nothing absolute. */
export function checkPaths(read: SettingsRead): string[] {
  const problems: string[] = [];
  for (const name of PATH_FACTS) {
    const entry = read.facts.find((fact) => fact.name === name);
    if (entry === undefined) {
      problems.push(`the ${name} value is missing`);
      continue;
    }
    if (entry.loading) problems.push(`${name} is still loading`);
    else if (entry.unknown) problems.push(`${name} reads Unknown`);
    else if (entry.code.length !== 1)
      problems.push(`${name} shows ${entry.code.length} paths, not one`);
    else if (!/^(~\/|…\/)/.test(entry.code[0] as string)) {
      problems.push(`${name} is not a display path`);
    }
  }
  if (read.inputs > 0) {
    problems.push(
      `the section holds ${read.inputs} input${read.inputs === 1 ? "" : "s"}, but paths are read-only text`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Item 14: Security and Schedules

const SECURITY_FACTS: readonly string[] = [
  SETTINGS_TEXT.factServiceConnection,
  SETTINGS_TEXT.factNetworkListener,
  SETTINGS_TEXT.factConnectionTokens,
  SETTINGS_TEXT.factInstallSecret,
  SETTINGS_TEXT.factResearchKey,
  SETTINGS_TEXT.factAlwaysAllow,
];

/** The six facts, the install secret present and the research key honestly Present, Needs setup or Unknown. */
export function checkSecurityFacts(read: SettingsRead): string[] {
  const problems: string[] = [];
  const byName = (name: string): SettingsFactRead | undefined =>
    read.facts.find((fact) => fact.name === name);
  for (const name of SECURITY_FACTS) {
    if (byName(name) === undefined) problems.push(`the ${name} fact is missing`);
  }
  const expectText: [string, string][] = [
    [SETTINGS_TEXT.factServiceConnection, SETTINGS_TEXT.securityConnection],
    [SETTINGS_TEXT.factNetworkListener, SETTINGS_TEXT.securityNetwork],
    [SETTINGS_TEXT.factConnectionTokens, `${SETTINGS_TEXT.securityTokens} 1 hour`],
    [SETTINGS_TEXT.factAlwaysAllow, SETTINGS_TEXT.securityAlways],
  ];
  for (const [name, wanted] of expectText) {
    const entry = byName(name);
    if (entry !== undefined && !entry.text.startsWith(wanted)) {
      problems.push(`the ${name} fact does not read "${wanted}"`);
    }
  }
  const install = byName(SETTINGS_TEXT.factInstallSecret);
  if (install !== undefined) {
    const word = install.loading ? "loading" : (install.chips[0]?.word ?? "no chip");
    if (word !== SETTINGS_TEXT.chipPresent) {
      problems.push(`the Install secret chip reads "${word}", not Present`);
    }
  }
  const research = byName(SETTINGS_TEXT.factResearchKey);
  if (research !== undefined) {
    const word = research.loading ? "loading" : (research.chips[0]?.word ?? "no chip");
    const honest: readonly string[] = [
      SETTINGS_TEXT.chipPresent,
      SETTINGS_TEXT.chipNeedsSetup,
      SETTINGS_TEXT.chipUnknown,
    ];
    if (!honest.includes(word)) problems.push(`the Research key chip reads "${word}"`);
  }
  return problems;
}

const CREDENTIAL_CONTROL: readonly RegExp[] = [
  /\b(store|rotate|set|save|add|replace|clear|revoke|reset|delete|remove)\b.*\b(key|secret|token|credential|password)\b/i,
  /\balways allow\b|\ballow always\b|\bremember (this|my)\b|\btrust forever\b/i,
];

/** No button stores, rotates or deletes a credential or allows anything always, and no input exists. */
export function checkNoCredentialControl(read: SettingsRead): string[] {
  const problems: string[] = [];
  for (const entry of read.buttons) {
    const label = entry.name ?? entry.label;
    if (CREDENTIAL_CONTROL.some((rule) => rule.test(label))) {
      problems.push(`a control named "${label}" would change a credential`);
    }
  }
  if (read.inputs > 0)
    problems.push(`the section holds ${read.inputs} input(s) where none belongs`);
  return problems;
}

/** What the service says its research is configured with: the count and the hosts in order. */
export interface ConfiguredSources {
  readonly count: number;
  readonly hosts: readonly string[];
}

/** Schedules says runs are manual, lists the sources the service reports and offers no timer. */
export function checkSchedules(read: SettingsRead, configured?: ConfiguredSources): string[] {
  const problems: string[] = [];
  const byName = (name: string): SettingsFactRead | undefined =>
    read.facts.find((fact) => fact.name === name);
  for (const name of [
    SETTINGS_TEXT.factTopic,
    SETTINGS_TEXT.factSources,
    SETTINGS_TEXT.factScheduling,
  ]) {
    if (byName(name) === undefined) problems.push(`the ${name} fact is missing`);
  }
  const scheduling = byName(SETTINGS_TEXT.factScheduling);
  if (scheduling !== undefined && scheduling.text !== SETTINGS_TEXT.manualOnly) {
    problems.push(`the Scheduling fact does not read "${SETTINGS_TEXT.manualOnly}"`);
  }
  const sources = byName(SETTINGS_TEXT.factSources);
  if (sources !== undefined) {
    const stated = /^(\d+) sources? configured$/.exec(sources.lines[0] ?? "");
    if (stated === null) problems.push("the Sources fact does not state how many are configured");
    else if (configured !== undefined) {
      if (Number(stated[1]) !== configured.count) {
        problems.push(`Sources says ${stated[1]} configured, the service has ${configured.count}`);
      }
      if (sources.code.join("|") !== configured.hosts.join("|")) {
        problems.push("Sources lists different hosts than the service reports");
      }
      if (configured.count === 0 && !sources.lines.includes(SETTINGS_TEXT.noSources)) {
        problems.push("Sources does not say that no source is configured");
      }
    }
  }
  for (const entry of read.buttons) {
    if (entry.label !== SETTINGS_TEXT.openResearchView) {
      problems.push(`a control named "${entry.label}" would schedule or run something`);
    }
  }
  if (read.inputs > 0)
    problems.push(`the section holds ${read.inputs} input(s) where none belongs`);
  if (read.rows.length > 0) problems.push("the section holds a setting row where none belongs");
  return problems;
}

// ---------------------------------------------------------------------------
// Items 13 and 34: reduced motion

export interface ReducedMotionInput {
  readonly osPrefersReduced: boolean;
  readonly baselineRoot: string | null;
  readonly reducedRoot: string | null;
  readonly restoredRoot: string | null;
  readonly baselineSamples: readonly MotionSample[];
  readonly reducedSamples: readonly MotionSample[];
  readonly selectAfterReduced: string | null;
  readonly selectAfterSystem: string | null;
  readonly savedAfterReduced: unknown;
  readonly savedAfterSystem: unknown;
}

/**
 * Always reduced applies at once (the root and every sampled transition stop) and persists; System
 * restores. When the operating system already asks for reduced motion the baseline proves nothing
 * and is not judged.
 */
export function checkReducedMotion(input: ReducedMotionInput): string[] {
  const problems: string[] = [];
  if (!input.osPrefersReduced) {
    if (input.baselineRoot !== "full") {
      problems.push(`the baseline root is ${input.baselineRoot ?? "missing"}, not full`);
    }
    if (!anyMotionOn(input.baselineSamples)) {
      problems.push("the full-motion baseline shows no motion, so the reduced run proves nothing");
    }
  }
  if (input.reducedRoot !== "reduced") {
    problems.push("the command center root is not in reduced motion");
  }
  if (!allMotionOff(input.reducedSamples))
    problems.push("something still moves under reduced motion");
  if (input.selectAfterReduced !== SETTINGS_TEXT.optionAlwaysReduced) {
    problems.push(`the select reads "${input.selectAfterReduced}" after choosing Always reduced`);
  }
  if (input.savedAfterReduced !== "reduced") {
    problems.push(`the data file holds ${String(input.savedAfterReduced)} after Always reduced`);
  }
  if (input.selectAfterSystem !== SETTINGS_TEXT.optionSystem) {
    problems.push(`the select reads "${input.selectAfterSystem}" after choosing System`);
  }
  if (input.savedAfterSystem !== "auto") {
    problems.push(`the data file holds ${String(input.savedAfterSystem)} after System`);
  }
  if (input.restoredRoot !== input.baselineRoot) {
    problems.push(
      `the restored root is ${input.restoredRoot ?? "missing"}, not ${input.baselineRoot ?? "missing"}`,
    );
  }
  return problems;
}

/** The value the Visual section wrote, as the plugin, the native tab's host and the files hold it. */
export interface ReducedMotionHolders {
  readonly memory: unknown;
  readonly host: unknown;
  readonly saved: unknown;
  readonly disk: unknown;
}

export function checkSameReducedMotion(held: ReducedMotionHolders, expected: string): string[] {
  const problems: string[] = [];
  const check = (value: unknown, where: string): void => {
    if (value !== expected) problems.push(`${where} holds ${String(value)}, not ${expected}`);
  };
  check(held.memory, "the plugin's settings");
  check(held.host, "the native tab's host");
  check(held.saved, "the loaded data");
  check(held.disk, "the data file");
  return problems;
}

// ---------------------------------------------------------------------------
// Item 15: the service stopped

/** The status rows of Integrations, by their `data-status-text` id. */
const STATUS_ROWS: readonly string[] = [
  "claude-hooks",
  "claude-statusline",
  "codex-hooks",
  "codex-bridge",
];

function factOf(read: SettingsRead, name: string): SettingsFactRead | undefined {
  return read.facts.find((fact) => fact.name === name);
}

function rowOf(read: SettingsRead, name: string): SettingsRowRead | undefined {
  return read.rows.find((row) => row.name === name);
}

/** A service-owned value reads Unknown, with the service-away reason, and shows no value. */
function serviceValueAway(read: SettingsRead, name: string): string[] {
  const entry = factOf(read, name);
  if (entry === undefined) return [`the ${name} value is missing`];
  const problems: string[] = [];
  if (!entry.unknown) problems.push(`${name} does not read Unknown`);
  if (
    entry.code.length > 0 ||
    entry.chips.some((chip) => chip.word === SETTINGS_TEXT.chipPresent)
  ) {
    problems.push(`${name} still shows a last value`);
  }
  if (!entry.lines.includes(SETTINGS_TEXT.serviceAway)) {
    problems.push(`${name} does not say why it is Unknown`);
  }
  return problems;
}

/** A row's control is inert (`aria-disabled`) and described by the service-away reason. */
function inertWithReason(read: SettingsRead, name: string): string[] {
  const entry = rowOf(read, name);
  if (entry === undefined) return [`the ${name} row is missing`];
  const problems: string[] = [];
  if (!entry.control.disabled) problems.push(`the ${name} control is not aria-disabled`);
  if (!entry.control.describedText.includes(SETTINGS_TEXT.serviceAway)) {
    problems.push(`the ${name} control is not described by the service-away reason`);
  }
  return problems;
}

/**
 * What one section shows with the service stopped (D-03): service-bound controls `aria-disabled`
 * with a visible reason, no last-good value as current, and the copy actions and the Visual select
 * still enabled. Diagnostics is item 23's and has no verdict here.
 */
export function checkServiceAway(id: SettingsSectionKey, read: SettingsRead): string[] {
  const problems: string[] = [];
  switch (id) {
    case "projects": {
      for (const wanted of [SETTINGS_TEXT.serviceOwnedAway, SETTINGS_TEXT.serviceAway]) {
        if (!read.paragraphs.includes(wanted)) problems.push("the away note or reason is missing");
      }
      for (const label of [
        SETTINGS_TEXT.registerOpen,
        SETTINGS_TEXT.typePath,
        SETTINGS_TEXT.addScanOpen,
      ]) {
        const found = read.buttons.filter((entry) => entry.label === label);
        if (found.length === 0) problems.push(`the ${label} control is missing`);
        else if (found.some((entry) => !entry.disabled)) {
          problems.push(`the ${label} control is not aria-disabled`);
        }
      }
      break;
    }
    case "launchers": {
      if (!read.paragraphs.includes(SETTINGS_TEXT.launcherBanner)) {
        problems.push("the disconnected banner is missing");
      }
      const detect = read.buttons.find((entry) => entry.label === SETTINGS_TEXT.detectApps);
      if (detect === undefined || !detect.disabled) {
        problems.push(`the ${SETTINGS_TEXT.detectApps} control is not aria-disabled`);
      }
      break;
    }
    case "integrations": {
      for (const statusId of STATUS_ROWS) {
        const entry = read.statusTexts.find((status) => status.id === statusId);
        if (entry?.text !== SETTINGS_TEXT.statusUnavailable) {
          problems.push(`${statusId} does not read the unavailable sentence`);
        }
      }
      const copies = read.buttons.filter((entry) => entry.label.startsWith("Copy "));
      if (copies.length === 0) problems.push("no copy button is offered");
      for (const entry of copies) {
        if (entry.disabled) problems.push(`the ${entry.label} control is disabled`);
      }
      break;
    }
    case "approvals-tasks": {
      const prefs = rowOf(read, SETTINGS_TEXT.rowNotifyApprovals);
      if (prefs === undefined)
        problems.push(`the ${SETTINGS_TEXT.rowNotifyApprovals} row is missing`);
      else if (prefs.control.disabled) {
        problems.push(`the ${SETTINGS_TEXT.rowNotifyApprovals} switch is disabled`);
      }
      problems.push(...inertWithReason(read, SETTINGS_TEXT.rowSendTest));
      problems.push(...inertWithReason(read, SETTINGS_TEXT.rowRebuild));
      break;
    }
    case "paths": {
      problems.push(...serviceValueAway(read, SETTINGS_TEXT.factManagedVault));
      problems.push(...serviceValueAway(read, SETTINGS_TEXT.factDataFolder));
      if ((factOf(read, SETTINGS_TEXT.factSocket)?.code.length ?? 0) !== 1) {
        problems.push("the Service socket is not shown");
      }
      break;
    }
    case "visual": {
      const motion = rowOf(read, SETTINGS_TEXT.rowReducedMotion);
      if (motion === undefined)
        problems.push(`the ${SETTINGS_TEXT.rowReducedMotion} row is missing`);
      else if (motion.control.disabled) {
        problems.push(`the ${SETTINGS_TEXT.rowReducedMotion} select is disabled`);
      }
      break;
    }
    case "security": {
      for (const name of [SETTINGS_TEXT.factInstallSecret, SETTINGS_TEXT.factResearchKey]) {
        const entry = factOf(read, name);
        if (entry === undefined) {
          problems.push(`the ${name} fact is missing`);
          continue;
        }
        if (entry.chips.some((chip) => chip.word === SETTINGS_TEXT.chipPresent)) {
          problems.push(`${name} still reads Present`);
        }
        if (entry.chips[0]?.word !== SETTINGS_TEXT.chipUnknown) {
          problems.push(`${name} does not read Unknown`);
        }
        if (!entry.lines.includes(SETTINGS_TEXT.serviceAway)) {
          problems.push(`${name} does not say why it is Unknown`);
        }
      }
      problems.push(...inertWithReason(read, SETTINGS_TEXT.rowTranscript));
      problems.push(...inertWithReason(read, SETTINGS_TEXT.rowDeleteUsage));
      break;
    }
    case "schedules": {
      problems.push(...serviceValueAway(read, SETTINGS_TEXT.factTopic));
      problems.push(...serviceValueAway(read, SETTINGS_TEXT.factSources));
      break;
    }
    case "diagnostics":
      break;
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Item 16: the keyboard walk

/**
 * Every control of the section is a tab stop in document order and shows a visible focus ring
 * (`:focus-visible` with an outline or a box shadow); the nav stop reached with Shift+Tab does too.
 */
export function checkKeyboardWalk(
  section: string,
  stops: readonly FocusStop[],
  expected: readonly { readonly label: string; readonly tag: string }[],
  nav?: FocusStop | null,
): string[] {
  const problems: string[] = [];
  if (stops.length !== expected.length) {
    problems.push(`${section}: ${stops.length} tab stops for ${expected.length} controls`);
  } else {
    stops.forEach((stop, index) => {
      const wanted = expected[index];
      if (wanted !== undefined && stop.label !== wanted.label) {
        problems.push(`${section}: stop ${index} is ${stop.label}, expected ${wanted.label}`);
      }
    });
  }
  for (const stop of stops) {
    if (!stop.focusVisible || !focusRingVisible(stop)) {
      problems.push(`${section}: ${stop.label} shows no focus ring`);
    }
  }
  if (nav !== undefined && nav !== null && (!nav.focusVisible || !focusRingVisible(nav))) {
    problems.push(`${section}: the nav item ${nav.label} shows no focus ring`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Item 17: contrast

const SECTION_CONTROL_WORD: Readonly<Record<SettingsSectionKey, string>> = {
  projects: SETTINGS_TEXT.registerOpen,
  launchers: SETTINGS_TEXT.detectApps,
  integrations: SETTINGS_TEXT.copyInstall,
  "approvals-tasks": SETTINGS_TEXT.rowSendTest,
  paths: SETTINGS_TEXT.factManagedVault,
  visual: SETTINGS_TEXT.rowReducedMotion,
  security: SETTINGS_TEXT.rowTranscript,
  schedules: SETTINGS_TEXT.manualOnly,
  diagnostics: "Run checks again",
};

/** The lower-case words a section's reading must have measured: its heading and one control. */
export function contrastSubjects(id: SettingsSectionKey): string[] {
  return [sectionLabel(id), SECTION_CONTROL_WORD[id]].map((word) => word.toLowerCase());
}

/** The cards the Overview slice's reading must have measured. */
export const OVERVIEW_CONTRAST_SUBJECTS: readonly string[] = Object.freeze(
  [
    OVERVIEW_TEXT.todayTitle,
    OVERVIEW_TEXT.techIntelTitle,
    OVERVIEW_TEXT.projectShortcutsTitle,
    OVERVIEW_TEXT.activeSessionsTitle,
  ].map((title) => title.toLowerCase()),
);

/** One theme's reading of one subject: unreadable colours, unmeasured subjects and ratios under their floors. */
export function checkContrastReading(
  subject: string,
  reading: ThemeReading,
  subjects: readonly string[],
): string[] {
  const where = `${subject} ${reading.base}`;
  const problems = reading.problems.map((line) => `${where}: ${line}`);
  for (const wanted of subjects) {
    if (!reading.texts.some((text) => text.toLowerCase().includes(wanted))) {
      problems.push(`${where}: "${wanted}" was not measured`);
    }
  }
  for (const line of contrastFailures(reading.measured)) problems.push(`${where}: ${line}`);
  return problems;
}
