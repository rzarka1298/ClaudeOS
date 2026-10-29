import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DriverBrowser, pollUntil } from "../driver.js";
import { APPROVALS_COPY } from "./approvals-copy.js";
import { HEALTH_ATTRS, HEALTH_CLASSES } from "./health-copy.js";
import { OVERVIEW_CLASSES, OVERVIEW_TEXT } from "./overview-copy.js";
import { SETTINGS_TEXT } from "./settings-copy.js";
import { applyWindowBounds, type RectLite, readWindowFacts } from "./shot-layout.js";
import { WAIT } from "./tasks-support.js";

/**
 * Support for the Phase 9 hardening spec (plan 09-21, D-17): the renderer reader of the quiet
 * session rows (Agent runs and the Active sessions card), the pure verdicts over what it reads, and
 * the hook record builder for the synthetic session's later events. Everything here runs spec side
 * except the renderer function, which wdio serialises and evaluates inside Obsidian.
 *
 * Nothing in this module reaches the owner's desktop, store, vault, Keychain, presence helper or
 * launchd: it reads the page and builds records the sandbox hook sends to the sandbox service.
 * Failure messages name a session or a state word, never a path.
 */

// ---------------------------------------------------------------------------
// The words the quiet items assert (mirrors of packages/domain/src/session.ts and the plugin views)

export const QUIET_TEXT = {
  /** `⋯ Idle — last event …`: a running session whose last signal was idle and is old. */
  idlePrefix: "⋯ Idle — last event",
  /** `⋯ No events for …`: a running session that said it was working, then went quiet. */
  silentPrefix: "⋯ No events for",
  /** The glyph and label of a plain running session. */
  runningPrefix: "▸ Running",
  quietGlyph: "⋯",
  runningGlyph: "▸",
  /** The caption segment (`1 quiet`) both the Agent runs line and the card caption carry. */
  quietSegment: "quiet",
} as const;

/** Where each mirrored word lives, so a drift test can read the owner as text. */
export const QUIET_TEXT_OWNERS: readonly { readonly text: string; readonly file: string }[] = [
  { text: "Idle — last event", file: "packages/domain/src/session.ts" },
  { text: "No events for", file: "packages/domain/src/session.ts" },
  { text: 'QUIET_RUN_GLYPH = "⋯"', file: "packages/domain/src/session.ts" },
  { text: 'label: "Running", glyph: "▸"', file: "packages/domain/src/session.ts" },
  { text: "quiet", file: "packages/plugin/src/view/agent-runs.tsx" },
  { text: "ccc-kpi-number", file: "packages/plugin/src/widgets/frame.tsx" },
  { text: "ccc-hero-caption", file: "packages/plugin/src/widgets/frame.tsx" },
  { text: "ccc-session-row-link", file: "packages/plugin/src/view/agent-runs.tsx" },
  { text: "ccc-agent-runs-table", file: "packages/plugin/src/view/agent-runs.tsx" },
  { text: "ccc-connection-status", file: "packages/plugin/src/view/shell.tsx" },
  { text: "ccc-status-text", file: "packages/plugin/src/view/shell.tsx" },
  { text: "Disconnected — ", file: "packages/plugin/src/view/shell.tsx" },
  {
    text: "This is a test service, which never starts the presence helper.",
    file: "packages/plugin/src/view/settings-security.tsx",
  },
  { text: "ccc-settings-section-title", file: "packages/plugin/src/view/launchers-settings.tsx" },
];

export interface QuietDomConfig {
  readonly agentRuns: string;
  readonly sessionRow: string;
  readonly rowLink: string;
  readonly stateBody: string;
  readonly card: string;
  readonly cardTitle: string;
  readonly heroNumeral: string;
  readonly heroCaption: string;
  readonly listRow: string;
  readonly listPrimary: string;
  readonly listMeta: string;
  readonly hidden: string;
}

