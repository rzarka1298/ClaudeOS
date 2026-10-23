import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type AuthenticatedSocketApiClient, registerProject } from "@ccc/service-api-client";
import { type DriverBrowser, pollUntil } from "../driver.js";
import { appendLedger } from "../ledger.js";
import { isStrictlyInside } from "../plugin-data.js";
import { readProcessTable } from "../process-table.js";
import type { RunRootPaths } from "../run-root.js";
import type { RunContext } from "../spec-context.js";
import { OVERVIEW_CLASSES, OVERVIEW_TEXT, SLICE_CARD_TITLES } from "./overview-copy.js";
import {
  buildSessionStartRecord,
  ledgerPidsOf,
  runHook,
  type SacrificialChild,
  spawnSacrificialChild,
} from "./synthetic-session.js";
import { pluginCommandId, rendererClick, WAIT } from "./tasks-support.js";

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
}

declare const document: {
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
