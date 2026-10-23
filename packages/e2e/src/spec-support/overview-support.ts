import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskCreateRequest } from "@ccc/domain";
import { type AuthenticatedSocketApiClient, registerProject } from "@ccc/service-api-client";
import { type DriverBrowser, type PollOptions, pollUntil } from "../driver.js";
import { appendLedger } from "../ledger.js";
import { isStrictlyInside } from "../plugin-data.js";
import { readProcessTable } from "../process-table.js";
import type { RunRootPaths } from "../run-root.js";
import type { RunContext } from "../spec-context.js";
import { copyStore, queryStore } from "../store-copy.js";
import type { ProcessNode } from "./cross-support.js";
import {
  CALENDAR_ZERO_PATTERNS,
  OVERVIEW_CLASSES,
  OVERVIEW_TEXT,
  SLICE_CARD_TITLES,
} from "./overview-copy.js";
import {
  buildSessionStartRecord,
  ledgerPidsOf,
  runHook,
  type SacrificialChild,
  spawnSacrificialChild,
} from "./synthetic-session.js";
import {
  localDateIn,
  type NoteFile,
  noteById,
  pluginCommandId,
  rendererClick,
  shiftLocalDate,
  WAIT,
} from "./tasks-support.js";

/**
 * Support for the Overview slice spec (plan 08-19, SLICE-01, D-19 to D-23, D-27): the typed reader
 * of the Overview cards, the verdict of item 1 (the five parts of the slice on one screen, each with
 * its source and freshness), the finder of synthetic fixture markers (item 8) and the sandbox-only
 * seeding of a project and a synthetic session. Everything here runs spec side except the renderer
 * function, which wdio serialises and evaluates inside Obsidian.
 *
 * Nothing in this module reaches the owner's desktop, store, vault or Keychain: the project folder
 * is made inside the run root, the session is a sacrificial child this runner spawned and
 * ledgered, and the cards are read, never clicked, apart from the tab switches.
 */

// ---------------------------------------------------------------------------
// The cards as the page shows them

export interface OverviewButton {
  readonly text: string;
  /** The accessible name set by `aria-label`, or null when the button is named by its text. */
  readonly label: string | null;
  readonly disabled: boolean;
}

export interface OverviewRow {
  readonly primary: string;
  /** The `aria-label` of the row's primary control, or null. */
  readonly label: string | null;
  readonly meta: string;
  readonly buttons: readonly OverviewButton[];
}

export interface OverviewFooter {
  /** The footer time as written (`5s ago`), or null when the footer has none. */
  readonly time: string | null;
  readonly observedAt: string | null;
  /** The freshness badge kind (`live`, `cached`, `stale`, `unavailable`), or null without a badge. */
  readonly freshness: string | null;
  readonly freshnessLabel: string | null;
  /** The partial chip's text including its hidden detail, or null without the chip. */
  readonly partial: string | null;
  /** The Source panel's rows (the panel is hidden but present in the page). */
  readonly sources: readonly string[];
}

export interface OverviewCard {
  readonly title: string;
  readonly presentation: string | null;
  readonly dimmed: boolean;
  /** The first state heading (`Service disconnected`, `Nothing here yet`, ...), or an empty text. */
  readonly heading: string;
  readonly stateLines: readonly string[];
  /** The card body's text without visually hidden parts. */
  readonly text: string;
  readonly sections: readonly { readonly text: string; readonly focal: boolean }[];
  /** The Today note about Calendar and Gmail, or null. */
  readonly note: string | null;
  readonly rows: readonly OverviewRow[];
  /** Every button of the body that sits outside a list row. */
  readonly buttons: readonly OverviewButton[];
  /** The launch toolbar's buttons of the first project row. */
  readonly launch: readonly OverviewButton[];
  readonly launchStatus: string | null;
  /** The Technology card's latest report: the title line and the lines under it. */
  readonly intel: { readonly title: string; readonly lines: readonly string[] } | null;
  readonly footer: OverviewFooter;
}

/** The class names and words the renderer reader needs, from the mirrored tables. */
export interface OverviewDomConfig {
  readonly card: string;
  readonly cardBody: string;
  readonly stateHeading: string;
  readonly stateBody: string;
  readonly footerTime: string;
  readonly badge: string;
  readonly badgeLabel: string;
  readonly hidden: string;
  readonly sourceRow: string;
  readonly listRow: string;
  readonly listPrimary: string;
  readonly listMeta: string;
  readonly todaySection: string;
  readonly todayNote: string;
  readonly intelLatest: string;
  readonly launchToolbar: string;
  readonly launchStatus: string;
}

export const OVERVIEW_DOM_CONFIG: OverviewDomConfig = {
  card: OVERVIEW_CLASSES.card,
  cardBody: OVERVIEW_CLASSES.cardBody,
  stateHeading: OVERVIEW_CLASSES.stateHeading,
  stateBody: OVERVIEW_CLASSES.stateBody,
  footerTime: OVERVIEW_CLASSES.footerTime,
  badge: OVERVIEW_CLASSES.badge,
  badgeLabel: OVERVIEW_CLASSES.badgeLabel,
  hidden: OVERVIEW_CLASSES.hidden,
  sourceRow: OVERVIEW_CLASSES.sourceRow,
  listRow: OVERVIEW_CLASSES.listRow,
  listPrimary: OVERVIEW_CLASSES.listPrimary,
  listMeta: OVERVIEW_CLASSES.listMeta,
  todaySection: OVERVIEW_CLASSES.todaySection,
  todayNote: OVERVIEW_CLASSES.todayNote,
  intelLatest: OVERVIEW_CLASSES.intelLatest,
  launchToolbar: OVERVIEW_CLASSES.launchToolbar,
  launchStatus: OVERVIEW_CLASSES.launchStatus,
};

interface RNode {
  textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): RNode | null;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
  cloneNode(deep: boolean): RNode;
  remove(): void;
  focus(): void;
}

declare const document: {
  activeElement: RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
};

/**
 * Reads every `section.ccc-card` of the page into plain data. SELF-CONTAINED (renderer function):
 * no outer variable, no call to another export, no named inner function; shared helpers are arrow
 * functions held in an array literal, because wdio's tsx loader compiles with keepNames and a
 * nested named function would call a `__name` helper the page does not have.
 */