export const QUIET_DOM_CONFIG: QuietDomConfig = {
  agentRuns: "ccc-agent-runs",
  sessionRow: "ccc-agent-runs-table",
  rowLink: "ccc-session-row-link",
  stateBody: "ccc-state-body",
  card: OVERVIEW_CLASSES.card,
  cardTitle: OVERVIEW_TEXT.activeSessionsTitle,
  heroNumeral: "ccc-kpi-number",
  heroCaption: "ccc-hero-caption",
  listRow: OVERVIEW_CLASSES.listRow,
  listPrimary: OVERVIEW_CLASSES.listPrimary,
  listMeta: OVERVIEW_CLASSES.listMeta,
  hidden: OVERVIEW_CLASSES.hidden,
};

export interface QuietRow {
  /** The session's display name (the row link's title). */
  readonly name: string;
  /** The State cell: `{glyph} {label}` and, for plain running, ` · Working` or ` · Idle`. */
  readonly state: string;
}

export interface QuietCardRow {
  readonly primary: string;
  readonly meta: string;
}

export interface QuietRead {
  readonly agentRuns: {
    readonly mounted: boolean;
    /** The summary line: `N active · Q quiet · W waiting for approval · U unknown`. */
    readonly summary: string;
    readonly rows: readonly QuietRow[];
  };
  readonly card: {
    readonly found: boolean;
    readonly numeral: string;
    readonly caption: string;
    readonly rows: readonly QuietCardRow[];
  };
}

interface RNode {
  textContent: string | null;
  children: ArrayLike<RNode>;
  className: string;
  cloneNode(deep: boolean): RNode;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
  getAttribute(name: string): string | null;
  remove(): void;
  click(): void;
}

declare const document: {
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
};

/**
 * Reads the Agent runs destination and the Active sessions card, whichever is on the page, into
 * plain data. SELF-CONTAINED (renderer function): no outer variable, no call to another export, no
 * named inner function; shared helpers are arrow functions held in an array literal, because wdio's
 * tsx loader compiles with keepNames and a nested named function would call a `__name` helper the
 * page does not have.
 */
export function rendererReadQuiet(c: QuietDomConfig): QuietRead {
  const H = [
    // 0: the visible text of a node, hidden parts removed, white space collapsed
    (n: RNode | null): string => {
      if (n === null) return "";
      const copy = n.cloneNode(true);
      const gone = copy.querySelectorAll(`.${c.hidden}`);
      for (let i = 0; i < gone.length; i += 1) (gone[i] as RNode).remove();
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    },
  ];
  const text = H[0] as (n: RNode | null) => string;

  const root = document.querySelector(`.${c.agentRuns}`);
  const agentRows: { name: string; state: string }[] = [];
  let summary = "";
  if (root !== null) {
    const first = root.children.length > 0 ? (root.children[0] as RNode) : null;
    if (first?.className.split(" ").includes(c.stateBody) === true) summary = text(first);
    const trs = root.querySelectorAll(`table.${c.sessionRow} tbody tr`);
    for (let i = 0; i < trs.length; i += 1) {
      const tr = trs[i] as RNode;
      const link = tr.querySelector(`.${c.rowLink}`);
      const cells = tr.querySelectorAll("td");
      agentRows.push({
        name: link === null ? "" : (link.getAttribute("title") ?? text(link)),
        state: cells.length > 0 ? text(cells[0] as RNode) : "",
      });
    }
  }

  let cardFound = false;
  let numeral = "";
  let caption = "";
  const cardRows: { primary: string; meta: string }[] = [];
  const cards = document.querySelectorAll(`section.${c.card}`);
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i] as RNode;
    if (text(card.querySelector("h3")) !== c.cardTitle) continue;
    cardFound = true;
    numeral = text(card.querySelector(`.${c.heroNumeral}`));
    caption = text(card.querySelector(`.${c.heroCaption}`));
    const lis = card.querySelectorAll(`li.${c.listRow}`);
    for (let j = 0; j < lis.length; j += 1) {
      const li = lis[j] as RNode;
      cardRows.push({
        primary: text(li.querySelector(`.${c.listPrimary}`)),
        meta: text(li.querySelector(`.${c.listMeta}`)),
      });
    }
    break;
  }
  return {
    agentRuns: { mounted: root !== null, summary, rows: agentRows },
    card: { found: cardFound, numeral, caption, rows: cardRows },
  };
}

