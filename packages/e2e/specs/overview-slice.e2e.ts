/**
 * The Overview slice of the Phase 8 UAT (plan 08-19, SLICE-01, D-19 to D-23, D-27, D-46): a
 * registered project with its launch control, a synthetic Claude session, a managed task of the
 * fixture vault and the latest cited research report, read on one Overview screen with their source
 * and freshness. Everything runs inside the run's sandbox: its own runtime folder and service, a
 * project folder in the run root, a sacrificial child standing in for the Claude process, the
 * 300-task fixture vault and the Phase 7 extractive research fixture. No network, no model, and
 * nothing of the owner's runtime, store, vaults or Keychain; the service gets the sandbox
 * research-key account through `startResearchEnvironment`. Nothing opens on the owner's desktop:
 * item 6 presses a launch control only while no launcher is saved, and watches for launcher
 * processes. Authored and CI-verified only (D-15); the live behaviour is first seen in the
 * orchestrator's run at the final head (D-30).
 *
 * The cases share one service and one vault, so their order matters: item 4 first (the Technology
 * card must be empty before the first report), then the cases that need a report, a project or a
 * session, then the case that completes the vault's due tasks, and the disconnect drill last.
 */
import { createTasksClient } from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { loadRunContext } from "../src/spec-context.js";
import { OVERVIEW_CLASSES, OVERVIEW_TEXT } from "../src/spec-support/overview-copy.js";
import {
  asOverviewBrowser,
  cardByTitle,
  checkCalendarGmail,
  checkDisconnected,
  checkFailureLine,
  checkLaunchOutcome,
  checkNextOpen,
  checkNoFailures,
  checkNoFixtureOnCards,
  checkRecovered,
  checkSliceCards,
  checkTechEmpty,
  checkTechLatest,
  completeDueAndOverdue,
  findLauncherProcesses,
  pressLaunchControl,
  readLauncherRows,
  readOverviewCards,
  reopenOverview,
  type SliceSeed,
  scanBuiltPlugin,
  seedSlice,
  sliceSeedDeps,
  upcomingTaskRequest,
  waitForSlice,
  waitForVerdict,
} from "../src/spec-support/overview-support.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  type ResearchEnvironment,
  readResearch,
  runScenario,
  sandboxAncestors,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
  watchDescendants,
} from "../src/spec-support/research-support.js";
import {
  reapSacrificialChildren,
  type SacrificialChild,
} from "../src/spec-support/synthetic-session.js";
import {
  asTasksBrowser,
  readTaskNotes,
  recordResults,
  rendererClick,
  runSetUpManagedVault,
  WAIT,
  writeTaskNote,
} from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const rb = asResearchBrowser(browser);
const ob = asOverviewBrowser(browser);