export function rendererReadOverviewCards(c: OverviewDomConfig): OverviewCard[] {
  const H = [
    // 0: the visible text of a node, hidden parts removed, white space collapsed
    (n: RNode | null): string => {
      if (n === null) return "";
      const copy = n.cloneNode(true);
      const gone = copy.querySelectorAll(`.${c.hidden}`);
      for (let i = 0; i < gone.length; i += 1) (gone[i] as RNode).remove();
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    },
    // 1: a button as data
    (b: RNode): OverviewButton => ({
      text: (b.textContent ?? "").replace(/\s+/g, " ").trim(),
      label: b.getAttribute("aria-label"),
      disabled: b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true",
    }),
  ];
  const text = H[0] as (n: RNode | null) => string;
  const asButton = H[1] as (b: RNode) => OverviewButton;
  const out: OverviewCard[] = [];
  const found = document.querySelectorAll(`section.${c.card}`);
  for (let i = 0; i < found.length; i += 1) {
    const card = found[i] as RNode;
    const body = card.querySelector(`.${c.cardBody}`);
    const footer = card.querySelector("footer");
    const stateLines: string[] = [];
    const lines = card.querySelectorAll(`.${c.stateBody}`);
    for (let j = 0; j < lines.length; j += 1) stateLines.push(text(lines[j] as RNode));
    const sections: { text: string; focal: boolean }[] = [];
    const headings = card.querySelectorAll(`h4.${c.todaySection}`);
    for (let j = 0; j < headings.length; j += 1) {
      const heading = headings[j] as RNode;
      sections.push({ text: text(heading), focal: heading.getAttribute("data-focal") === "true" });
    }
    const rows: OverviewRow[] = [];
    const listRows = card.querySelectorAll(`li.${c.listRow}`);
    for (let j = 0; j < listRows.length; j += 1) {
      const row = listRows[j] as RNode;
      const primary = row.querySelector(`.${c.listPrimary}`);
      const buttons: OverviewButton[] = [];
      const inside = row.querySelectorAll("button");
      for (let k = 0; k < inside.length; k += 1) buttons.push(asButton(inside[k] as RNode));
      rows.push({
        primary: text(primary),
        label: primary === null ? null : primary.getAttribute("aria-label"),
        meta: text(row.querySelector(`.${c.listMeta}`)),
        buttons,
      });
    }
    const buttons: OverviewButton[] = [];
    const bodyButtons = body === null ? [] : Array.from(body.querySelectorAll("button"));
    for (let j = 0; j < bodyButtons.length; j += 1) {
      const button = bodyButtons[j] as RNode;
      if (button.closest(`li.${c.listRow}`) === null) buttons.push(asButton(button));
    }
    const launch: OverviewButton[] = [];
    const toolbar = card.querySelector(`.${c.launchToolbar}`);
    const toolbarButtons = toolbar === null ? [] : Array.from(toolbar.querySelectorAll("button"));
    for (let j = 0; j < toolbarButtons.length; j += 1) {
      launch.push(asButton(toolbarButtons[j] as RNode));
    }
    const status = card.querySelector(`.${c.launchStatus}`);
    const latest = card.querySelector(`.${c.intelLatest}`);
    let intel: { title: string; lines: string[] } | null = null;
    if (latest !== null) {
      const paragraphs = latest.querySelectorAll("p");
      const rest: string[] = [];
      for (let j = 1; j < paragraphs.length; j += 1) rest.push(text(paragraphs[j] as RNode));
      intel = { title: paragraphs.length > 0 ? text(paragraphs[0] as RNode) : "", lines: rest };
    }
    const sources: string[] = [];
    const sourceRows =
      footer === null ? [] : Array.from(footer.querySelectorAll(`.${c.sourceRow}`));
    for (let j = 0; j < sourceRows.length; j += 1) sources.push(text(sourceRows[j] as RNode));
    let freshness: string | null = null;
    let freshnessLabel: string | null = null;
    let partial: string | null = null;
    const badges = footer === null ? [] : Array.from(footer.querySelectorAll(`.${c.badge}`));
    for (let j = 0; j < badges.length; j += 1) {
      const badge = badges[j] as RNode;
      const kind = badge.getAttribute("data-badge");
      if (kind === "partial") {
        const copy = badge.cloneNode(true);
        partial = (copy.textContent ?? "").replace(/\s+/g, " ").trim();
      } else if (freshness === null) {
        freshness = kind;
        freshnessLabel = text(badge.querySelector(`.${c.badgeLabel}`));
      }
    }
    const time = footer === null ? null : footer.querySelector(`.${c.footerTime}`);
    out.push({
      title: text(card.querySelector("h3")),
      presentation: card.getAttribute("data-presentation"),
      dimmed: card.querySelector(`.${c.cardBody}[data-dimmed="true"]`) !== null,
      heading: text(card.querySelector(`.${c.stateHeading}`)),
      stateLines,
      text: text(body),
      sections,
      note: text(card.querySelector(`.${c.todayNote}`)) || null,
      rows,
      buttons,
      launch,
      launchStatus: status === null ? null : text(status),
      intel,
      footer: {
        time: time === null ? null : text(time),
        observedAt: time === null ? null : time.getAttribute("datetime"),
        freshness,
        freshnessLabel,
        partial,
        sources,
      },
    });
  }
  return out;
}

/** The slice of the wdio browser the Overview helpers use. */
export interface OverviewBrowser extends DriverBrowser {
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
  keys(value: string | string[]): Promise<void>;
}

export function asOverviewBrowser(browser: unknown): OverviewBrowser {
  return browser as OverviewBrowser;
}

export function cardByTitle(
  cards: readonly OverviewCard[],
  title: string,
): OverviewCard | undefined {
  return cards.find((card) => card.title === title);
}

export async function readOverviewCards(browser: OverviewBrowser): Promise<OverviewCard[]> {
  return browser.execute(rendererReadOverviewCards, OVERVIEW_DOM_CONFIG);
}

/** Switches the command center to a destination tab by its id (the tab strip must be mounted). */
async function selectTab(browser: OverviewBrowser, id: string): Promise<boolean> {
  return browser.executeObsidian(rendererClick, `#${OVERVIEW_CLASSES.tabPrefix}${id}`, null);
}

/**
 * Waits until the page shows the four slice cards and none of them is still loading, then returns
 * the cards. `accept` narrows the wait to a state a case needs (a failure line, a report).
 */
export async function waitForCards(
  browser: OverviewBrowser,
  describe: string,
  accept: (cards: readonly OverviewCard[]) => boolean = () => true,
  options: { timeoutMs: number; intervalMs: number } = WAIT.connect,
): Promise<OverviewCard[]> {
  return pollUntil(
    async () => {
      const cards = await readOverviewCards(browser);
      const present = SLICE_CARD_TITLES.every((title) => cardByTitle(cards, title) !== undefined);
      const settled = cards.every((card) => card.presentation !== "loading");
      return present && settled && accept(cards) ? cards : null;
    },
    { ...options, describe },
  );
}

