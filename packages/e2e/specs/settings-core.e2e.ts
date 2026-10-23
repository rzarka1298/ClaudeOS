/**
 * The core items of the Settings destination in the Phase 8 UAT (plan 08-22, DIAG-01, SC3, D-15 to
 * D-18, D-44): every section reachable by keyboard and pointer with deep-link focus, registering a
 * project and adding a scan folder, the launchers, the read-only paths, reduced motion, the
 * security and schedules facts, the service stopped, the keyboard walk, live contrast in both
 * Obsidian themes, and the privacy of the plugin data file and the service log.
 *
 * Every case drives the command center's own Settings destination, never Obsidian's native settings
 * dialog, which the runner cannot attach to (05.2 D-09). Everything runs inside the run's sandbox:
 * its own runtime folder, Claude config folder, store and throwaway vault. The service comes from
 * `startResearchEnvironment`, so a gesture health check (opening Security, Paths or Diagnostics, or
 * pressing Run checks again) asks about a nonexistent `ccc-uat-` research-key account and never the
 * owner's. Every change a case makes sits inside `withRestore` (a source scan in
 * settings-support.test.ts fails on a mutating call outside it), nothing launches an app, and
 * failure messages name sections, controls and categories, never a path or a value. Authored and
 * CI-verified only (D-15); the live behaviour is first seen in the orchestrator's run at the final
 * head (D-30).
 *
 * Case order follows the shared state, not the numbers: 09 (reach every section), 10 (register,
 * remove), 11 (launchers), 12 (paths), 13 and 34 (reduced motion), 14 (security and schedules), 16
 * (the keyboard walk), 15 (the service stopped and restarted), 17 (contrast and the look), and 18
 * (the privacy of what the others left behind) last.
 */
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { registerProject, removeProject, removeScanRoot } from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { Key } from "webdriverio";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { PLUGIN_ID } from "../src/plugin-data.js";
import { loadRunContext } from "../src/spec-context.js";
import { APPROVALS_COPY } from "../src/spec-support/approvals-copy.js";
import { lowestRatios, readContrastInBothThemes } from "../src/spec-support/contrast-probe.js";
import { recordLookPending, sampleMotionInRenderer } from "../src/spec-support/cross-support.js";
import { HEALTH_TEXT } from "../src/spec-support/health-copy.js";
import {
  makeDirInRunRoot,
  removeEmptyDirInRunRoot,
  removeFileInRunRoot,
  writeFakeExecutable,
} from "../src/spec-support/health-drill-support.js";
import {
  drillFiles,
  openDiagnostics,
  pressInRow,
  withRestore,
} from "../src/spec-support/health-support.js";
import {
  asOverviewBrowser,
  findLauncherProcesses,
  openOverview,
  readLauncherRows,
} from "../src/spec-support/overview-support.js";
import {
  rendererClearSpies,
  rendererInstallSpies,
  rendererReadSpies,
} from "../src/spec-support/research-dom.js";
import {
  captureLook,
  type ShotBrowser,
  withEnlargedLayout,
} from "../src/spec-support/research-shots.js";
import {
  type ResearchEnvironment,
  readAllServiceLogs,
  sandboxAncestors,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
  watchDescendants,
} from "../src/spec-support/research-support.js";
import {
  SETTINGS_CLASSES,
  SETTINGS_SECTION_IDS,
  SETTINGS_TEXT,
  type SettingsSectionKey,
  sectionLabel,
} from "../src/spec-support/settings-copy.js";
import {
  addScanFolder,
  asSettingsBrowser,
  checkContrastReading,
  checkDataJson,
  checkFocusNotMoved,
  checkKeyboardWalk,
  checkLauncherSaved,
  checkLaunchersListed,
  checkNavigation,
  checkNoCredentialControl,
  checkPaths,
  checkReducedMotion,
  checkRegistered,
  checkSameReducedMotion,
  checkScanFolderListed,
  checkSchedules,
  checkSectionFocused,
  checkSectionSettled,
  checkSecurityFacts,
  checkServiceAway,
  chooseOption,
  contrastSubjects,
  dataJsonKeys,
  describeLogScan,
  findAbsolutePathProblems,
  listFocusables,
  motionSelectOf,
  OVERVIEW_CONTRAST_SUBJECTS,
  openSettingsSection,
  openSettingsTab,
  type PathFacts,
  pluginDataFile,
  pressButton,
  pressSteps,
  readDataJson,
  readExtras,
  readMarkup,
  readProjectStore,
  readSettings,
  registerFolder,
  rendererFocusNavItem,
  rendererOsPrefersReduced,
  rendererReadFocusStop,
  rendererReadReducedMotion,
  restoreSystemMotion,
  type SettingsExtras,
  type SettingsRead,
  saveClaudeLauncher,
  scanLogForPrivateText,
  waitForSettings,
  walkTabStops,
  withBase,
} from "../src/spec-support/settings-support.js";
import {
  asTasksBrowser,
  openDestination,
  recordResults,
  runSetUpManagedVault,
  WAIT,
} from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const sb = asSettingsBrowser(browser);
const ob = asOverviewBrowser(browser);
const shots = browser as unknown as ShotBrowser;