describe("overview slice", () => {
  let env: ResearchEnvironment;
  /** The sacrificial children standing in for Claude processes; reaped in `after`. */
  const registry: SacrificialChild[] = [];
  let seed: SliceSeed | undefined;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
    clearResearchNotes(obsidianPage.getVaultPath(), env.context.runRoot);
  });

  after(async () => {
    await reapSacrificialChildren(registry);
    await env?.stop();
  });

  const vaultPath = (): string => obsidianPage.getVaultPath();

  /** Registers the sandbox project and starts the synthetic session once; later cases reuse them. */
  async function ensureSeed(): Promise<SliceSeed> {
    if (seed === undefined) {
      seed = await seedSlice(sliceSeedDeps(env.context, env.client, registry));
    }
    return seed;
  }

  /** The newest readable report as the service lists it, or undefined. */
  async function newestReport() {
    const list = await env.research.list({ limit: 1 });
    const row = list.rows.find((entry) => entry.readable);
    return row?.readable === true ? row : undefined;
  }

  /** Makes sure one cited fixture report exists, running the extractive fixture scenario if not. */
  async function ensureReport(): Promise<void> {
    if ((await newestReport()) !== undefined) return;
    const run = await runScenario(rb, env, "base");
    expect(run.ok).toBe(true);
  }

  it("[08-UAT#04] Technology panel: empty, then the latest cited report, then the reader", async () => {
    // Before any report the card says so and offers none.
    expect(await newestReport()).toBeUndefined();
    await reopenOverview(ob);
    await waitForVerdict(ob, checkTechEmpty, "the Technology card to read No reports yet");

    // After one fixture run it shows the report, as Cached, never Live.
    const run = await runScenario(rb, env, "base");
    expect(run.ok).toBe(true);
    const row = await newestReport();
    if (row === undefined) throw new Error("The fixture run left no readable report.");
    const facts = { title: row.title, sourceCount: row.sourceCount, itemCount: row.itemCount };
    await reopenOverview(ob);
    await waitForVerdict(
      ob,
      (cards) => checkTechLatest(cards, facts),
      "the Technology card to show the latest cited report",
    );

    // Open report reaches that report in the Research reader.
    expect(
      await browser.executeObsidian(
        rendererClick,
        `.${OVERVIEW_CLASSES.intelLatest} button.${OVERVIEW_CLASSES.connectButton}`,
        OVERVIEW_TEXT.openReport,
      ),
    ).toBe(true);
    const reader = await pollUntil(
      async () => {
        const read = await readResearch(rb);
        const open = read.reader;
        return read.mounted &&
          open !== null &&
          !open.loading &&
          open.failureHeading === null &&
          open.title === facts.title
          ? open
          : null;
      },
      { ...WAIT.short, timeoutMs: 30_000, describe: "the Research reader to open the report" },
    );
    expect(reader.findings.length).toBeGreaterThan(0);
  });

  it("[08-UAT#01] The Overview shows the slice on fixture sources", async () => {
    const planted = await ensureSeed();
    await ensureReport();
    await reopenOverview(ob);
    // The session reaches the Overview by event and the report by the remount's fetch; wait for
    // all five parts to be on the screen, then judge them (a timeout names what was missing).
    const cards = await waitForSlice(ob, planted);
    expect(checkSliceCards(cards, planted)).toEqual([]);
  });

  it("[08-UAT#02] Today names Calendar and Gmail honestly", async () => {
    await reopenOverview(ob);
    const cards = await waitForVerdict(
      ob,
      checkCalendarGmail,
      "Today to name Calendar and Gmail as not part of this version",
    );
    expect(checkCalendarGmail(cards)).toEqual([]);
  });

  it("[08-UAT#05] A failed research run shows in Today and clears after a good run", async () => {
    // Every source fails: the run ends in a failure and Today's automation line says so.
    const failing = await runScenario(rb, env, "all-failing");
    expect(failing.ok).toBe(false);
    await reopenOverview(ob);
    await waitForVerdict(ob, checkFailureLine, "Today to show the failed research run");

    // A good run makes it a newer success, and the failure line clears.
    const good = await runScenario(rb, env, "base");
    expect(good.ok).toBe(true);
    await reopenOverview(ob);
    await waitForVerdict(ob, checkNoFailures, "Today to clear the failure after a good run");
  });

  it("[08-UAT#06] The launch control is present, wired and keyboard operable", async () => {
    const planted = await ensureSeed();
    await reopenOverview(ob);
    await waitForVerdict(
      ob,
      (cards) =>
        cardByTitle(cards, OVERVIEW_TEXT.projectShortcutsTitle)?.rows.some(
          (row) => row.primary === planted.projectName,
        ) === true
          ? []
          : ["the project row is not on the Overview"],
      "the project row with its launch control",
    );
    // Anything that starts below the service or the sandbox Obsidian during the press is recorded.
    const watch = watchDescendants(await sandboxAncestors(env.context));
    let started: ReturnType<typeof findLauncherProcesses> = [];
    try {
      const pressed = await pressLaunchControl(ob, {
        projectName: planted.projectName,
        action: "antigravity",
        readLauncherRows: () => readLauncherRows(env.context),
      });
      expect(pressed.status).toContain(OVERVIEW_TEXT.launcherNextStep);
    } finally {
      started = findLauncherProcesses(await watch.stop());
    }
    // Nothing opened: no app, Finder window, terminal or browser was started.
    expect(started.map((node) => node.command.slice(0, 120))).toEqual([]);
    expect(checkLaunchOutcome(await readOverviewCards(ob), "antigravity")).toEqual([]);
  });

  it("[08-UAT#08] No fixture or constant data reaches the production Overview", async () => {
    // The build the sandbox Obsidian loaded holds none of the synthetic fixture markers ...
    const scan = scanBuiltPlugin(env.context.pluginStage, env.context.runRoot);
    expect(scan.bytes).toBeGreaterThan(0);
    expect(scan.markers).toEqual([]);
    // ... and the cards the slice reads show none of them either.
    await reopenOverview(ob);
    expect(checkNoFixtureOnCards(await readOverviewCards(ob))).toEqual([]);
  });

  it("[08-UAT#03] With nothing due today, Today shows the next open task", async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tasks = createTasksClient(env.client);
    // A dated task a week away, so a next open task exists whatever the fixture holds.
    await tasks.create(upcomingTaskRequest(zone, Date.now()));
    await completeDueAndOverdue({
      zone,
      nowIso: new Date().toISOString(),
      dueToday: (inZone) => tasks.dueToday({ zone: inZone }),
      readNotes: () => readTaskNotes(vaultPath(), env.context.runRoot),
      writeNote: (path, text) => writeTaskNote(vaultPath(), env.context.runRoot, path, text),
    });
    await reopenOverview(ob);
    const cards = await waitForVerdict(ob, checkNextOpen, "Today to show the next open task");
    expect(checkNextOpen(cards)).toEqual([]);
  });

  it("[08-UAT#07] Overview disconnect drill", async () => {
    // Both cards hold values before the service stops.
    await reopenOverview(ob);
    await waitForVerdict(ob, checkRecovered, "Today and Technology to hold their values");

    await env.stopService();
    const down = await waitForVerdict(
      ob,
      checkDisconnected,
      "Today and Technology to read Service disconnected",
      WAIT.connect,
    );
    expect(checkDisconnected(down)).toEqual([]);

    // The service comes back and both recover without a reload.
    await env.startService();
    const up = await waitForVerdict(
      ob,
      checkRecovered,
      "Today and Technology to recover after the restart",
      WAIT.connect,
    );
    expect(checkRecovered(up)).toEqual([]);
  });
});
