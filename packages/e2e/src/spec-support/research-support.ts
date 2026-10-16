import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
import { loadRunContext, type RunContext, serviceFixtureFor } from "../spec-context.js";
import { copyStore, queryStore } from "../store-copy.js";
import { RESEARCH_CLASSES, RESEARCH_TEXT } from "./research-copy.js";
import {
  type RenderedResearch,
  type ResearchDomConfig,
  rendererClickNth,
  rendererReadResearch,
  rendererReadTranscript,
  rendererStartTranscript,
  type TranscriptRecord,
} from "./research-dom.js";
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
