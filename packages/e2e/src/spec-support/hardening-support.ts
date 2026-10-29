import { type DriverBrowser, pollUntil } from "../driver.js";
import { OVERVIEW_CLASSES, OVERVIEW_TEXT } from "./overview-copy.js";
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