// ---------------------------------------------------------------------------
// Verdicts (pure)

const SUMMARY_PATTERN =
  /^(\d+) active(?: · (\d+) quiet)? · (\d+) waiting for approval · (\d+) unknown/;

const startsQuiet = (state: string): boolean => state.startsWith(QUIET_TEXT.quietGlyph);
const startsRunning = (state: string): boolean => state.startsWith(QUIET_TEXT.runningGlyph);

/**
 * The Agent runs summary agrees with the rows: its `active` numeral counts the plain running rows
 * and its `quiet` segment (omitted at zero) counts the quiet ones, so a quiet session is excluded
 * from the first and named in the second (R-04, D-05).
 */
export function checkAgentRunsCounts(read: QuietRead): string[] {
  const problems: string[] = [];
  if (!read.agentRuns.mounted) return ["Agent runs is not on the page"];
  const match = SUMMARY_PATTERN.exec(read.agentRuns.summary);
  if (match === null) return ["the Agent runs summary line is not readable"];
  const active = Number(match[1]);
  const quiet = match[2] === undefined ? 0 : Number(match[2]);
  const runningRows = read.agentRuns.rows.filter((row) => startsRunning(row.state)).length;
  const quietRows = read.agentRuns.rows.filter((row) => startsQuiet(row.state)).length;
  if (active !== runningRows) {
    problems.push(`the summary counts ${active} active but ${runningRows} rows read Running`);
  }
  if (quiet !== quietRows) {
    problems.push(`the summary counts ${quiet} quiet but ${quietRows} rows read quiet`);
  }
  return problems;
}

/** The Active sessions card's numeral and caption agree with its rows the same way. */
export function checkCardCounts(read: QuietRead): string[] {
  if (!read.card.found) return ["the Active sessions card is not on the page"];
  const problems: string[] = [];
  const runningRows = read.card.rows.filter((row) => startsRunning(row.meta)).length;
  const quietRows = read.card.rows.filter((row) => startsQuiet(row.meta)).length;
  if (read.card.numeral !== String(runningRows)) {
    problems.push(
      `the card numeral reads ${read.card.numeral} but ${runningRows} rows read Running`,
    );
  }
  const hasSegment = new RegExp(`(^| · )${quietRows} ${QUIET_TEXT.quietSegment}( · |$)`).test(
    read.card.caption,
  );
  if (quietRows > 0 && !hasSegment) {
    problems.push(`the card caption does not name ${quietRows} ${QUIET_TEXT.quietSegment}`);
  }
  if (quietRows === 0 && new RegExp(`\\b${QUIET_TEXT.quietSegment}\\b`).test(read.card.caption)) {
    problems.push("the card caption names a quiet session but no row reads quiet");
  }
  return problems;
}

function agentRowOf(read: QuietRead, name: string): QuietRow | undefined {
  return read.agentRuns.rows.find((row) => row.name === name);
}

function cardRowOf(read: QuietRead, name: string): QuietCardRow | undefined {
  return read.card.rows.find((row) => row.primary.endsWith(name));
}

/** Agent runs: the session reads `⋯ Idle — last event …`, never Running, and the counts agree. */
export function checkAgentRunsIdle(read: QuietRead, name: string): string[] {
  const row = agentRowOf(read, name);
  if (row === undefined) return [`${name} is not listed in Agent runs`];
  const problems = checkAgentRunsCounts(read);
  if (!row.state.startsWith(QUIET_TEXT.idlePrefix)) {
    problems.push(`${name} reads "${row.state.slice(0, 60)}", not ${QUIET_TEXT.idlePrefix}`);
  }
  return problems;
}