/**
 * Opens the command center on the Overview. The Overview fetches its feeds on mount, so a case
 * that changed the sources after the last visit calls {@link reopenOverview} instead.
 */
export async function openOverview(browser: OverviewBrowser): Promise<OverviewCard[]> {
  await browser.executeObsidianCommand(pluginCommandId("open-overview"));
  await pollUntil(() => selectTab(browser, OVERVIEW_TEXT.overviewTabId), {
    ...WAIT.short,
    describe: "the Overview tab",
  });
  return waitForCards(browser, "the four slice cards to settle on the Overview");
}

/**
 * Leaves the Overview for the Research tab and comes back, so the Overview mounts again and
 * fetches every feed. The report feed refreshes only on mount, on going live and on a
 * `research.updated` event, never on the clock (08-17 FIX3A), so a case that reads a report it
 * just made must remount.
 */
export async function reopenOverview(
  browser: OverviewBrowser,
  accept?: (cards: readonly OverviewCard[]) => boolean,
): Promise<OverviewCard[]> {
  await browser.executeObsidianCommand(pluginCommandId("open-overview"));
  await pollUntil(() => selectTab(browser, OVERVIEW_TEXT.researchTabId), {
    ...WAIT.short,
    describe: "the Research tab",
  });
  await pollUntil(() => selectTab(browser, OVERVIEW_TEXT.overviewTabId), {
    ...WAIT.short,
    describe: "the Overview tab",
  });
  return waitForCards(browser, "the slice cards to settle after remounting the Overview", accept);
}

/**
 * Waits until `check` finds nothing wrong with the cards. A timeout names the problems seen last,
 * so a failed run says what the page showed instead of only that a wait ended.
 */