const VIEW_TYPE = APPROVALS_COPY.commandCenterViewType;
/** The project the register case adds (an invented name; the folder is made in the run root). */
const PROJECT_NAME = "settings-uat-demo";
const SCAN_FOLDER_NAME = "settings-uat-scan";
/** A version line for the fake `claude` the launcher case saves (plain text only). */
const FAKE_CLAUDE_VERSION = "2.1.0 (Claude Code)";
/** Elements of the shell and the Settings destination that carry a transition. */
const MOTION_SELECTORS = [
  ".ccc-nav-item",
  ".ccc-nav-count",
  ".ccc-filter-chip",
  ".ccc-card",
  `.${SETTINGS_CLASSES.settingsNavItem}`,
  `.${SETTINGS_CLASSES.switchControl}`,
  ".ccc-connect-button",
];

describe("settings core", function () {
  this.timeout(900_000);
  let env: ResearchEnvironment;

  const context = loadRunContext();
  const paths = context.paths;
  const files = drillFiles(paths);

  recordResults(context, (hook) => afterEach(hook as Mocha.Func));

  const vaultPath = () => obsidianPage.getVaultPath();
  async function dataFile(): Promise<string> {
    return pluginDataFile(vaultPath(), await obsidianPage.getConfigDir());
  }
  async function savedData(): Promise<Record<string, unknown>> {
    return readDataJson(await dataFile(), context.runRoot);
  }
  const leakFacts = (): PathFacts => ({
    runRoot: context.runRoot,
    homeDir: homedir(),
    userName: userInfo().username,
  });

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: context.socketPath });
    env = await startResearchEnvironment();
    // A managed vault makes the Managed vault path (item 12) and the Overview real.
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
  });

  after(async () => {
    await env?.stop();
  });

  /** Puts keyboard focus on a nav item (the walks start from one) and checks it landed. */
  async function focusNav(label: string): Promise<void> {
    const landed = await browser.execute(
      rendererFocusNavItem,
      SETTINGS_CLASSES.settingsNav,
      SETTINGS_CLASSES.settingsNavItem,
      label,
    );
    // expect() takes no message in wdio's flavour: the reason is thrown instead.
    if (!landed) throw new Error(`Focus did not land on the ${label} nav item.`);
  }

  /** Presses a key and returns the destination as it reads afterwards. */
  async function press(keys: string | string[]) {
    await browser.keys(keys);
    return readSettings(sb);
  }

  /** Opens a section and waits until it has finished loading. */
  async function opened(id: SettingsSectionKey): Promise<SettingsRead> {
    await openSettingsSection(sb, id);
    return waitForSettings(sb, checkSectionSettled, `the ${sectionLabel(id)} section to settle`, {
      timeoutMs: 60_000,
      intervalMs: 500,
    });
  }

  /** Reads the Reduced motion select's visible choice. */
  async function motionSelect(): Promise<string> {
    return motionSelectOf(await readSettings(sb));
  }

  /** Waits for the plugin's data file to hold `value` for reducedMotion. */
  async function waitForSaved(value: string): Promise<Record<string, unknown>> {
    return pollUntil(
      async () => {
        const data = await savedData();
        return data.reducedMotion === value ? data : null;
      },
      { ...WAIT.short, describe: `the data file to hold reducedMotion ${value}` },
    );
  }

  /** Waits for the Overview-side or Settings-side extras to satisfy `check`. */
  async function waitForExtras(
    check: (extras: SettingsExtras) => string[],
    describe: string,
    options = WAIT.connect,
  ): Promise<SettingsExtras> {
    let last: string[] = ["the extras were never read"];
    try {
      return await pollUntil(
        async () => {
          const extras = await readExtras(sb);
          last = check(extras);
          return last.length === 0 ? extras : null;
        },
        { ...options, describe },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}; the problems were: ${last.join("; ")}`);
    }
  }

  it("[08-UAT#09] Every Settings section is reachable by keyboard and pointer", async () => {
    const labels = SETTINGS_SECTION_IDS.map(sectionLabel);

    // Opening Settings by its tab shows nine nav items, one tab stop, and never moves focus.
    const first = await openSettingsTab(sb);
    expect(checkFocusNotMoved(first)).toEqual([]);
    expect(checkNavigation(first)).toEqual([]);

    // The nav is one tab stop and the arrow keys move focus between items without activating:
    // the section on show does not change while the walk passes over every item.
    await pressSteps(sb, [
      {
        selector: `nav[aria-label="${SETTINGS_TEXT.navLabel}"] button.${SETTINGS_CLASSES.settingsNavItem}`,
        text: labels[0] ?? null,
      },
    ]);
    await focusNav(labels[0] as string);
    for (let index = 1; index < labels.length; index += 1) {
      const read = await press(Key.ArrowDown);
      // The pair names the press, so a failure says which ArrowDown went wrong.
      expect({ press: index, focused: read.nav.findIndex((item) => item.focused) }).toEqual({
        press: index,
        focused: index,
      });
      expect(read.nav.find((item) => item.current)?.label).toBe(labels[0]);
    }
    expect((await press(Key.Home)).nav.findIndex((item) => item.focused)).toBe(0);
    expect((await press(Key.End)).nav.findIndex((item) => item.focused)).toBe(labels.length - 1);
    expect((await press(Key.ArrowDown)).nav.findIndex((item) => item.focused)).toBe(0);

    // Enter opens the focused section and puts focus on its heading; Shift+Tab from the heading
    // returns to the current nav item, so the walk can go on from there.
    for (let index = 1; index < labels.length; index += 1) {
      const label = labels[index] as string;
      await press(Key.ArrowDown);
      const entered = await waitForSettings(
        sb,
        (read) => (read.nav[index]?.focused ? [] : [`the ${label} nav item does not hold focus`]),
        `the ${label} nav item to hold focus`,
        WAIT.short,
      );
      expect(entered.nav[index]?.label).toBe(label);
      await browser.keys(Key.Enter);
      const section = await waitForSettings(
        sb,
        (read) => checkSectionFocused(read, label),
        `the ${label} heading to take focus`,
        WAIT.short,
      );
      expect(section.nav.find((item) => item.current)?.label).toBe(label);
      const back = await press([Key.Shift, Key.Tab]);
      expect({ from: label, inNav: back.focus?.inNav ?? false }).toEqual({
        from: label,
        inNav: true,
      });
      expect(back.nav.find((item) => item.focused)?.label).toBe(label);
    }

    // The pointer reaches every section too, and the heading takes focus there as well.
    for (const id of SETTINGS_SECTION_IDS) {
      const label = sectionLabel(id);
      const read = await openSettingsSection(sb, id);
      const focused = await waitForSettings(
        sb,
        (current) => checkSectionFocused(current, label),
        `the ${label} heading to take focus`,
        WAIT.short,
      );
      expect(checkNavigation(focused)).toEqual([]);
      expect(read.mounted).toBe(true);
    }

    // A setup action's deep link lands on its section heading. Diagnostics opens with the one
    // gesture check (the sandbox research-key account makes it safe); its Launchers row offers
    // `Go to the launchers section`.
    await openDiagnostics(sb);
    await pressInRow(
      sb,
      "launchers",
      `${HEALTH_TEXT.goToPrefix}launchers${HEALTH_TEXT.goToSuffix}`,
    );
    const launchers = await waitForSettings(
      sb,
      (read) => checkSectionFocused(read, sectionLabel("launchers")),
      "the Launchers heading to take focus from the Diagnostics deep link",
      WAIT.short,
    );
    expect(launchers.nav.find((item) => item.current)?.label).toBe(sectionLabel("launchers"));

    // Security's pointer row is a second deep link, to the approvals and tasks section.
    await openSettingsSection(sb, "security");
    await pressSteps(sb, [{ selector: "button", text: SETTINGS_TEXT.goToApprovals }]);
    const approvals = await waitForSettings(
      sb,
      (read) => checkSectionFocused(read, sectionLabel("approvals-tasks")),
      "the Approvals and tasks heading to take focus from the Security pointer",
      WAIT.short,
    );
    expect(approvals.nav.find((item) => item.current)?.label).toBe(sectionLabel("approvals-tasks"));
  });

  it("[08-UAT#10] Register a project and add a scan folder from Settings", async () => {
    const folder = join(paths.tmpDir, "settings-uat", PROJECT_NAME);
    const scanRoot = join(paths.tmpDir, SCAN_FOLDER_NAME);
    await withRestore(
      async () => {
        // Take out what the case added: the project, the scan folder, then the empty folders.
        const store = await readProjectStore(context);
        for (const project of store.projects.filter((row) => row.name === PROJECT_NAME)) {
          await removeProject(env.client, { projectId: project.id as never });
        }
        for (const root of store.scanRoots.filter((row) => row.path.endsWith(SCAN_FOLDER_NAME))) {
          await removeScanRoot(env.client, { scanRootId: root.id as never });
        }
        removeEmptyDirInRunRoot(paths, folder);
        removeEmptyDirInRunRoot(paths, join(paths.tmpDir, "settings-uat"));
        removeEmptyDirInRunRoot(paths, scanRoot);
      },
      async () => {
        makeDirInRunRoot(paths, folder);
        await opened("projects");
        await registerFolder(sb, folder);
        const expected = `${SETTINGS_TEXT.registeredPrefix}${PROJECT_NAME}.`;
        const status = await waitForSettings(
          sb,
          (read) =>
            read.statusLine === expected ? [] : [`the status line reads "${read.statusLine}"`],
          "the register outcome in the status line",
          WAIT.connect,
        );
        // The project is in the store and on the Projects destination.
        const stored = await pollUntil(
          async () => {
            const store = await readProjectStore(context);
            return store.projects.some((row) => row.name === PROJECT_NAME) ? store : null;
          },
          { ...WAIT.short, describe: "the project to reach the store" },
        );
        await openDestination(tb, "projects");
        const cards = await pollUntil(
          async () => {
            const extras = await readExtras(sb);
            return extras.projectCards.includes(PROJECT_NAME) ? extras.projectCards : null;
          },
          { ...WAIT.short, describe: "the project card on the Projects destination" },
        );
        expect(
          checkRegistered({
            statusLine: status.statusLine,
            name: PROJECT_NAME,
            storeNames: stored.projects.map((row) => row.name),
            cardNames: cards,
          }),
        ).toEqual([]);

        // A scan folder is added by typed path and listed with a display path.
        makeDirInRunRoot(paths, scanRoot);
        await opened("projects");
        await addScanFolder(sb, scanRoot);
        const extras = await waitForExtras(
          (read) =>
            read.scanFolders.some((row) => row.path.endsWith(SCAN_FOLDER_NAME))
              ? []
              : ["the scan folder is not listed yet"],
          "the scan folder to be listed",
        );
        const store = await readProjectStore(context);
        expect(
          checkScanFolderListed({
            rows: extras.scanFolders,
            folderName: basename(scanRoot),
            storeRoots: store.scanRoots.filter((row) => row.path.endsWith(SCAN_FOLDER_NAME)).length,
          }),
        ).toEqual([]);
      },
    );
  });

  it("[08-UAT#11] Launchers in Settings", async () => {
    const watch = watchDescendants(await sandboxAncestors(context));
    let started: ReturnType<typeof findLauncherProcesses> = [];
    try {
      await withRestore(
        () => {
          removeFileInRunRoot(paths, files.fakeClaude);
        },
        async () => {
          // Detect proposes only; it reads which apps are installed and starts none.
          await opened("launchers");
          await pressButton(sb, {
            scope: `.${SETTINGS_CLASSES.settingsContent}`,
            heading: null,
            label: SETTINGS_TEXT.detectApps,
            nth: 0,
          });
          await waitForExtras(checkLaunchersListed, "the launcher panels and the detection line");

          // Save is the owner's explicit step: a program in the run root, never started.
          writeFakeExecutable(paths, "claude", { versionLine: FAKE_CLAUDE_VERSION });
          await saveClaudeLauncher(sb, files.fakeClaude);
          const saved = await waitForExtras(
            (extras) => checkLauncherSaved(extras, SETTINGS_TEXT.panelClaudeCode),
            "the Claude Code launcher to read Set up",
          );
          expect(checkLauncherSaved(saved, SETTINGS_TEXT.panelClaudeCode)).toEqual([]);
          const rows = await readLauncherRows(context);
          expect(rows.map((row) => (row as { launcher_id?: unknown }).launcher_id)).toContain(
            "claude-code",
          );

          // The `Set up launchers` command lands on the Launchers heading from another tab.
          await openDestination(tb, SETTINGS_TEXT.overviewTabId);
          await browser.executeObsidianCommand(`${PLUGIN_ID}:${SETTINGS_TEXT.setUpCommand}`);
          const landed = await waitForSettings(
            sb,
            (read) => checkSectionFocused(read, sectionLabel("launchers")),
            "the Launchers heading to take focus from the Set up launchers command",
            WAIT.short,
          );
          expect(landed.nav.find((item) => item.current)?.label).toBe(sectionLabel("launchers"));
        },
      );
    } finally {
      started = findLauncherProcesses(await watch.stop());
    }
    // Neither detecting nor saving started an app or a program.
    expect(started.map((node) => node.command.slice(0, 120))).toEqual([]);
  });

  it("[08-UAT#12] Paths are read-only and show no private path", async () => {
    // Opening Paths sends the one gesture health check (the sandbox research-key account makes
    // it safe) and the three values load from its answer.
    await openSettingsSection(sb, "paths");
    const settled = await waitForSettings(
      sb,
      (current) => (current.mounted ? checkPaths(current) : ["not mounted"]),
      "the three display paths",
      WAIT.connect,
    );
    expect(checkPaths(settled)).toEqual([]);
    // The whole destination, markup included, holds no absolute home path, run root or user name.
    const markup = await readMarkup(sb);
    expect(findAbsolutePathProblems(markup, leakFacts())).toEqual([]);
    expect(findAbsolutePathProblems(settled.text, leakFacts())).toEqual([]);
  });

  it("[08-UAT#13] Reduced motion from Visual applies and persists", async () => {
    await withRestore(
      async () => {
        await restoreSystemMotion(sb);
      },
      async () => {
        await openSettingsSection(sb, "visual");
        const osPrefersReduced = await browser.execute(rendererOsPrefersReduced);
        const baseline = await browser.execute(sampleMotionInRenderer, MOTION_SELECTORS);
        expect(await motionSelect()).toBe(SETTINGS_TEXT.optionSystem);

        await chooseOption(sb, SETTINGS_TEXT.rowReducedMotion, SETTINGS_TEXT.optionAlwaysReduced);
        // Applied at once: the root flips to reduced and nothing sampled still moves.
        const reduced = await pollUntil(
          async () => {
            const sample = await browser.execute(sampleMotionInRenderer, MOTION_SELECTORS);
            return sample.rootMotion === "reduced" ? sample : null;
          },
          { ...WAIT.short, describe: "the command center to stop animating" },
        );
        const afterReduced = await waitForSaved("reduced");
        const selectAfterReduced = await motionSelect();

        await chooseOption(sb, SETTINGS_TEXT.rowReducedMotion, SETTINGS_TEXT.optionSystem);
        const afterSystem = await waitForSaved("auto");
        const restored = await pollUntil(
          async () => {
            const sample = await browser.execute(sampleMotionInRenderer, MOTION_SELECTORS);
            return sample.rootMotion === baseline.rootMotion ? sample : null;
          },
          { ...WAIT.short, describe: "the command center to restore its motion" },
        );
        expect(
          checkReducedMotion({
            osPrefersReduced,
            baselineRoot: baseline.rootMotion,
            reducedRoot: reduced.rootMotion,
            restoredRoot: restored.rootMotion,
            baselineSamples: baseline.samples,
            reducedSamples: reduced.samples,
            selectAfterReduced,
            selectAfterSystem: await motionSelect(),
            savedAfterReduced: afterReduced.reducedMotion,
            savedAfterSystem: afterSystem.reducedMotion,
          }),
        ).toEqual([]);
      },
    );
  });

  it("[08-UAT#34] The Visual section writes the same reducedMotion value the native tab reads", async () => {
    // The auto-part of the owner item: the native tab reads `settingsHost.settings.reducedMotion`,
    // and the Visual select writes through the same object. The dialog itself is owner-only.
    async function holders(expected: string): Promise<string[]> {
      const held = await sb.executeObsidian(rendererReadReducedMotion, PLUGIN_ID);
      const disk = (await savedData()).reducedMotion;
      return checkSameReducedMotion({ ...held, disk }, expected);
    }
    await withRestore(
      async () => {
        await restoreSystemMotion(sb);
      },
      async () => {
        await openSettingsSection(sb, "visual");
        await chooseOption(sb, SETTINGS_TEXT.rowReducedMotion, SETTINGS_TEXT.optionAlwaysReduced);
        await waitForSaved("reduced");
        expect(await holders("reduced")).toEqual([]);
        await chooseOption(sb, SETTINGS_TEXT.rowReducedMotion, SETTINGS_TEXT.optionSystem);
        await waitForSaved("auto");
        expect(await holders("auto")).toEqual([]);
      },
    );
  });

  it("[08-UAT#14] Security and Schedules state the facts and offer no credential control", async () => {
    await openSettingsSection(sb, "security");
    const security = await waitForSettings(
      sb,
      (read) => [...checkSectionSettled(read), ...checkSecurityFacts(read)],
      "the Security facts and keychain chips",
      WAIT.connect,
    );
    expect(checkSecurityFacts(security)).toEqual([]);
    expect(checkNoCredentialControl(security)).toEqual([]);

    // Schedules lists what the service reports and offers no timer, run or source control.
    const status = await env.research.status();
    const configured =
      status.configuredSources === null
        ? undefined
        : {
            count: status.configuredSources.length,
            hosts: status.configuredSources.map((source) => source.host),
          };
    await openSettingsSection(sb, "schedules");
    const schedules = await waitForSettings(
      sb,
      (read) => [...checkSectionSettled(read), ...checkSchedules(read, configured)],
      "the Schedules facts",
      WAIT.connect,
    );
    expect(checkSchedules(schedules, configured)).toEqual([]);
  });

  it("[08-UAT#16] Keyboard walk and visible focus through Settings and Diagnostics", async () => {
    // Tab visits every control of every section in order, each with a visible focus ring, and
    // Shift+Tab from the heading reaches the nav item with a ring too. Problems from all nine
    // sections are collected so one failure lists them all.
    const problems: string[] = [];
    for (const id of SETTINGS_SECTION_IDS) {
      const label = sectionLabel(id);
      await opened(id);
      await waitForSettings(
        sb,
        (read) => checkSectionFocused(read, label),
        `the ${label} heading to take focus`,
        WAIT.short,
      );
      const expected = await listFocusables(sb);
      const stops = await walkTabStops(sb);
      // Back to the heading, then Shift+Tab to the nav item.
      await openSettingsSection(sb, id);
      await waitForSettings(
        sb,
        (read) => checkSectionFocused(read, label),
        "the heading",
        WAIT.short,
      );
      await browser.keys([Key.Shift, Key.Tab]);
      const nav = await browser.execute(rendererReadFocusStop, SETTINGS_CLASSES.settingsContent);
      problems.push(...checkKeyboardWalk(label, stops, expected, nav));
    }
    expect(problems).toEqual([]);
  });

  it("[08-UAT#15] Settings with the service stopped", async () => {
    let stopped = false;
    await withRestore(
      async () => {
        if (stopped) await env.startService();
        await restoreSystemMotion(sb);
      },
      async () => {
        await env.stopService();
        stopped = true;
        // Every section but Diagnostics (item 23 holds that one) shows the service away: inert
        // service-bound controls with a visible reason, and no last value as if it were current.
        for (const id of SETTINGS_SECTION_IDS) {
          if (id === "diagnostics") continue;
          await openSettingsSection(sb, id);
          await waitForSettings(
            sb,
            (read) => checkServiceAway(id, read),
            `the ${sectionLabel(id)} section to show the service away`,
            WAIT.connect,
          );
        }

        // Copy actions still work without the service: the command reaches the clipboard stub.
        await openSettingsSection(sb, "integrations");
        await browser.execute(rendererInstallSpies);
        await browser.execute(rendererClearSpies);
        await pressButton(sb, {
          scope: `.${SETTINGS_CLASSES.settingsContent}`,
          heading: null,
          label: SETTINGS_TEXT.copyInstall,
          nth: 0,
        });
        await pollUntil(
          async () =>
            (await browser.execute(rendererReadSpies)).clipboard.at(-1) ===
            HEALTH_TEXT.claudeInstallCommand,
          { ...WAIT.short, describe: "the install command on the clipboard stub" },
        );

        // Visual still works: the select changes, saves, and goes back.
        await openSettingsSection(sb, "visual");
        await chooseOption(sb, SETTINGS_TEXT.rowReducedMotion, SETTINGS_TEXT.optionAlwaysReduced);
        await waitForSaved("reduced");
        await chooseOption(sb, SETTINGS_TEXT.rowReducedMotion, SETTINGS_TEXT.optionSystem);
        await waitForSaved("auto");

        // The service comes back and the service-bound controls follow it.
        await env.startService();
        stopped = false;
        await openSettingsSection(sb, "approvals-tasks");
        await waitForSettings(
          sb,
          (read) => {
            const send = read.rows.find((row) => row.name === SETTINGS_TEXT.rowSendTest);
            return send !== undefined && !send.control.disabled
              ? []
              : ["the service-bound controls are still inert"];
          },
          "the service-bound controls to come back",
          WAIT.connect,
        );
      },
    );
  });

  it("[08-UAT#17] Contrast in both Obsidian themes", async () => {
    // Live contrast: every Settings section, Diagnostics and the Overview slice, measured in the
    // real window under both Obsidian base themes (07-FIX9: the runner maximises the window and
    // reads the real rendered colours). Text needs 4.5:1 (3:1 large) and a form edge 3:1. The look
    // is captured per section and theme for the owner-free visual verdict (D-32).
    const labels: string[] = [];
    const problems: string[] = [];
    const folder = join(paths.tmpDir, "settings-uat", "contrast-demo");
    await withRestore(
      async () => {
        const store = await readProjectStore(context);
        for (const project of store.projects.filter((row) => row.name === basename(folder))) {
          await removeProject(env.client, { projectId: project.id as never });
        }
        removeEmptyDirInRunRoot(paths, folder);
        removeEmptyDirInRunRoot(paths, join(paths.tmpDir, "settings-uat"));
      },
      async () => {
        // A registered project gives the Overview its project card and launch controls.
        makeDirInRunRoot(paths, folder);
        await registerProject(env.client, folder);

        async function measure(subject: string, subjects: readonly string[]): Promise<void> {
          const readings = await readContrastInBothThemes(
            shots,
            `.${SETTINGS_CLASSES.commandCenter}`,
          );
          for (const reading of readings) {
            console.log(
              `[08-UAT#17] ${subject} ${reading.base} lowest:\n  ${lowestRatios(reading.measured).join("\n  ")}`,
            );
            problems.push(...checkContrastReading(subject, reading, subjects));
          }
        }

        async function look(label: string, selector: string): Promise<void> {
          for (const [theme, base] of [
            ["light", "theme-light"],
            ["dark", "theme-dark"],
          ] as const) {
            await withBase(shots, base, async () => {
              labels.push(
                await captureLook(shots, {
                  shotsDir: context.shotsDir,
                  item: 17,
                  label: `${label}-${theme}`,
                  subject: { selector, block: "start" },
                  viewType: VIEW_TYPE,
                  placement: "as-is",
                }),
              );
            });
          }
        }

        await withEnlargedLayout(
          shots,
          VIEW_TYPE,
          async () => {
            for (const id of SETTINGS_SECTION_IDS) {
              await opened(id);
              await measure(sectionLabel(id), contrastSubjects(id));
              await look(id, `.${SETTINGS_CLASSES.settingsContent}`);
            }
            await openOverview(ob);
            await measure("Overview", OVERVIEW_CONTRAST_SUBJECTS);
            await look("overview", ".ccc-card");
          },
          { reopen: async () => void (await openSettingsTab(sb)) },
        );
      },
    );
    recordLookPending({ runRoot: context.runRoot, item: 17, labels });
    expect(problems).toEqual([]);
  });

  it("[08-UAT#18] The plugin data file and log stay private", async () => {
    // Read after the other items so what they did is what is judged. The data file is the
    // sandbox vault's own, read through a run-root guard; the log is the sandbox service's.
    const file = await dataFile();
    expect(dataJsonKeys(file, context.runRoot)).toEqual([
      "lastOpenedDestination",
      "notifyApprovals",
      "reducedMotion",
      "socketPathOverride",
    ]);
    expect(checkDataJson(await savedData())).toEqual([]);

    const found = scanLogForPrivateText(readAllServiceLogs(context), {
      runRoot: context.runRoot,
      homeDir: homedir(),
      userName: userInfo().username,
      projectNames: [PROJECT_NAME, "contrast-demo"],
    });
    expect(describeLogScan(found)).toEqual([]);
    // The scan is not vacuous: the sandbox service wrote a real log.
    expect(readAllServiceLogs(context).length).toBeGreaterThan(0);
  });
});