/** The Active sessions card: the session reads Idle with the age, and is excluded from the numeral. */
export function checkCardIdle(read: QuietRead, name: string): string[] {
  const row = cardRowOf(read, name);
  if (row === undefined) return [`${name} is not listed in the Active sessions card`];
  const problems = checkCardCounts(read);
  if (!row.meta.startsWith(QUIET_TEXT.idlePrefix)) {
    problems.push(
      `${name} reads "${row.meta.slice(0, 60)}" on the card, not ${QUIET_TEXT.idlePrefix}`,
    );
  }
  return problems;
}

/** Agent runs: a session that said it was working and went quiet reads `⋯ No events for …`. */
export function checkAgentRunsSilent(read: QuietRead, name: string): string[] {
  const row = agentRowOf(read, name);
  if (row === undefined) return [`${name} is not listed in Agent runs`];
  const problems = checkAgentRunsCounts(read);
  if (!row.state.startsWith(QUIET_TEXT.silentPrefix)) {
    problems.push(`${name} reads "${row.state.slice(0, 60)}", not ${QUIET_TEXT.silentPrefix}`);
  }
  return problems;
}

/** Agent runs: after a new event the session reads plain Running again. */
export function checkAgentRunsRunning(read: QuietRead, name: string): string[] {
  const row = agentRowOf(read, name);
  if (row === undefined) return [`${name} is not listed in Agent runs`];
  const problems = checkAgentRunsCounts(read);
  if (!row.state.startsWith(QUIET_TEXT.runningPrefix)) {
    problems.push(`${name} reads "${row.state.slice(0, 60)}", not ${QUIET_TEXT.runningPrefix}`);
  }
  return problems;
}

/** The card: after a new event the session reads plain Running and is counted in the numeral. */
export function checkCardRunning(read: QuietRead, name: string): string[] {
  const row = cardRowOf(read, name);
  if (row === undefined) return [`${name} is not listed in the Active sessions card`];
  const problems = checkCardCounts(read);
  if (!row.meta.startsWith(QUIET_TEXT.runningPrefix)) {
    problems.push(
      `${name} reads "${row.meta.slice(0, 60)}" on the card, not ${QUIET_TEXT.runningPrefix}`,
    );
  }
  if (Number(read.card.numeral) < 1) problems.push("the card numeral does not count the session");
  return problems;
}

// ---------------------------------------------------------------------------
// Hook records for the synthetic session's later events

export const SESSION_EVENTS = ["Stop", "UserPromptSubmit", "PostToolUse"] as const;
export type SessionEvent = (typeof SESSION_EVENTS)[number];

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The record the compiled hook accepts for a later event of an already registered session. It
 * carries the session id and the folder inside the run root and nothing else (no prompt, no tool
 * input), so the sandbox service sees only lifecycle facts.
 */
export function buildSessionEventRecord(
  event: SessionEvent,
  sessionId: string,
  cwd: string,
  runRoot: string,
): Record<string, unknown> {
  if (!(SESSION_EVENTS as readonly string[]).includes(event)) {
    throw new Error("The synthetic session event is not one of the three the quiet items send.");
  }
  if (!SESSION_ID.test(sessionId)) throw new Error("The synthetic session id is not plain.");
  const root = runRoot.endsWith("/") ? runRoot : `${runRoot}/`;
  if (!cwd.startsWith(root) || cwd.includes("\0") || cwd.split("/").includes("..")) {
    throw new Error("The synthetic session folder must be inside the run root.");
  }
  return {
    session_id: sessionId,
    cwd,
    permission_mode: "default",
    model: "claude-test-model",
    hook_event_name: event,
  };
}

// ---------------------------------------------------------------------------
// Reaching and reading the two views

export interface QuietBrowser extends DriverBrowser {
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
}

export function asQuietBrowser(browser: unknown): QuietBrowser {
  return browser as QuietBrowser;
}

export async function readQuiet(browser: QuietBrowser): Promise<QuietRead> {
  return browser.execute(rendererReadQuiet, QUIET_DOM_CONFIG);
}

export type QuietView = "agent-runs" | "overview";

const TAB_IDS: Readonly<Record<QuietView, string>> = {
  "agent-runs": "agent-runs",
  overview: OVERVIEW_TEXT.overviewTabId,
};

