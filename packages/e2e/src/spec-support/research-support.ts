import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  REPORT_ITEM_KIND_DISPLAY,
  REPORT_ITEM_KINDS,
  type ResearchReportItemsPage,
  type ResearchReportSourcesPage,
} from "@ccc/domain";
import {
  type AuthenticatedSocketApiClient,
  createAuthenticatedClient,
  createResearchClient,
  type ResearchClient,
} from "@ccc/service-api-client";
import { type DriverBrowser, pollUntil } from "../driver.js";
import {
  prepareResearchUat,
  type ResearchGuardEnv,
  type ResearchUatPrepared,
} from "../research-uat-fixture.js";
import { readLedger } from "../ledger.js";
import { readProcessTable } from "../process-table.js";
import { INSTALLED_OBSIDIAN_BINARY } from "../repo-paths.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../spec-context.js";
import { copyStore, queryStore } from "../store-copy.js";
import { RESEARCH_CLASSES, RESEARCH_TEXT } from "./research-copy.js";
import {
  type ReadingViewFacts,
  type RenderedReader,
  type RenderedResearch,
  type ResearchDomConfig,
  rendererClickByText,
  rendererClickNth,
  rendererReadReadingView,
  rendererReadResearch,
  rendererReadTranscript,
  rendererStartTranscript,
  type TranscriptRecord,
} from "./research-dom.js";
import { type ProcessNode, diffNewDescendants, readProcessTree } from "./cross-support.js";
import { RESEARCH_FOLDERS, readFolderNotes } from "./research-notes.js";
import {
  assertVaultInsideRunRoot,
  type NoteFile,
  pluginCommandId,
  rendererClick,
  WAIT,
} from "./tasks-support.js";

/**
 * Support for the research specs (plan 07-17, D-28): the throwaway service started with the
 * guard environment on fixtures, the typed readers of the Research destination, and the helpers
 * that run one real pipeline run to its end. Everything is spec side; the renderer functions are
 * in research-dom.ts. Waits are conditions (`pollUntil`), never fixed sleeps.
 *
 * A research run here is always the REAL pipeline of the built service (real fetch stage over the
 * fixture reader, real sanitiser, real summariser double, real vault writers and store rows), so
 * the operational store holds the provenance records a verified quote needs (ADR 0030). Nothing in
 * this module writes a note or a store row.
 */

/** The slice of the wdio browser the research helpers use. */
export interface ResearchBrowser extends DriverBrowser {
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
  executeObsidian<T, A extends unknown[]>(
    fn: (ctx: never, ...args: A) => T | Promise<T>,
    ...args: A
  ): Promise<T>;
}

export function asResearchBrowser(browser: unknown): ResearchBrowser {
  return browser as ResearchBrowser;
}