export async function waitForVerdict(
  browser: OverviewBrowser,
  check: (cards: readonly OverviewCard[]) => string[],
  describe: string,
  options: { timeoutMs: number; intervalMs: number } = { timeoutMs: 30_000, intervalMs: 500 },
): Promise<OverviewCard[]> {
  let last: string[] = ["the cards were never read"];
  try {
    return await pollUntil(
      async () => {
        const cards = await readOverviewCards(browser);
        last = check(cards);
        return last.length === 0 ? cards : null;
      },
      { ...options, describe },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; the problems were: ${last.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Item 1: the five parts of the slice on one screen

export interface SliceSeed {
  readonly folder: string;
  readonly projectName: string;
  readonly projectId: string;
  readonly sessionId: string;
  /** The session as the Overview names it: `Session` and the first eight characters of its id. */
  readonly sessionName: string;
}

/** The running or starting state words a live synthetic session may show. */
const SESSION_STATE_WORDS = ["Running", "Starting"] as const;

/**
 * The verdict of item 1 (D-22, SLICE-01): on one screen the Project shortcuts card shows the
 * project with an enabled, named launch control, Active sessions shows the synthetic session in a
 * running state, Today shows a managed task, and Technology shows the cited report as Cached; every
 * card carries a time, a freshness badge and at least one source. Returns what is wrong; an empty
 * list is a pass.
 */
export function checkSliceCards(
  cards: readonly OverviewCard[],
  seed: Pick<SliceSeed, "projectName" | "sessionName">,
): string[] {
  const problems: string[] = [];
  for (const title of SLICE_CARD_TITLES) {
    const card = cardByTitle(cards, title);
    if (card === undefined) {
      problems.push(`there is no ${title} card`);
      continue;
    }
    if (card.presentation !== "ready") {
      problems.push(`${title} is ${card.presentation ?? "unreadable"}, not ready`);
    }
    if (card.footer.time === null || card.footer.time === "" || card.footer.time === "—") {
      problems.push(`${title} shows no time`);
    }
    if (card.footer.freshness === null) problems.push(`${title} shows no freshness`);
    if (card.footer.sources.length === 0) problems.push(`${title} lists no source`);
  }

  const projects = cardByTitle(cards, OVERVIEW_TEXT.projectShortcutsTitle);
  if (projects !== undefined) {
    if (!projects.rows.some((row) => row.primary === seed.projectName)) {
      problems.push(`${OVERVIEW_TEXT.projectShortcutsTitle} shows no project row for the project`);
    }
    const antigravity = projects.launch.find((button) =>
      (button.label ?? "").endsWith(OVERVIEW_TEXT.antigravityNameInfix),
    );
    if (antigravity === undefined || antigravity.disabled) {
      problems.push("the launch control is missing or disabled");
    }
    if (projects.launch.some((button) => (button.label ?? "").trim() === "")) {
      problems.push("a launch control has no accessible name");
    }
  }

  const sessions = cardByTitle(cards, OVERVIEW_TEXT.activeSessionsTitle);
  if (sessions !== undefined) {
    const row = sessions.rows.find((entry) => entry.primary.includes(seed.sessionName));
    if (row === undefined) {
      problems.push(`the session is not listed in ${OVERVIEW_TEXT.activeSessionsTitle}`);
    } else if (!SESSION_STATE_WORDS.some((word) => row.meta.includes(word))) {
      problems.push("the session row shows no running state");
    }
  }

  const today = cardByTitle(cards, OVERVIEW_TEXT.todayTitle);
  if (today !== undefined) {
    const hasTask = today.rows.some((row) =>
      (row.label ?? "").startsWith(OVERVIEW_TEXT.openTaskPrefix),
    );
    if (!hasTask) problems.push(`${OVERVIEW_TEXT.todayTitle} shows no managed task`);
  }

  const intel = cardByTitle(cards, OVERVIEW_TEXT.techIntelTitle);
  if (intel !== undefined) {
    if (intel.intel === null || intel.intel.title === "") {
      problems.push(`${OVERVIEW_TEXT.techIntelTitle} shows no report`);
    }
    if (!intel.buttons.some((button) => button.text === OVERVIEW_TEXT.openReport)) {
      problems.push(`${OVERVIEW_TEXT.techIntelTitle} has no ${OVERVIEW_TEXT.openReport} control`);
    }
    if (intel.footer.freshness !== "cached") {
      problems.push(
        `${OVERVIEW_TEXT.techIntelTitle} freshness is ${intel.footer.freshnessLabel ?? "missing"}, not ${OVERVIEW_TEXT.freshnessCached}`,
      );
    }
  }
  return problems;
}

/**
 * Waits until {@link checkSliceCards} finds nothing wrong. A timeout names the last problems seen,
 * so a failed run says which of the five parts never appeared.
 */
export async function waitForSlice(
  browser: OverviewBrowser,
  seed: Pick<SliceSeed, "projectName" | "sessionName">,
): Promise<OverviewCard[]> {
  let last: string[] = ["the cards were never read"];
  try {
    return await waitForCards(
      browser,
      "the project, the session, a task and the report on one Overview screen",
      (cards) => {
        last = checkSliceCards(cards, seed);
        return last.length === 0;
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; the slice problems were: ${last.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Item 8 (and the slice's data): the synthetic fixture markers

export interface FixtureMarker {
  /** The name a finding reports. It never contains the marker text. */
  readonly name: string;
  /** An invented title from `packages/test-fixtures/src/widget-fixtures.json`. */
  readonly text: string;
}

/**
 * Invented titles of the prototype round's widget fixtures (D-05). None of them belongs to a
 * production Overview, so any of them in the built plugin or on a slice card means a fixture or a
 * constant reached the product (D-22). A unit test checks each text is in the fixture file.
 */
export const FIXTURE_MARKERS: readonly FixtureMarker[] = Object.freeze([
  { name: "fixture-today-event", text: "Tidewater design review" },
  { name: "fixture-today-task-a", text: "Draft the ingest retry policy" },
  { name: "fixture-today-task-b", text: "Reply to the Quarry maintainer thread" },
  {
    name: "fixture-intel-headline",
    text: "Edge inference runtimes converge on a shared model format",
  },
  { name: "fixture-intel-market", text: "Broad indices flat; semiconductor names led the session" },
  { name: "fixture-session-name", text: "refactor-ingest" },
  { name: "fixture-session-id", text: "fixture-lantern-session" },
  { name: "fixture-github-repo", text: "beaconlight" },
]);

/** The names of the fixture markers found in `text`, in list order; never the text around them. */
export function findFixtureMarkers(text: string): string[] {
  return FIXTURE_MARKERS.filter((marker) => text.includes(marker.text)).map(
    (marker) => marker.name,
  );
}

// ---------------------------------------------------------------------------
// Seeding: a project and a synthetic session, inside the run root only

const PROJECT_FOLDER_NAME = "uat-slice-project";

/** The registered project's folder: inside the run root's scratch folder, or a refusal. */
export function sliceProjectFolder(paths: Pick<RunRootPaths, "tmpDir">, runRoot: string): string {
  const folder = join(paths.tmpDir, PROJECT_FOLDER_NAME);
  if (!isStrictlyInside(runRoot, folder)) {
    throw new Error("Refusing a project folder outside the run root.");
  }
  return folder;
}

export interface SeedDeps {
  readonly runRoot: string;
  readonly paths: Pick<RunRootPaths, "tmpDir">;
  readonly makeFolder: (folder: string) => void;
  readonly register: (
    folder: string,
  ) => Promise<{ kind: "registered"; projectId: string } | { kind: "protected-location" }>;
  readonly startSession: (folder: string, sessionId: string) => Promise<void>;
  readonly newSessionId: () => string;
}

/**
 * Registers a project in a folder of the run root through the sandbox service's client and starts
 * one synthetic Claude session in it. Nothing outside the run root is named, and a folder the
 * service refuses as protected stops the seed before any session starts.
 */
export async function seedSlice(deps: SeedDeps): Promise<SliceSeed> {
  const folder = sliceProjectFolder(deps.paths, deps.runRoot);
  deps.makeFolder(folder);
  const registered = await deps.register(folder);
  if (registered.kind === "protected-location") {
    throw new Error("The service refused the project folder as a protected location.");
  }
  const sessionId = deps.newSessionId();
  await deps.startSession(folder, sessionId);
  return {
    folder,
    projectName: PROJECT_FOLDER_NAME,
    projectId: registered.projectId,
    sessionId,
    sessionName: `Session ${sessionId.slice(0, 8)}`,
  };
}

/** The real wiring of {@link seedSlice}: the sandbox client, the hook and a ledgered child. */
export function sliceSeedDeps(
  context: RunContext,
  client: AuthenticatedSocketApiClient,
  registry: SacrificialChild[],
): SeedDeps {
  return {
    runRoot: context.runRoot,
    paths: context.paths,
    makeFolder: (folder) => {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    },
    register: async (folder) => {
      const answer = await registerProject(client, folder);
      return answer.kind === "protected-location"
        ? { kind: "protected-location" }
        : { kind: "registered", projectId: answer.projectId };
    },
    startSession: async (folder, sessionId) => {
      const sacrificial = await spawnSacrificialChild({
        registry,
        ledger: (entry) => appendLedger(context.paths.ledgerPath, entry),
        readStart: async (pid) => {
          const row = (await readProcessTable()).find((entry) => entry.pid === pid);
          if (row === undefined) throw new Error("The synthetic session's process is not listed.");
          return row.start;
        },
      });
      await runHook({
        runtimeDir: context.paths.runtimeDir,
        runRoot: context.runRoot,
        home: context.paths.tmpDir,
        pid: sacrificial.pid,
        ledgerPids: ledgerPidsOf(registry),
        record: buildSessionStartRecord(sessionId, folder, context.runRoot),
      });
    },
    newSessionId: () => randomBytes(8).toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// Items 2 to 5 and 7: the Today and Technology verdicts

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sentence of one source row, as the Source panel writes it: `{source} — {status}`. */
function sourceRow(card: OverviewCard, source: string): string | undefined {
  return card.footer.sources.find((row) => row.startsWith(`${source} — `));
}

/**
 * Item 2 (D-20, D-48): Today is a service-fed card carrying the Partial badge and the note that
 * Calendar and Gmail are not part of this version; its Source panel lists both as "not part of this
 * version", never "no response"; and no text of the card shows a calendar count of zero.
 */
export function checkCalendarGmail(cards: readonly OverviewCard[]): string[] {
  const today = cardByTitle(cards, OVERVIEW_TEXT.todayTitle);
  if (today === undefined) return [`there is no ${OVERVIEW_TEXT.todayTitle} card`];
  const problems: string[] = [];
  const title = OVERVIEW_TEXT.todayTitle;
  if (today.presentation === "permission-required") {
    problems.push(`${title} is permission-required, not service-fed`);
  } else if (!["ready", "empty", "stale"].includes(today.presentation ?? "")) {
    problems.push(`${title} is ${today.presentation ?? "unreadable"}, not ready`);
  }
  if (today.footer.partial === null) {
    problems.push(`${title} does not carry the ${OVERVIEW_TEXT.partialLabel} badge`);
  } else if (!today.footer.partial.includes(OVERVIEW_TEXT.notInVersionSummary)) {
    problems.push(
      `the ${OVERVIEW_TEXT.partialLabel} badge of ${title} does not say that Calendar and Gmail are not part of this version`,
    );
  }
  if (today.note === null || !today.note.includes(OVERVIEW_TEXT.calendarGmailNote)) {
    problems.push(`${title} does not carry the note "${OVERVIEW_TEXT.calendarGmailNote}"`);
  }
  for (const source of [OVERVIEW_TEXT.calendarSource, OVERVIEW_TEXT.gmailSource]) {
    const row = sourceRow(today, source);
    if (row === undefined) {
      problems.push(`the Source panel of ${title} has no row for ${source}`);
    } else if (row !== `${source} — ${OVERVIEW_TEXT.notPartOfThisVersion}`) {
      problems.push(
        `the Source panel row for ${source} reads "${row}", not "${OVERVIEW_TEXT.notPartOfThisVersion}"`,
      );
    }
  }
  const texts = [
    today.text,
    today.note ?? "",
    today.footer.partial ?? "",
    ...today.stateLines,
    ...today.footer.sources,
  ];
  for (const text of texts) {
    if (CALENDAR_ZERO_PATTERNS.some((pattern) => pattern.test(text))) {
      problems.push(`${title} shows a calendar count of zero or an empty calendar`);
      break;
    }
  }
  return problems;
}

/**
 * Item 3 (D-21, D-45): with nothing due or overdue, Today says "Nothing is due today." and a "Next
 * open task" section holds one row, a control named `Open task: ...`, labelled "Next due {date}" or
 * "Most recent open task".
 */
export function checkNextOpen(cards: readonly OverviewCard[]): string[] {
  const today = cardByTitle(cards, OVERVIEW_TEXT.todayTitle);
  if (today === undefined) return [`there is no ${OVERVIEW_TEXT.todayTitle} card`];
  const problems: string[] = [];
  if (!today.stateLines.includes(OVERVIEW_TEXT.nothingDue)) {
    problems.push(`${OVERVIEW_TEXT.todayTitle} does not say "${OVERVIEW_TEXT.nothingDue}"`);
  }
  if (!today.sections.some((section) => section.text === OVERVIEW_TEXT.nextOpenHeading)) {
    problems.push(`${OVERVIEW_TEXT.todayTitle} has no "${OVERVIEW_TEXT.nextOpenHeading}" section`);
    return problems;
  }
  const row = today.rows[0];
  if (today.rows.length !== 1 || row === undefined) {
    problems.push(`the "${OVERVIEW_TEXT.nextOpenHeading}" section does not hold exactly one row`);
    return problems;
  }
  if (!(row.label ?? "").startsWith(OVERVIEW_TEXT.openTaskPrefix)) {
    problems.push(`the "${OVERVIEW_TEXT.nextOpenHeading}" row is not a task control`);
  }
  const allowed = new RegExp(
    `^(?:${escapeForPattern(OVERVIEW_TEXT.nextDuePrefix)}.+|${escapeForPattern(OVERVIEW_TEXT.mostRecentOpen)})$`,
  );
  if (!allowed.test(row.meta)) {
    problems.push(
      `the next open task label reads "${row.meta}", not "${OVERVIEW_TEXT.nextDuePrefix}{date}" or "${OVERVIEW_TEXT.mostRecentOpen}"`,
    );
  }
  return problems;
}

/** Item 4, before any report: the Technology card reads "No reports yet" and offers no report. */
export function checkTechEmpty(cards: readonly OverviewCard[]): string[] {
  const card = cardByTitle(cards, OVERVIEW_TEXT.techIntelTitle);
  if (card === undefined) return [`there is no ${OVERVIEW_TEXT.techIntelTitle} card`];
  const problems: string[] = [];
  if (card.presentation !== "empty" || card.heading !== OVERVIEW_TEXT.noReportsYet) {
    problems.push(
      `${OVERVIEW_TEXT.techIntelTitle} does not read "${OVERVIEW_TEXT.noReportsYet}" (it is ${card.presentation ?? "unreadable"})`,
    );
  }
  if (card.intel !== null) problems.push(`${OVERVIEW_TEXT.techIntelTitle} already shows a report`);
  if (card.buttons.some((button) => button.text === OVERVIEW_TEXT.openReport)) {
    problems.push(
      `${OVERVIEW_TEXT.techIntelTitle} offers ${OVERVIEW_TEXT.openReport} with no report`,
    );
  }
  return problems;
}

/** What the service's report list says about the newest readable report. */
export interface ReportFacts {
  readonly title: string;
  readonly sourceCount: number;
  readonly itemCount: number;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Item 4, after one fixture run (D-19): the card shows the report's title, its source and item
 * counts, the AI-generated line and Open report (named by the report), with freshness Cached and
 * never Live.
 */
export function checkTechLatest(cards: readonly OverviewCard[], report: ReportFacts): string[] {
  const card = cardByTitle(cards, OVERVIEW_TEXT.techIntelTitle);
  if (card === undefined) return [`there is no ${OVERVIEW_TEXT.techIntelTitle} card`];
  const name = OVERVIEW_TEXT.techIntelTitle;
  const problems: string[] = [];
  if (card.intel === null) return [`${name} shows no report`];
  if (card.intel.title !== report.title) {
    problems.push(`the report title on ${name} is "${card.intel.title}", not "${report.title}"`);
  }
  const counts = `${counted(report.sourceCount, "source", "sources")} · ${counted(report.itemCount, "item", "items")}`;
  if (card.intel.lines[0] !== counts) {
    problems.push(`the counts line reads "${card.intel.lines[0] ?? ""}", not "${counts}"`);
  }
  if (!card.intel.lines.includes(OVERVIEW_TEXT.aiLine)) {
    problems.push(`the AI-generated line "${OVERVIEW_TEXT.aiLine}" is missing`);
  }
  const open = card.buttons.find((button) => button.text === OVERVIEW_TEXT.openReport);
  if (open === undefined || open.label !== `${OVERVIEW_TEXT.openReportNamePrefix}${report.title}`) {
    problems.push(`${OVERVIEW_TEXT.openReport} is missing or not named by its report`);
  }
  if (card.footer.freshness !== "cached") {
    problems.push(
      `${name} freshness is ${card.footer.freshnessLabel ?? "missing"}, not ${OVERVIEW_TEXT.freshnessCached}`,
    );
  }
  return problems;
}

/**
 * Item 5, after a run whose sources all failed: Today's automation line reads "Research run failed
 * ..." with a reason and offers the research view.
 */
export function checkFailureLine(cards: readonly OverviewCard[]): string[] {
  const today = cardByTitle(cards, OVERVIEW_TEXT.todayTitle);
  if (today === undefined) return [`there is no ${OVERVIEW_TEXT.todayTitle} card`];
  const line = today.stateLines.find((entry) => entry.includes(OVERVIEW_TEXT.failedStem));
  if (line === undefined) {
    return [`${OVERVIEW_TEXT.todayTitle} shows no "${OVERVIEW_TEXT.failedStem.trimEnd()} …" line`];
  }
  const problems: string[] = [];
  const afterStem = line.slice(
    line.indexOf(OVERVIEW_TEXT.failedStem) + OVERVIEW_TEXT.failedStem.length,
  );
  if (!/^[^:]+: .{3,}\.$/.test(afterStem)) {
    problems.push(`the failure line has no reason ("${line}")`);
  }
  if (!today.buttons.some((button) => button.text === OVERVIEW_TEXT.openResearchView)) {
    problems.push(`the failure line offers no ${OVERVIEW_TEXT.openResearchView} control`);
  }
  return problems;
}

/** Item 5, after a good run: Today reads "No automation failures." and shows no failed run. */
export function checkNoFailures(cards: readonly OverviewCard[]): string[] {
  const today = cardByTitle(cards, OVERVIEW_TEXT.todayTitle);
  if (today === undefined) return [`there is no ${OVERVIEW_TEXT.todayTitle} card`];
  const problems: string[] = [];
  if (today.stateLines.some((line) => line.includes(OVERVIEW_TEXT.failedStem))) {
    problems.push(`${OVERVIEW_TEXT.todayTitle} still shows a failed run`);
  }
  if (!today.stateLines.includes(OVERVIEW_TEXT.noFailures)) {
    problems.push(`${OVERVIEW_TEXT.todayTitle} does not read "${OVERVIEW_TEXT.noFailures}"`);
  }
  return problems;
}

const DRILL_TITLES = [OVERVIEW_TEXT.todayTitle, OVERVIEW_TEXT.techIntelTitle] as const;

/**
 * Item 7, with the service stopped (D-03): Today and Technology read "Service disconnected", their
 * last values dimmed, with freshness Unavailable.
 */
export function checkDisconnected(cards: readonly OverviewCard[]): string[] {
  const problems: string[] = [];
  for (const title of DRILL_TITLES) {
    const card = cardByTitle(cards, title);
    if (card === undefined) {
      problems.push(`there is no ${title} card`);
      continue;
    }
    if (card.presentation !== "disconnected") {
      problems.push(`${title} is ${card.presentation ?? "unreadable"}, not disconnected`);
    }
    if (card.heading !== OVERVIEW_TEXT.serviceDisconnected) {
      problems.push(`${title} does not read "${OVERVIEW_TEXT.serviceDisconnected}"`);
    }
    if (!card.dimmed) problems.push(`the last values of ${title} are not dimmed`);
    if (card.footer.freshness !== "unavailable") {
      problems.push(
        `${title} freshness is ${card.footer.freshnessLabel ?? "missing"}, not ${OVERVIEW_TEXT.freshnessUnavailable}`,
      );
    }
  }
  return problems;
}

/** Item 7, after the restart and with no reload: both cards left the disconnected state. */
export function checkRecovered(cards: readonly OverviewCard[]): string[] {
  const problems: string[] = [];
  for (const title of DRILL_TITLES) {
    const card = cardByTitle(cards, title);
    if (card === undefined) {
      problems.push(`there is no ${title} card`);
      continue;
    }
    if (!["ready", "empty", "stale"].includes(card.presentation ?? "")) {
      problems.push(
        `${title} is ${card.presentation ?? "unreadable"}, still not recovered from disconnected`,
      );
    }
    if (card.dimmed || card.heading === OVERVIEW_TEXT.serviceDisconnected) {
      problems.push(`${title} is still dimmed or disconnected`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Item 6: the launch control, pressed only where it can do nothing but refuse (D-46, T-08-48)

/** The launchers whose press needs a saved configuration: the only two this helper presses. */
export const PRESSABLE_LAUNCHERS = ["antigravity", "claude-code"] as const;
export type PressableLauncher = (typeof PRESSABLE_LAUNCHERS)[number];

/** The saved launchers of the sandbox store: one fixed read-only statement over a store copy. */
export const LAUNCHER_ROWS_SQL = "select launcher_id from launcher_config order by launcher_id;";

function assertPressable(action: string): asserts action is PressableLauncher {
  if (!(PRESSABLE_LAUNCHERS as readonly string[]).includes(action)) {
    throw new Error(`"${action}" is not a launcher that needs a saved configuration.`);
  }
}

/**
 * Throws unless `rows` (the answer to {@link LAUNCHER_ROWS_SQL}) is readable and holds no row for
 * `action`. An answer it cannot read is a refusal, never a pass: with no knowledge of the saved
 * launchers a press could open an app.
 */
export function assertNoLauncherSaved(rows: readonly unknown[], action: PressableLauncher): void {
  if (!Array.isArray(rows))
    throw new Error("Refusing to press: the saved launchers could not be read.");
  for (const row of rows) {
    const id = (row as { launcher_id?: unknown } | null)?.launcher_id;
    if (typeof id !== "string") {
      throw new Error("Refusing to press: the saved launchers could not be read.");
    }
    if (id === action) {
      throw new Error("Refusing to press a launch control while a launcher is saved for it.");
    }
  }
}

/** The accessible name of a project's launch control. */
function launchControlLabel(action: PressableLauncher, projectName: string): string {
  return action === "antigravity"
    ? `Open ${projectName}${OVERVIEW_TEXT.antigravityNameInfix}`
    : `${OVERVIEW_TEXT.claudeCodeNamePrefix}${projectName}`;
}

function launcherName(action: PressableLauncher): string {
  return action === "antigravity" ? OVERVIEW_TEXT.antigravityLabel : OVERVIEW_TEXT.claudeCodeLabel;
}

/**
 * Item 6: after the press the project's launch status line holds the typed not-set-up outcome of
 * the pressed launcher and its next step; a success line, an empty line or the service-unreachable
 * outcome is not it (the last would mean the press never reached the launcher route).
 */
export function checkLaunchOutcome(
  cards: readonly OverviewCard[],
  action: PressableLauncher,
): string[] {
  const projects = cardByTitle(cards, OVERVIEW_TEXT.projectShortcutsTitle);
  if (projects === undefined) return [`there is no ${OVERVIEW_TEXT.projectShortcutsTitle} card`];
  const status = projects.launchStatus ?? "";
  if (status === "") return ["the launch status line is empty"];
  const problems: string[] = [];
  if (status.includes(OVERVIEW_TEXT.serviceUnreachable)) {
    problems.push(
      "the press did not reach the launcher route: the service was reported unreachable",
    );
  }
  const sentence = OVERVIEW_TEXT.launcherNotSetUp.replace("{Launcher}", launcherName(action));
  if (!status.includes(sentence)) {
    problems.push(`the launch status line does not say "${sentence}" (it reads "${status}")`);
  }
  if (!status.includes(OVERVIEW_TEXT.launcherNextStep)) {
    problems.push(
      `the launch status line gives no next step ("${OVERVIEW_TEXT.launcherNextStep}")`,
    );
  }
  return problems;
}

/** The WebDriver code of the Enter key (`Key.Enter` of webdriverio). */
export const ENTER_KEY = "\uE007";

/**
 * Focuses a launch control by its accessible name and reports which control then holds focus.
 * SELF-CONTAINED renderer function (see {@link rendererReadOverviewCards}).
 */
export function rendererFocusControl(
  toolbar: string,
  label: string,
): { found: boolean; activeLabel: string | null } {
  const buttons = document.querySelectorAll(`.${toolbar} button`);
  for (let i = 0; i < buttons.length; i += 1) {
    const button = buttons[i] as RNode;
    if (button.getAttribute("aria-label") === label) {
      button.focus();
      const active = document.activeElement;
      return {
        found: true,
        activeLabel: active === null ? null : active.getAttribute("aria-label"),
      };
    }
  }
  return { found: false, activeLabel: null };
}

/** The accessible name of the focused element, read at the moment of the call. SELF-CONTAINED. */
export function rendererActiveLabel(): string | null {
  const active = document.activeElement;
  return active === null ? null : active.getAttribute("aria-label");
}

/**
 * After a launch press (FIX4A m4): only the pressed control's status changed. The project's status
 * line carries nothing about the Finder control (neither before nor after), and no card other than
 * the project shortcuts has a launch status. Returns what is wrong; an empty list is a pass.
 */
export function checkOnlyPressedChanged(
  before: readonly OverviewCard[],
  after: readonly OverviewCard[],
  _action: PressableLauncher,
): string[] {
  const problems: string[] = [];
  const title = OVERVIEW_TEXT.projectShortcutsTitle;
  for (const [when, cards] of [
    ["before", before],
    ["after", after],
  ] as const) {
    const status = cardByTitle(cards, title)?.launchStatus ?? "";
    if (status.includes(OVERVIEW_TEXT.finderWord)) {
      problems.push(
        `the launch status line mentions the ${OVERVIEW_TEXT.finderWord} control ${when} the press`,
      );
    }
  }
  for (const card of after) {
    if (card.title === title) continue;
    const beforeCard = cardByTitle(before, card.title);
    if ((card.launchStatus ?? null) !== (beforeCard?.launchStatus ?? null)) {
      problems.push(`${card.title} changed its launch status, but only ${title} may`);
    }
  }
  return problems;
}

export interface LaunchPressInput {
  readonly projectName: string;
  readonly action: PressableLauncher;
  /** The rows of {@link LAUNCHER_ROWS_SQL} from a read-only copy of the sandbox store. */
  readonly readLauncherRows: () => Promise<readonly unknown[]>;
  readonly poll?: Pick<PollOptions, "timeoutMs" | "intervalMs" | "sleep" | "now">;
}

export interface LaunchPressResult {
  readonly label: string;
  /** The launch status line after the press. */
  readonly status: string;
}

/**
 * Presses a project's launch control with the keyboard, but only where the press can do nothing
 * except be refused (T-08-48). Before anything else it checks the action is one that needs a saved
 * configuration and that the sandbox store holds none for it; with a launcher saved, or an
 * unreadable store, it throws before touching the page. Then it focuses the named, enabled control,
 * checks focus landed on it, presses Enter once and waits for the typed not-set-up outcome.
 */
export async function pressLaunchControl(
  browser: OverviewBrowser,
  input: LaunchPressInput,
): Promise<LaunchPressResult> {
  assertPressable(input.action);
  assertNoLauncherSaved(await input.readLauncherRows(), input.action);
  const label = launchControlLabel(input.action, input.projectName);
  const cards = await readOverviewCards(browser);
  const projects = cardByTitle(cards, OVERVIEW_TEXT.projectShortcutsTitle);
  const control = projects?.launch.find((button) => button.label === label);
  if (control === undefined || control.disabled) {
    throw new Error(`The launch control "${label}" is missing or disabled.`);
  }
  const focus = await browser.execute(rendererFocusControl, OVERVIEW_CLASSES.launchToolbar, label);
  if (!focus.found || focus.activeLabel !== label) {
    throw new Error("The launch control did not take keyboard focus, so nothing was pressed.");
  }
  // Re-read what holds focus immediately before Enter (FIX4A m4): an Enter sent while focus had
  // moved to a neighbour (the Finder control sits in the same toolbar) would press that instead.
  const stillFocused = await browser.execute(rendererActiveLabel);
  if (stillFocused !== label) {
    throw new Error("Focus moved off the launch control before Enter, so nothing was pressed.");
  }
  await browser.keys(ENTER_KEY);
  let last = "";
  await pollUntil(
    async () => {
      const after = await readOverviewCards(browser);
      last = cardByTitle(after, OVERVIEW_TEXT.projectShortcutsTitle)?.launchStatus ?? "";
      return checkLaunchOutcome(after, input.action).length === 0;
    },
    {
      timeoutMs: input.poll?.timeoutMs ?? 10_000,
      intervalMs: input.poll?.intervalMs ?? 250,
      ...(input.poll?.sleep === undefined ? {} : { sleep: input.poll.sleep }),
      ...(input.poll?.now === undefined ? {} : { now: input.poll.now }),
      describe: `the typed not-set-up outcome of the launch status line (it last read "${last}")`,
    },
  );
  const only = checkOnlyPressedChanged(cards, await readOverviewCards(browser), input.action);
  if (only.length > 0) throw new Error(only.join("; "));
  return { label, status: last };
}

/** Programs whose start would open an app, a Finder window, a terminal or a browser. */
const LAUNCHER_PROGRAM =
  /(?:^|\/)(?:open|osascript|Terminal|iTerm2?|Antigravity|WezTerm|wezterm(?:-gui)?|[Gg]hostty|Finder|Safari|Google Chrome|firefox|Claude|claude)(?:\.app\/|\s|$)/;

/** The processes among `nodes` that are launcher programs; git and security helpers are not. */
export function findLauncherProcesses(nodes: readonly ProcessNode[]): ProcessNode[] {
  return nodes.filter((node) => LAUNCHER_PROGRAM.test(node.command));
}

// ---------------------------------------------------------------------------
// Item 8: no fixture marker in the built plugin or on a slice card

/** The largest main.js the scan will read: a plugin bundle is a few megabytes. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * Reads `main.js` of the staged plugin copy (the build the sandbox Obsidian loaded) and names the
 * fixture markers in it, by name only. The stage folder must be inside the run root and `main.js`
 * a plain file, so the scan can never be pointed at the owner's installed plugin.
 */
export function scanBuiltPlugin(
  stageDir: string,
  runRoot: string,
): { bytes: number; markers: string[] } {
  if (!isStrictlyInside(runRoot, stageDir)) {
    throw new Error("Refusing a plugin stage folder outside the run root.");
  }
  const mainPath = join(stageDir, "main.js");
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(mainPath);
  } catch {
    throw new Error("The staged plugin has no main.js to scan.");
  }
  if (info.isSymbolicLink()) throw new Error("Refusing a linked main.js.");
  if (!info.isFile() || info.size > MAX_BUNDLE_BYTES) {
    throw new Error("The staged main.js is not a plain file of a plausible size.");
  }
  return { bytes: info.size, markers: findFixtureMarkers(readFileSync(mainPath, "utf8")) };
}

/** Names the fixture markers that reached any slice card's text (D-22: the cards read service data only). */
export function checkNoFixtureOnCards(cards: readonly OverviewCard[]): string[] {
  const found = findFixtureMarkers(JSON.stringify(cards));
  return found.map((name) => `a synthetic fixture marker (${name}) reached the Overview`);
}

// ---------------------------------------------------------------------------
// Item 3: completing the tasks due today and overdue, in the sandbox vault only

/**
 * The text of a task note marked done, the way the plugin's own status change writes it: `status`
 * becomes `done`, `updated` moves and `completed` is set; every other line stays byte for byte.
 */
export function markDoneText(text: string, nowIso: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("The note has no front matter.");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("The note has no front matter.");
  const head = lines.slice(1, end);
  const statusAt = head.findIndex((line) => /^status:/.test(line));
  if (statusAt < 0) throw new Error("The note has no status line.");
  head[statusAt] = "status: done";
  const stamp = `'${nowIso}'`;
  const updatedAt = head.findIndex((line) => /^updated:/.test(line));
  if (updatedAt < 0) head.push(`updated: ${stamp}`);
  else head[updatedAt] = `updated: ${stamp}`;
  const completedAt = head.findIndex((line) => /^completed:/.test(line));
  if (completedAt >= 0) head[completedAt] = `completed: ${stamp}`;
  else head.splice(head.findIndex((line) => /^updated:/.test(line)) + 1, 0, `completed: ${stamp}`);
  return [lines[0], ...head, ...lines.slice(end)].join("\n");
}

export interface CompleteDeps {
  readonly zone: string;
  readonly nowIso: string;
  readonly dueToday: (zone: string) => Promise<{
    readonly due: readonly { readonly taskId: string }[];
    readonly overdue: readonly { readonly taskId: string }[];
  }>;
  readonly readNotes: () => readonly NoteFile[];
  /** Overwrites one task note, named by its vault-relative path (the service lists every scope). */
  readonly writeNote: (path: string, text: string) => void;
  readonly poll?: Pick<PollOptions, "timeoutMs" | "intervalMs" | "sleep" | "now">;
}

const COMPLETE_ROUNDS = 8;

/**
 * Marks every task the service lists as due today or overdue done, round by round (the feed is
 * capped), waiting each round until the service no longer lists the ones just written. Returns how
 * many notes it completed. Writes go through `writeNote`, which the spec binds to the sandbox vault.
 * `readNotes` must cover every scope: the service lists workspace tasks as well as global ones.
 */
export async function completeDueAndOverdue(deps: CompleteDeps): Promise<number> {
  let total = 0;
  for (let round = 0; round < COMPLETE_ROUNDS; round += 1) {
    const listed = await deps.dueToday(deps.zone);
    const ids = [...new Set([...listed.overdue, ...listed.due].map((row) => row.taskId))];
    if (ids.length === 0) return total;
    const files = deps.readNotes();
    for (const id of ids) {
      const note = noteById(files, id);
      if (note === undefined) throw new Error("The service lists a task that has no note to edit.");
      deps.writeNote(note.path, markDoneText(note.text, deps.nowIso));
      total += 1;
    }
    await pollUntil(
      async () => {
        const again = await deps.dueToday(deps.zone);
        const still = new Set([...again.overdue, ...again.due].map((row) => row.taskId));
        return ids.every((id) => !still.has(id));
      },
      {
        timeoutMs: deps.poll?.timeoutMs ?? 20_000,
        intervalMs: deps.poll?.intervalMs ?? 250,
        ...(deps.poll?.sleep === undefined ? {} : { sleep: deps.poll.sleep }),
        ...(deps.poll?.now === undefined ? {} : { now: deps.poll.now }),
        describe: "the service to stop listing the tasks just completed",
      },
    );
  }
  throw new Error(`Tasks were still due after ${COMPLETE_ROUNDS} rounds of completing them.`);
}

/**
 * The managed task that guarantees a next open task whatever the fixture holds: ready, no owner
 * text, due a week after the machine's today in the owner's zone.
 */
export function upcomingTaskRequest(zone: string, nowMs: number): TaskCreateRequest {
  return {
    title: "Slice proof upcoming task",
    intent: "ready",
    zone,
    dueDate: shiftLocalDate(localDateIn(zone, nowMs), 7),
  };
}

/** The saved launchers of the sandbox store, read from a read-only copy inside the run root. */
export async function readLauncherRows(context: RunContext): Promise<unknown[]> {
  const destDir = join(context.paths.tmpDir, "overview-store-copy");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const { copyPath } = copyStore({
    runtimeDir: context.paths.runtimeDir,
    destDir,
    runRoot: context.runRoot,
  });
  return queryStore({ copyPath, sql: LAUNCHER_ROWS_SQL, runRoot: context.runRoot });
}