/** Opens the command center on one of the two views and waits for it to mount. */
export async function openQuietView(browser: QuietBrowser, view: QuietView): Promise<void> {
  await browser.executeObsidianCommand("claude-command-center:open-overview");
  const selector = `#${OVERVIEW_CLASSES.tabPrefix}${TAB_IDS[view]}`;
  await pollUntil(
    () =>
      browser.execute((sel: string) => {
        const tab = document.querySelector(sel);
        if (tab === null) return false;
        tab.click();
        return true;
      }, selector),
    { ...WAIT.short, describe: `the ${view} tab` },
  );
  await pollUntil(
    async () => {
      const read = await readQuiet(browser);
      return view === "agent-runs" ? read.agentRuns.mounted : read.card.found;
    },
    { ...WAIT.connect, describe: `the ${view} view to mount` },
  );
}

/** Polls the open view until `check` finds nothing wrong; a timeout names the problems seen last. */
export async function waitForQuiet(
  browser: QuietBrowser,
  check: (read: QuietRead) => string[],
  describe: string,
  options: { timeoutMs: number; intervalMs: number } = { timeoutMs: 45_000, intervalMs: 250 },
): Promise<QuietRead> {
  let last: string[] = ["the view was never read"];
  try {
    return await pollUntil(
      async () => {
        const read = await readQuiet(browser);
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

/**
 * Sends `sendEvent` and polls for `check` over the next few seconds, up to `attempts` times. The
 * quiet threshold of the quiet kind is 5 seconds, so a fresh event shows plain Running only for
 * that long; a slow machine can miss the window once, and one more event reopens it.
 */
export async function expectRunningAfterEvent(
  browser: QuietBrowser,
  sendEvent: () => Promise<void>,
  check: (read: QuietRead) => string[],
  describe: string,
  attempts = 3,
): Promise<QuietRead> {
  let last = "no attempt was made";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sendEvent();
    try {
      return await waitForQuiet(browser, check, describe, { timeoutMs: 4_000, intervalMs: 100 });
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${describe} after ${attempts} events: ${last}`);
}

// ---------------------------------------------------------------------------
// Item 3: the bundle outcome line sits inside the viewport of its button

/** The most the bundle line may sit away from the button that raised it, in CSS px. */
export const MAX_LINE_GAP_PX = 160;

export interface BundleGeometryConfig {
  readonly toolbar: string;
  readonly attrStatusRegion: string;
  readonly bundleRegion: string;
}

export const BUNDLE_GEOMETRY_CONFIG: BundleGeometryConfig = {
  toolbar: HEALTH_CLASSES.healthToolbar,
  attrStatusRegion: HEALTH_ATTRS.statusRegion,
  bundleRegion: "bundle",
};

export interface Box {
  readonly top: number;
  readonly bottom: number;
}

export interface BundleGeometry {
  readonly viewportHeight: number;
  readonly line: (Box & { readonly text: string }) | null;
  readonly buttons: readonly (Box & { readonly label: string })[];
}

interface GNode {
  textContent: string | null;
  getBoundingClientRect(): { top: number; bottom: number };
  scrollIntoView(options: { block: string }): void;
}

declare const innerHeight: number;

/**
 * Reads the bundle status line and every toolbar button of the page as text and vertical extents,
 * with the viewport height. SELF-CONTAINED (renderer function; no nested named function).
 */
export function rendererReadBundleGeometry(c: BundleGeometryConfig): BundleGeometry {
  const line = document.querySelector(
    `[${c.attrStatusRegion}="${c.bundleRegion}"]`,
  ) as unknown as GNode | null;
  const found = document.querySelectorAll(`.${c.toolbar} button`) as unknown as ArrayLike<GNode>;
  const buttons: { label: string; top: number; bottom: number }[] = [];
  for (let i = 0; i < found.length; i += 1) {
    const node = found[i] as GNode;
    const box = node.getBoundingClientRect();
    buttons.push({
      label: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
      top: box.top,
      bottom: box.bottom,
    });
  }
  let lineBox: { text: string; top: number; bottom: number } | null = null;
  if (line !== null) {
    const box = line.getBoundingClientRect();
    lineBox = {
      text: (line.textContent ?? "").replace(/\s+/g, " ").trim(),
      top: box.top,
      bottom: box.bottom,
    };
  }
  return { viewportHeight: innerHeight, line: lineBox, buttons };
}

/** Scrolls the toolbar button named `label` to the middle of the viewport, as a person would. */
export function rendererScrollButtonIntoView(c: BundleGeometryConfig, label: string): boolean {
  const found = document.querySelectorAll(`.${c.toolbar} button`) as unknown as ArrayLike<GNode>;
  for (let i = 0; i < found.length; i += 1) {
    const node = found[i] as GNode;
    if ((node.textContent ?? "").replace(/\s+/g, " ").trim() === label) {
      node.scrollIntoView({ block: "center" });
      return true;
    }
  }
  return false;
}

/**
 * The outcome line is in the viewport (wholly), so is its button, and the two are within
 * {@link MAX_LINE_GAP_PX} of each other: the line is where the person's eyes already are (D-09).
 */
export function checkBundleLineInView(geometry: BundleGeometry, buttonLabel: string): string[] {
  const line = geometry.line;
  if (line === null) return ["the bundle status line is not on the page"];
  const button = geometry.buttons.find((entry) => entry.label === buttonLabel);
  if (button === undefined) return [`the ${buttonLabel} button is not on the page`];
  const problems: string[] = [];
  if (line.text === "") problems.push("the bundle status line is empty");
  const inView = (box: Box): boolean => box.top >= 0 && box.bottom <= geometry.viewportHeight;
  if (!inView(line)) problems.push("the bundle status line is outside the viewport");
  if (!inView(button)) problems.push(`the ${buttonLabel} button is outside the viewport`);
  const gap =
    line.top >= button.bottom ? line.top - button.bottom : Math.max(0, button.top - line.bottom);
  if (gap > MAX_LINE_GAP_PX) {
    problems.push(`the bundle status line is more than ${MAX_LINE_GAP_PX} px from ${buttonLabel}`);
  }
  return problems;
}

/** The slice of the wdio browser the window sizing uses. */
export interface WindowBrowser {
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
  setWindowRect(x: number, y: number, width: number, height: number): Promise<unknown>;
  pause(ms: number): Promise<unknown>;
}

/**
 * Runs `during` with the window's height set to `heightPx` (width and place unchanged) and puts the
 * window back afterwards, even when `during` throws. Obsidian's own Electron window API goes first,
 * WebDriver's setWindowRect is the fallback. If the viewport never gets that short the item fails
 * naming the sizes: a layout check on a window that stayed tall would prove nothing.
 */
export async function withWindowHeight<T>(
  browser: WindowBrowser,
  heightPx: number,
  during: (innerHeightPx: number) => Promise<T>,
  options: { settleMs?: number } = {},
): Promise<T> {
  const before = await browser.execute(readWindowFacts);
  const original: RectLite | null =
    before.bounds ??
    (before.outerWidth > 0 && before.outerHeight > 0
      ? {
          x: before.screenX,
          y: before.screenY,
          width: before.outerWidth,
          height: before.outerHeight,
        }
      : null);
  if (original === null) {
    throw new Error("The window's size could not be read, so it cannot be shortened.");
  }
  const target: RectLite = { ...original, height: heightPx };
  const electron =
    before.via === "electron"
      ? await browser.execute(applyWindowBounds, target, false).catch(() => false)
      : false;
  if (!electron) await browser.setWindowRect(target.x, target.y, target.width, target.height);
  try {
    const settleMs = options.settleMs ?? 5_000;
    let facts = await browser.execute(readWindowFacts);
    for (let waited = 0; facts.innerHeight > heightPx && waited < settleMs; waited += 250) {
      await browser.pause(250);
      facts = await browser.execute(readWindowFacts);
    }
    if (facts.innerHeight > heightPx) {
      throw new Error(
        `The window did not become short: its viewport is ${facts.innerHeight} px high, wanted at most ${heightPx} px.`,
      );
    }
    return await during(facts.innerHeight);
  } finally {
    if (electron) {
      await browser.execute(applyWindowBounds, original, before.maximized).catch(() => false);
    } else {
      await browser
        .setWindowRect(original.x, original.y, original.width, original.height)
        .catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Item 4: the disconnected banner shows a display path

export interface BannerConfig {
  readonly container: string;
  readonly text: string;
}

export const BANNER_CONFIG: BannerConfig = {
  container: "ccc-connection-status",
  text: "ccc-status-text",
};

export interface BannerRead {
  readonly present: boolean;
  readonly state: string | null;
  readonly text: string;
}

/** Reads the shell's connection status: its `data-state` and visible text. SELF-CONTAINED. */
export function rendererReadBanner(c: BannerConfig): BannerRead {
  const box = document.querySelector(`.${c.container}`);
  if (box === null) return { present: false, state: null, text: "" };
  const span = box.querySelector(`.${c.text}`);
  return {
    present: true,
    state: box.getAttribute("data-state"),
    text: ((span === null ? box.textContent : span.textContent) ?? "").replace(/\s+/g, " ").trim(),
  };
}

const DISCONNECTED_PREFIX = "Disconnected — ";

/**
 * The banner is disconnected, names where it looked as a display path (`…/folder/file` or `~/...`),
 * and holds no absolute path: not `/Users/`, not the home folder, not the run root (D-11, DIAG-06).
 */
export function checkBannerDisplayPath(
  read: BannerRead,
  facts: { readonly homeDir: string; readonly runRoot: string },
): string[] {
  if (!read.present) return ["the connection banner is not on the page"];
  if (read.state !== "disconnected") {
    return [`the connection banner is ${read.state ?? "unreadable"}, not disconnected`];
  }
  const problems: string[] = [];
  if (!read.text.startsWith(DISCONNECTED_PREFIX)) {
    problems.push(`the banner does not start with "${DISCONNECTED_PREFIX.trim()}"`);
  }
  if (read.text.includes("/Users/")) problems.push("the banner holds a /Users/ path");
  if (facts.homeDir !== "" && read.text.includes(facts.homeDir)) {
    problems.push("the banner holds the home folder");
  }
  if (read.text.includes(facts.runRoot)) problems.push("the banner holds the run root path");
  if (!read.text.includes("…/") && !read.text.includes("~/")) {
    problems.push("the banner shows no display path");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Item 5: Settings > Security reads the presence check as Unavailable in the sandbox

export interface PresenceFactLike {
  readonly name: string;
  readonly text: string;
  readonly loading: boolean;
  readonly chips: readonly { readonly word: string }[];
}

const SANDBOX_REASON = "This is a test service, which never starts the presence helper.";

/**
 * The `Approval presence check` row reads `Unavailable` with the sandbox reason: the throwaway
 * service never starts the helper (D-04, T-09-46), so Available here would mean the sandbox reached
 * the real one.
 */
export function checkPresenceUnavailable(facts: readonly PresenceFactLike[]): string[] {
  const name = SETTINGS_TEXT.factApprovalPresence;
  const fact = facts.find((entry) => entry.name === name);
  if (fact === undefined) return [`the ${name} row is missing`];
  if (fact.loading) return [`the ${name} row is still loading`];
  const word = fact.chips[0]?.word ?? "no chip";
  const problems: string[] = [];
  if (word !== SETTINGS_TEXT.chipUnavailable) {
    problems.push(`the ${name} row reads "${word}", not ${SETTINGS_TEXT.chipUnavailable}`);
  }
  if (!fact.text.includes(SANDBOX_REASON)) {
    problems.push(`the ${name} row does not give the sandbox reason`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Item 6: a test approval is approved with no prompt and reads decided through the command center

/** The request pane's `Decided through` line is exactly the plain command center. */
export function checkDecidedThrough(fields: Readonly<Record<string, string>>): string[] {
  const value = fields[APPROVALS_COPY.decidedThroughTerm];
  if (value === undefined) return ["the request pane has no Decided through line"];
  if (value !== APPROVALS_COPY.decidedThroughPlugin) {
    return [`Decided through reads "${value}", not "${APPROVALS_COPY.decidedThroughPlugin}"`];
  }
  return [];
}

const HELPER_NAME = /^ccc-presence/;
const MAX_WALK_DEPTH = 8;

/**
 * Every file or folder named like the presence helper below `root` (symlinks are listed, never
 * followed). A sandbox run root must hold none: the throwaway service has nowhere to spawn it from.
 */
export function findPresenceHelpers(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (HELPER_NAME.test(name)) found.push(path);
      if (depth < MAX_WALK_DEPTH && lstatSync(path).isDirectory()) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Item 7: the Launchers and Today headings

export interface HeadingConfig {
  readonly content: string;
  readonly title: string;
}

export const HEADING_CONFIG: HeadingConfig = {
  content: HEALTH_CLASSES.settingsContent,
  title: HEALTH_CLASSES.settingsSectionTitle,
};

export interface HeadingRead {
  readonly present: boolean;
  readonly text: string;
  readonly textTransform: string;
}

declare const getComputedStyle: (node: unknown) => { textTransform: string };

/** Reads the open Settings section's heading and how CSS transforms it. SELF-CONTAINED. */
export function rendererReadLaunchersHeading(c: HeadingConfig): HeadingRead {
  const heading = document.querySelector(`.${c.content} h3.${c.title}`);
  if (heading === null) return { present: false, text: "", textTransform: "" };
  return {
    present: true,
    text: (heading.textContent ?? "").replace(/\s+/g, " ").trim(),
    textTransform: getComputedStyle(heading).textTransform,
  };
}

const LAUNCHERS_HEADING = "Launchers";

/** The heading reads `Launchers` and is shown as written, not uppercased by the stylesheet. */
export function checkLaunchersHeading(read: HeadingRead): string[] {
  if (!read.present) return ["the Launchers heading is not on the page"];
  const problems: string[] = [];
  if (read.text !== LAUNCHERS_HEADING) {
    problems.push(`the heading reads "${read.text}", not ${LAUNCHERS_HEADING}`);
  }
  if (read.textTransform === "uppercase") {
    problems.push("the heading is shown in uppercase by the stylesheet");
  }
  return problems;
}

export interface TodayCardLike {
  readonly title: string;
  readonly sections: readonly { readonly text: string; readonly focal: boolean }[];
}

/** With an overdue task the Today card's focal heading reads `Due today and overdue`. */
export function checkTodayOverdueHeading(cards: readonly TodayCardLike[]): string[] {
  const today = cards.find((card) => card.title === OVERVIEW_TEXT.todayTitle);
  if (today === undefined) return [`there is no ${OVERVIEW_TEXT.todayTitle} card`];
  const focal = today.sections.find((section) => section.focal);
  if (focal === undefined) return ["the Today card has no focal heading"];
  return focal.text === OVERVIEW_TEXT.dueTodayOverdueHeading
    ? []
    : [`the Today heading reads "${focal.text}", not "${OVERVIEW_TEXT.dueTodayOverdueHeading}"`];
}

// ---------------------------------------------------------------------------
// Item 8: the Phase 7 research run still publishes one report after the pipeline split

export interface ReportListLike {
  readonly ok: boolean;
  readonly rows: readonly {
    readonly readable: boolean;
    readonly sourceCount: number;
  }[];
}

/** One run on fixture sources ended well and published exactly one readable report with sources. */
export function checkOneReport(input: ReportListLike): string[] {
  const problems: string[] = [];
  if (!input.ok) problems.push("the research run did not end well");
  const readable = input.rows.filter((row) => row.readable);
  if (readable.length !== 1) {
    problems.push(`the Reports list holds ${readable.length} readable report(s), not 1`);
  } else if ((readable[0]?.sourceCount ?? 0) < 1) {
    problems.push("the report lists no sources");
  }
  return problems;
}