/** The class names the DOM readers need, from the mirrored table. */
export const DOM_CONFIG: ResearchDomConfig = {
  root: RESEARCH_CLASSES.root,
  runBox: RESEARCH_CLASSES.runBox,
  reason: RESEARCH_CLASSES.reason,
  strip: RESEARCH_CLASSES.strip,
  statusLine: RESEARCH_CLASSES.statusLine,
  runStatus: RESEARCH_CLASSES.runStatus,
  setupCallout: RESEARCH_CLASSES.setupCallout,
  sourcesConfig: RESEARCH_CLASSES.sourcesConfig,
  layout: RESEARCH_CLASSES.layout,
  listCell: RESEARCH_CLASSES.listCell,
  readerCell: RESEARCH_CLASSES.readerCell,
  listRegion: RESEARCH_CLASSES.listRegion,
  listEmpty: RESEARCH_CLASSES.listEmpty,
  listError: RESEARCH_CLASSES.listError,
  emptyHeading: RESEARCH_CLASSES.emptyHeading,
  row: RESEARCH_CLASSES.row,
  rowButton: RESEARCH_CLASSES.rowButton,
  rowMeta: RESEARCH_CLASSES.rowMeta,
  listMore: RESEARCH_CLASSES.listMore,
  badge: RESEARCH_CLASSES.badge,
  badgeGlyph: RESEARCH_CLASSES.badgeGlyph,
  badgeLabel: RESEARCH_CLASSES.badgeLabel,
  hidden: RESEARCH_CLASSES.hidden,
  reader: RESEARCH_CLASSES.reader,
  readerMeta: RESEARCH_CLASSES.readerMeta,
  readerCounts: RESEARCH_CLASSES.readerCounts,
  readerAi: RESEARCH_CLASSES.readerAi,
  readerStale: RESEARCH_CLASSES.readerStale,
  readerActions: RESEARCH_CLASSES.readerActions,
  readerUnavailable: RESEARCH_CLASSES.readerUnavailable,
  readerLegend: RESEARCH_CLASSES.readerLegend,
  readerItems: RESEARCH_CLASSES.readerItems,
  readerRun: RESEARCH_CLASSES.readerRun,
  item: RESEARCH_CLASSES.item,
  itemKind: RESEARCH_CLASSES.itemKind,
  itemText: RESEARCH_CLASSES.itemText,
  quoteCaption: RESEARCH_CLASSES.quoteCaption,
  quote: RESEARCH_CLASSES.quote,
  citations: RESEARCH_CLASSES.citations,
  source: RESEARCH_CLASSES.source,
  sourcesList: RESEARCH_CLASSES.sourcesList,
  detailFields: RESEARCH_CLASSES.detailFields,
  callout: RESEARCH_CLASSES.setupCallout,
  calloutHeading: RESEARCH_CLASSES.calloutHeading,
};

// ---------------------------------------------------------------------------
// The environment: a throwaway service on fixtures

/** The managed vault the runner generates holds 300 tasks plus four live-check ones. */
export const VAULT_TASKS_AT_LEAST = 304;

