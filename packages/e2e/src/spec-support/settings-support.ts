import { PRIVACY_RULES } from "@ccc/domain";
import { type PollOptions, pollUntil } from "../driver.js";
import type { ClickStep, HealthBrowser } from "./health-support.js";
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
}

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