export interface ResearchEnvironment {
  readonly context: RunContext;
  readonly prepared: ResearchUatPrepared;
  /** The typed research client on the sandbox socket (status, list, report, run). */
  readonly research: ResearchClient;
  readonly client: AuthenticatedSocketApiClient;
  /** Stops the service (graceful, then forced) and starts it again with the chosen variables. */
  restart(options?: { summariser?: boolean }): Promise<void>;
  /** Stops the service only. */
  stopService(): Promise<void>;
  /** Starts the service again after {@link stopService}. */
  startService(options?: { summariser?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

function guardEnvFor(prepared: ResearchUatPrepared, summariser: boolean): ResearchGuardEnv {
  return summariser ? prepared.guardEnv : prepared.guardEnvWithoutSummariser;
}

/**
 * Resets the run's runtime directory, prepares the fixture universe inside it and starts the
 * built service with the guard variables. The CLI parent owns teardown (the service is ledgered
 * by the fixture); `stop` is the spec's own tidy-up. The summariser is the extractive double
 * unless `summariser: false` (07-UAT items 8 and 22).
 */
export async function startResearchEnvironment(
  options: { summariser?: boolean } = {},
): Promise<ResearchEnvironment> {
  const context = loadRunContext();
  const fixture = serviceFixtureFor(context);
  await fixture.resetData();
  const prepared = prepareResearchUat(context.paths.runtimeDir, {
    installAccount: context.account,
  });
  const client = createAuthenticatedClient({ socketPath: context.socketPath });
  const start = async (summariser: boolean): Promise<void> => {
    await fixture.start({ kind: "normal", researchEnv: guardEnvFor(prepared, summariser) });
  };
  await start(options.summariser ?? true);
  return {
    context,
    prepared,
    research: createResearchClient(client),
    client,
    restart: async (next = {}) => {
      await fixture.stop();
      await start(next.summariser ?? true);
    },
    stopService: () => fixture.stop(),
    startService: (next = {}) => start(next.summariser ?? true),
    stop: () => fixture.stop(),
  };
}

// ---------------------------------------------------------------------------
// The vault and the store (spec side, read only)

export interface VaultNotes {
  readonly output: NoteFile[];
  readonly raw: NoteFile[];
  readonly wiki: NoteFile[];
  readonly runs: NoteFile[];
}

/** Every research note of the sandbox vault, by managed folder. */
export function readVaultNotes(vaultPath: string, runRoot: string): VaultNotes {
  return {
    output: readFolderNotes(vaultPath, runRoot, RESEARCH_FOLDERS.output),
    raw: readFolderNotes(vaultPath, runRoot, RESEARCH_FOLDERS.raw),
    wiki: readFolderNotes(vaultPath, runRoot, RESEARCH_FOLDERS.wiki),
    runs: readFolderNotes(vaultPath, runRoot, RESEARCH_FOLDERS.runs),
  };
}

/**
 * Removes the research notes (not the generated `index.md`) from the sandbox vault so a spec file
 * starts from an empty Reports list whatever an earlier spec file left. The vault must be inside
 * the run root; nothing else is touched.
 */
export function clearResearchNotes(vaultPath: string, runRoot: string): void {
  assertVaultInsideRunRoot(vaultPath, runRoot);
  for (const folder of Object.values(RESEARCH_FOLDERS)) {
    for (const note of readFolderNotes(vaultPath, runRoot, folder)) {
      rmSync(join(vaultPath, note.path), { force: true });
    }
  }
}

/** Fixed statements over the copied store (never built from request text). */
export const JOB_RUNS_SQL =
  "select job_run_id, state, outcome, error_code, source_count, source_total, run_trigger, stage_log, report_note_id, started_at, ended_at from job_runs order by started_at, job_run_id;";
export const AUTOMATION_RUNS_SQL =
  "select run_id, kind, state from runs where kind = 'automation' order by started_at, run_id;";

export interface JobRunRow {
  job_run_id: string;
  state: string;
  outcome: string | null;
  error_code: string | null;
  source_count: number | null;
  source_total: number | null;
  run_trigger: string | null;
  stage_log: string | null;
  report_note_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface AutomationRunRow {
  run_id: string;
  kind: string;
  state: string;
}

/** Copies the operational store and reads the job runs and their paired runs from the copy. */
export async function readResearchStore(
  context: RunContext,
): Promise<{ jobs: JobRunRow[]; runs: AutomationRunRow[] }> {
  const destDir = join(context.paths.tmpDir, "research-store-copy");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const { copyPath } = copyStore({
    runtimeDir: context.paths.runtimeDir,
    destDir,
    runRoot: context.runRoot,
  });
  const jobs = (await queryStore({
    copyPath,
    sql: JOB_RUNS_SQL,
    runRoot: context.runRoot,
  })) as unknown as JobRunRow[];
  const runs = (await queryStore({
    copyPath,
    sql: AUTOMATION_RUNS_SQL,
    runRoot: context.runRoot,
  })) as unknown as AutomationRunRow[];
  return { jobs, runs };
}

// ---------------------------------------------------------------------------
// The destination

export async function readResearch(browser: ResearchBrowser): Promise<RenderedResearch> {
  return browser.execute(rendererReadResearch, DOM_CONFIG);
}

/**
 * Opens the command center on the Research destination and waits until its first load has
 * settled (the destination is no longer busy). The command center lives in the right sidebar
 * leaf, as for a user.
 */
export async function openResearch(browser: ResearchBrowser): Promise<RenderedResearch> {
  await browser.executeObsidianCommand(pluginCommandId("open-overview"));
  await pollUntil(
    async () => {
      await browser.executeObsidian(
        rendererClick,
        `#${RESEARCH_CLASSES.tabPrefix}${RESEARCH_TEXT.tabResearchId}`,
        null,
      );
      const read = await readResearch(browser);
      return read.mounted && !read.busy ? read : null;
    },
    { ...WAIT.connect, describe: "the Research destination to mount and finish its first load" },
  );
  return readResearch(browser);
}

/** Switches the command center to the Overview and back to Research, unmounting the destination. */
export async function leaveAndReturn(browser: ResearchBrowser): Promise<RenderedResearch> {
  await browser.executeObsidian(
    rendererClick,
    `#${RESEARCH_CLASSES.tabPrefix}${RESEARCH_TEXT.overviewTabId}`,
    null,
  );
  return openResearch(browser);
}

/** Presses Run now (the primary control of the header). False when the button is not there. */
export async function pressRunNow(browser: ResearchBrowser): Promise<boolean> {
  return browser.execute(rendererClickNth, `.${RESEARCH_CLASSES.runBox} button`, 0);
}

export async function startTranscript(browser: ResearchBrowser): Promise<boolean> {
  return browser.execute(
    rendererStartTranscript,
    RESEARCH_CLASSES.root,
    RESEARCH_CLASSES.statusLine,
    RESEARCH_CLASSES.runStatus,
    RESEARCH_TEXT.currentRunLabel,
  );
}

export async function readTranscript(browser: ResearchBrowser): Promise<TranscriptRecord[]> {
  return browser.execute(rendererReadTranscript);
}

/** True for the status line a finished run leaves: a report is ready, or the run failed. */
export function isRunEndLine(line: string): boolean {
  return (
    line.startsWith(RESEARCH_TEXT.reportReadyStem) || line.startsWith(RESEARCH_TEXT.runFailedPrefix)
  );
}

/** Waits until the status line says how the run ended; returns the destination as read then. */
export async function waitForRunEnd(
  browser: ResearchBrowser,
  describe = "the run to end",
): Promise<RenderedResearch> {
  return pollUntil(
    async () => {
      const read = await readResearch(browser);
      return read.mounted && isRunEndLine(read.status) ? read : null;
    },
    { timeoutMs: 120_000, intervalMs: 250, describe },
  );
}

// ---------------------------------------------------------------------------
// Rows, the reader and the connection

/** The kind labels by kind, as the report note's body writes them. */
export const KIND_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  REPORT_ITEM_KINDS.map((kind) => [kind, REPORT_ITEM_KIND_DISPLAY[kind].label]),
);

/** Waits until the destination is mounted, not dimmed and Run now can be pressed. */
export async function waitForConnected(browser: ResearchBrowser): Promise<RenderedResearch> {
  return pollUntil(
    async () => {
      const read = await readResearch(browser);
      return read.mounted && !read.dimmed && read.runNow.present && !read.runNow.disabled
        ? read
        : null;
    },
    { ...WAIT.connect, describe: "the plugin to reconnect and Run now to be available" },
  );
}

/** Presses `Back to reports` when the one-column layout shows an open report in place of the list. */
export async function closeReader(browser: ResearchBrowser): Promise<void> {
  const read = await readResearch(browser);
  if (read.reader === null || !read.reader.hasBackButton) return;
  await browser.execute(rendererClickByText, "button", RESEARCH_TEXT.backToReportsLabel);
  await pollUntil(async () => (await readResearch(browser)).reader === null, {
    ...WAIT.short,
    describe: "the reader to close",
  });
}

export interface ReportExpectation {
  /** The findings the reader must show once loaded, and the sources. */
  readonly items: number;
  readonly sources: number;
}

/**
 * Opens the `index`th report of the list (the newest is 0) and waits until the reader has loaded
 * every finding and every source. Closes an open report first in the one-column layout.
 */
export async function openReport(
  browser: ResearchBrowser,
  index: number,
  expected: ReportExpectation,
): Promise<RenderedReader> {
  await closeReader(browser);
  await pollUntil(
    () => browser.execute(rendererClickNth, `button.${RESEARCH_CLASSES.rowButton}`, index),
    { ...WAIT.short, describe: `report row ${index} to be there to open` },
  );
  const loaded = await pollUntil(
    async () => {
      const reader = (await readResearch(browser)).reader;
      return reader !== null &&
        !reader.loading &&
        reader.findings.length === expected.items &&
        reader.sources.length === expected.sources
        ? reader
        : null;
    },
    {
      ...WAIT.short,
      describe: `the report to load ${expected.items} findings and ${expected.sources} sources`,
    },
  );
  return loaded;
}

// ---------------------------------------------------------------------------
// The sandbox Obsidian: the active note and Reading view

interface ObsidianLeaf {
  setViewState(state: unknown): Promise<void>;
}
interface ObsidianCtx {
  app: {
    workspace: {
      getActiveFile(): { path: string } | null;
      getLeaf(mode: string): ObsidianLeaf;
      setActiveLeaf(leaf: ObsidianLeaf, options: { focus: boolean }): void;
    };
    vault: { getFileByPath(path: string): { path: string } | null };
  };
}

/** The vault-relative path of the note Obsidian has active, or null. */
export function rendererActiveFile({ app }: ObsidianCtx): string | null {
  return app.workspace.getActiveFile()?.path ?? null;
}

/** Opens a vault note in a new tab in Reading view (not Live Preview, not source). */
export async function rendererOpenInReading({ app }: ObsidianCtx, path: string): Promise<boolean> {
  const file = app.vault.getFileByPath(path);
  if (file === null) return false;
  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({
    type: "markdown",
    state: { file: file.path, mode: "preview" },
    active: true,
  });
  app.workspace.setActiveLeaf(leaf, { focus: true });
  return true;
}

export async function readActiveFile(browser: ResearchBrowser): Promise<string | null> {
  return browser.executeObsidian(rendererActiveFile);
}

/** Waits until Obsidian's active note is `path`. */
export async function waitForActiveFile(browser: ResearchBrowser, path: string): Promise<void> {
  await pollUntil(async () => (await readActiveFile(browser)) === path, {
    ...WAIT.short,
    describe: `${path} to be the active note`,
  });
}

/**
 * Opens `path` in Reading view and returns what the rendered body holds once it has rendered
 * (the body text is non-empty). The Properties panel is not part of the body.
 */
export async function readNoteInReadingView(
  browser: ResearchBrowser,
  path: string,
): Promise<ReadingViewFacts> {
  const opened = await browser.executeObsidian(rendererOpenInReading, path);
  if (!opened) throw new Error(`The note ${path} could not be opened in Reading view.`);
  return pollUntil(
    async () => {
      const facts = await browser.execute(rendererReadReadingView);
      return facts.found && facts.text.trim() !== "" ? facts : null;
    },
    { ...WAIT.short, describe: "the note to render in Reading view" },
  );
}

// ---------------------------------------------------------------------------
// The service log and the processes around a run

/** The live service log (`logs/service.log` of the run's runtime directory); empty before it exists. */
export function readServiceLog(context: RunContext): string {
  const live = join(context.paths.runtimeDir, "logs", "service.log");
  return existsSync(live) ? readFileSync(live, "utf8") : "";
}

/** Every service log of the run: the kept ones of earlier services, then the live one. */
export function readAllServiceLogs(context: RunContext): string {
  const kept = join(context.paths.runtimeDir, "kept-logs");
  let archived = "";
  if (existsSync(kept)) {
    for (const name of readdirSync(kept).sort()) {
      const file = join(kept, name);
      if (statSync(file).isFile()) archived += readFileSync(file, "utf8");
    }
  }
  return archived + readServiceLog(context);
}

/** The size of the live log in characters, to read only what a later step added. */
export function serviceLogMark(context: RunContext): number {
  return readServiceLog(context).length;
}

export function readServiceLogSince(context: RunContext, mark: number): string {
  return readServiceLog(context).slice(mark);
}

/** The pids of the throwaway service and of the sandbox Obsidian: the run's own two processes. */
export async function sandboxAncestors(context: RunContext): Promise<number[]> {
  const table = await readProcessTable();
  const service = readLedger(context.paths.ledgerPath)
    .filter((entry) => entry.kind === "pid" && entry.role === "service")
    .map((entry) => (entry.kind === "pid" ? entry.pid : 0));
  const obsidian = table
    .filter(
      (row) =>
        row.command.startsWith(INSTALLED_OBSIDIAN_BINARY) &&
        row.command.includes(context.runRoot) &&
        !row.command.includes("--type="),
    )
    .map((row) => row.pid);
  return [...service, ...obsidian];
}

export interface DescendantWatch {
  /** Stops watching; resolves with every new process seen below the ancestors since the start. */
  stop(): Promise<ProcessNode[]>;
}

/**
 * Samples the process tree every `everyMs` and collects each process that appeared below the
 * ancestors after the watch began (a short-lived child is caught if it lived through a sample).
 * Electron helper processes are left out by `diffNewDescendants`.
 */
export function watchDescendants(ancestors: readonly number[], everyMs = 100): DescendantWatch {
  let stopped = false;
  const seen = new Map<string, ProcessNode>();
  const loop = (async () => {
    const before = await readProcessTree();
    while (!stopped) {
      await new Promise<void>((done) => setTimeout(done, everyMs));
      const now = await readProcessTree();
      for (const node of diffNewDescendants(before, now, ancestors)) {
        seen.set(`${node.pid}:${node.command}`, node);
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return [...seen.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// The service's own answers (a second source for what the view shows)

/** Every findings page of a report, following the service's cursor. */
export async function readItemsPages(
  research: ResearchClient,
  noteId: string,
): Promise<ResearchReportItemsPage[]> {
  const pages: ResearchReportItemsPage[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = (await research.report({
      noteId,
      page: "items",
      ...(cursor === undefined ? {} : { cursor }),
    })) as ResearchReportItemsPage;
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("The findings pages never ended.");
}

export async function readSourcesPage(
  research: ResearchClient,
  noteId: string,
): Promise<ResearchReportSourcesPage> {
  return (await research.report({ noteId, page: "sources" })) as ResearchReportSourcesPage;
}

// ---------------------------------------------------------------------------
// One run of a scenario

export interface ScenarioRun {
  /** The destination as read when the status line said how the run ended. */
  readonly read: RenderedResearch;
  /** The id of the run that just ended (a success or a failure), from the service. */
  readonly runId: string;
  readonly ok: boolean;
  /** Epoch milliseconds just before the press. */
  readonly notBefore: number;
}

/**
 * Selects the scenario's sources, makes sure the destination is open, presses Run now and waits
 * until the status line says how the run ended; then asks the service which run that was.
 */
export async function runScenario(
  browser: ResearchBrowser,
  env: ResearchEnvironment,
  scenario: Parameters<ResearchUatPrepared["select"]>[0],
): Promise<ScenarioRun> {
  env.prepared.select(scenario);
  const opened = await openResearch(browser);
  const notBefore = Date.now();
  if (!(await pressRunNow(browser))) throw new Error("The Run now button could not be pressed.");
  // Wait for the press to register (the status line leaves the previous run's sentence).
  await pollUntil(
    async () => {
      const read = await readResearch(browser);
      return read.status !== opened.status || read.runNow.busy ? read : null;
    },
    { ...WAIT.short, describe: "the press to register" },
  );
  const read = await waitForRunEnd(browser);
  const status = await env.research.status();
  const success = status.lastSuccess;
  const failure = status.lastFailure;
  const latest =
    success !== null && (failure === null || success.endedAt >= failure.endedAt)
      ? { runId: success.runId, ok: true }
      : { runId: failure?.runId ?? "", ok: false };
  return { read, runId: latest.runId, ok: latest.ok, notBefore };
}
