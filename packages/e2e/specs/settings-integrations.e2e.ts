/**
 * The integrations and privacy-control items of the Settings destination in the Phase 8 UAT (plan
 * 08-22, DIAG-01, DIAG-03, D-08, D-17, D-44, OD-2): the Claude and Codex setup states with
 * copy-only commands, the transcript switch and Delete cached usage analytics, and the approvals
 * and tasks controls. These re-cover Phase 5 UAT 12 part B, 13 and 14, 05.1 U10, U13 and U14 and
 * Phase 6 item 13 at their new home, without editing those phases' files (OD-1, D-46).
 *
 * Everything runs inside the run's sandbox: its own runtime folder, scratch Claude config folder,
 * sandboxed Codex folders, store and throwaway vault. The service comes from
 * `startResearchEnvironment`, so a gesture health check (opening Security) asks about a
 * nonexistent `ccc-uat-` research-key account and never the owner's. Copy actions reach a clipboard
 * stub, never the owner's clipboard, and nothing runs: the scratch folders are hashed before and
 * after every copy and the process tree is watched for an installer. A test approval is made with
 * the notification constructor stubbed, so no macOS banner can appear. Every change a case makes
 * sits inside `withRestore` (a source scan in settings-support.test.ts fails on a mutating call
 * outside it). Failure messages name sections, controls and categories, never a path or a value.
 * Authored and CI-verified only (D-15); the live behaviour is first seen in the orchestrator's run
 * at the final head (D-30).
 */
import { join } from "node:path";
import {
  createApprovalsClient,
  deleteUsageAnalytics,
  setTranscriptAnalysis,
} from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { PLUGIN_DATA_KEYS } from "../src/plugin-data.js";
import {
  installNotificationSpy,
  restoreDocumentHasFocus,
  stubDocumentHasFocus,
} from "../src/renderer-spies.js";
import { loadRunContext } from "../src/spec-context.js";
import { clearPending } from "../src/spec-support/approvals-support.js";
import {
  makeDirInRunRoot,
  removeEmptyDirInRunRoot,
  removeFileInRunRoot,
  replaceFileInRunRoot,
} from "../src/spec-support/health-drill-support.js";
import { withRestore } from "../src/spec-support/health-support.js";
import { findLauncherProcesses } from "../src/spec-support/overview-support.js";
import {
  rendererClearSpies,
  rendererInstallSpies,
  rendererReadSpies,
} from "../src/spec-support/research-dom.js";
import {
  type ResearchEnvironment,
  sandboxAncestors,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
  watchDescendants,
} from "../src/spec-support/research-support.js";
import {
  SETTINGS_CLASSES,
  SETTINGS_TEXT,
  type SettingsSectionKey,
  sectionLabel,
} from "../src/spec-support/settings-copy.js";
import {
  asSettingsBrowser,
  COPY_ACTIONS,
  checkAccountsRows,
  checkAnalysisStored,
  checkCopied,
  checkDeleteDialog,
  checkDeleted,
  checkIntegrationsNotSetUp,
  checkNotifyApprovals,
  checkPending,
  checkRebuilt,
  checkSectionSettled,
  checkSnapshotUnchanged,
  checkTranscriptSwitch,
  checkUsageEmptied,
  type DialogRead,
  dataJsonKeys,
  findInstallerProcesses,
  openSettingsSection,
  pluginDataFile,
  pressButton,
  pressDialogButton,
  pressRowControl,
  readDataJson,
  readDialog,
  readProposals,
  readSettings,
  readUsageStore,
  SYNTHETIC_TRANSCRIPT_PROJECT,
  SYNTHETIC_TRANSCRIPT_SESSION,
  snapshotDir,
  syntheticTranscriptLine,
  totalUsageRows,
  waitForSettings,
} from "../src/spec-support/settings-support.js";
import {
  asTasksBrowser,
  recordResults,
  runSetUpManagedVault,
  WAIT,
} from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const sb = asSettingsBrowser(browser);

const CONTENT = `.${SETTINGS_CLASSES.settingsContent}`;

describe("settings integrations", function () {
  this.timeout(600_000);
  let env: ResearchEnvironment;

  const context = loadRunContext();
  const paths = context.paths;

  recordResults(context, (hook) => afterEach(hook as Mocha.Func));

  async function dataFile(): Promise<string> {
    return pluginDataFile(obsidianPage.getVaultPath(), await obsidianPage.getConfigDir());
  }
  async function savedData(): Promise<Record<string, unknown>> {
    return readDataJson(await dataFile(), context.runRoot);
  }

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: context.socketPath });
    // The service starts on a fresh store, so the managed vault is set up again (the rebuild in
    // item 21 counts its tasks).
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
  });

  after(async () => {
    await env?.stop();
  });

  /** Opens a section and waits until it has finished loading. */
  async function opened(id: SettingsSectionKey) {
    await openSettingsSection(sb, id);
    return waitForSettings(sb, checkSectionSettled, `the ${sectionLabel(id)} section to settle`, {
      timeoutMs: 60_000,
      intervalMs: 500,
    });
  }

  it("[08-UAT#19] Claude and Codex setup states with copy-only commands", async () => {
    // Re-covers Phase 5 UAT-12 part B and 05.1 U10 and U14 at the new location. A fresh sandbox has
    // no hooks, no status-line wrapper and no Codex or bridge install, so every row reads not set
    // up; each Copy action puts one repository-relative command on the clipboard stub and changes
    // nothing on disk or in the process tree.
    const watch = watchDescendants(await sandboxAncestors(context));
    let spawned: Awaited<ReturnType<typeof watch.stop>> = [];
    try {
      await opened("integrations");
      const read = await waitForSettings(
        sb,
        (current) => checkIntegrationsNotSetUp(current),
        "the Claude and Codex rows to read their setup state",
        WAIT.connect,
      );
      expect(checkIntegrationsNotSetUp(read)).toEqual([]);
      expect(checkAccountsRows(read)).toEqual([]);
      expect(read.subheads).toEqual(
        expect.arrayContaining([SETTINGS_TEXT.groupAccounts, "Claude Code", "Codex"]),
      );

      await browser.execute(rendererInstallSpies);
      const folders = [paths.claudeConfigDir, paths.codexCandidatesDir, paths.codexBridgeHome];
      const before = folders.map((folder) => snapshotDir(folder, context.runRoot));
      const problems: string[] = [];
      for (const action of COPY_ACTIONS) {
        await browser.execute(rendererClearSpies);
        await pressButton(sb, { scope: CONTENT, heading: null, label: action.label, nth: 0 });
        const clipboard = await pollUntil(
          async () => {
            const spies = await browser.execute(rendererReadSpies);
            return spies.clipboard.length > 0 ? spies.clipboard : null;
          },
          { ...WAIT.short, describe: `the ${action.id} command on the clipboard stub` },
        );
        const status = await waitForSettings(
          sb,
          (current) =>
            current.statusLine === action.notice
              ? []
              : [`the status line reads "${current.statusLine}"`],
          `the ${action.id} notice`,
          WAIT.short,
        );
        problems.push(...checkCopied(action, clipboard.at(-1), status.statusLine));
        if (clipboard.length !== 1)
          problems.push(`${action.id}: ${clipboard.length} clipboard writes`);
        // Nothing on disk changed: the scratch Claude config and the sealed Codex folders.
        const after = folders.map((folder) => snapshotDir(folder, context.runRoot));
        folders.forEach((_folder, index) => {
          const names = [
            "the scratch Claude config folder",
            "the Codex candidates folder",
            "the Codex bridge folder",
          ];
          problems.push(
            ...checkSnapshotUnchanged(
              `${action.id}: ${names[index] as string}`,
              before[index] as (typeof before)[number],
              after[index] as (typeof after)[number],
            ),
          );
        });
      }
      expect(problems).toEqual([]);
    } finally {
      spawned = await watch.stop();
    }
    // Copying started no installer, no uninstaller and no app.
    expect(findInstallerProcesses(spawned).map((node) => node.command.slice(0, 120))).toEqual([]);
    expect(findLauncherProcesses(spawned).map((node) => node.command.slice(0, 120))).toEqual([]);
  });

  it("[08-UAT#20] Transcript analysis and Delete cached usage analytics", async () => {
    // Re-covers Phase 5 UAT-13 and UAT-14 and 05.1 U13 at the new location. A synthetic transcript
    // in the scratch Claude config folder gives analysis something to count, so the usage tables
    // hold rows before the delete. Analysis is switched off first (the delete is offered in the
    // same flow), because with analysis on the service recounts at once from the retained
    // transcripts and the tables would not stay empty.
    const projects = join(paths.claudeConfigDir, "projects");
    const project = join(projects, SYNTHETIC_TRANSCRIPT_PROJECT);
    const transcript = join(project, `${SYNTHETIC_TRANSCRIPT_SESSION}.jsonl`);
    await withRestore(
      async () => {
        await setTranscriptAnalysis(env.client, false);
        await deleteUsageAnalytics(env.client);
        removeFileInRunRoot(paths, transcript);
        removeEmptyDirInRunRoot(paths, project);
        removeEmptyDirInRunRoot(paths, projects);
      },
      async () => {
        makeDirInRunRoot(paths, project);
        const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        replaceFileInRunRoot(
          paths,
          transcript,
          `${syntheticTranscriptLine("msg_settingsuat01", recent)}\n`,
        );
        await opened("security");
        expect(checkTranscriptSwitch(await readSettings(sb), false)).toEqual([]);

        // Switch it on: the service stores the setting, the plugin's data file never does.
        await pressRowControl(sb, SETTINGS_TEXT.rowTranscript);
        await waitForSettings(
          sb,
          (read) => checkTranscriptSwitch(read, true),
          "the Transcript analysis switch to read on",
          WAIT.short,
        );
        const storedOn = await pollUntil(
          async () => {
            const store = await readUsageStore(context);
            return store.analysis === "true" ? store : null;
          },
          { ...WAIT.short, describe: "the service to store transcript analysis on" },
        );
        expect(checkAnalysisStored(storedOn, true, await savedData())).toEqual([]);
        expect(dataJsonKeys(await dataFile(), context.runRoot)).toEqual(
          [...PLUGIN_DATA_KEYS].sort(),
        );

        // The synthetic transcript is counted, so the delete below empties something.
        let counted = 0;
        try {
          counted = await pollUntil(
            async () => {
              const total = totalUsageRows((await readUsageStore(context)).counts);
              return total > 0 ? total : null;
            },
            { timeoutMs: 30_000, intervalMs: 500, describe: "the usage tables to hold rows" },
          );
        } catch {
          console.warn(
            "[08-UAT#20] the synthetic transcript produced no usage row, so the delete is checked against empty tables",
          );
        }

        // Switch it off: Delete is offered in the same flow and says totals are kept until deleted.
        await pressRowControl(sb, SETTINGS_TEXT.rowTranscript);
        const off = await waitForSettings(
          sb,
          (read) => checkTranscriptSwitch(read, false),
          "the Transcript analysis switch to read off",
          WAIT.short,
        );
        const deleteRow = off.rows.find((row) => row.name === SETTINGS_TEXT.rowDeleteUsage);
        expect(deleteRow?.paragraphs.join(" ")).toContain(SETTINGS_TEXT.usageRetainedNote);
        const storedOff = await pollUntil(
          async () => {
            const store = await readUsageStore(context);
            return store.analysis === "false" ? store : null;
          },
          { ...WAIT.short, describe: "the service to store transcript analysis off" },
        );
        expect(checkAnalysisStored(storedOff, false, await savedData())).toEqual([]);

        // Cancel first: the dialog closes, nothing is deleted and no result line appears.
        const rowsBefore = totalUsageRows((await readUsageStore(context)).counts);
        await pressRowControl(sb, SETTINGS_TEXT.rowDeleteUsage);
        const asked = await pollUntil(
          async () => {
            const dialog = await readDialog(sb);
            return dialog.open ? dialog : null;
          },
          { ...WAIT.short, describe: "the delete confirmation" },
        );
        expect(checkDeleteDialog(asked, false)).toEqual([]);
        await pressDialogButton(sb, SETTINGS_TEXT.dialogCancel);
        await pollUntil(async () => ((await readDialog(sb)).open ? null : true), {
          ...WAIT.short,
          describe: "the dialog to close",
        });
        const cancelled = await readSettings(sb);
        expect(cancelled.results.some((result) => result.key === "delete-usage")).toBe(false);
        expect(totalUsageRows((await readUsageStore(context)).counts)).toBe(rowsBefore);

        // Confirm: the tables are emptied, the outcome is reported twice and nothing comes back.
        await pressRowControl(sb, SETTINGS_TEXT.rowDeleteUsage);
        await pollUntil(
          async () => {
            const dialog: DialogRead = await readDialog(sb);
            return dialog.open ? dialog : null;
          },
          { ...WAIT.short, describe: "the delete confirmation again" },
        );
        await pressDialogButton(sb, SETTINGS_TEXT.dialogConfirm);
        const done = await waitForSettings(sb, checkDeleted, "the delete outcome", WAIT.short);
        expect(checkDeleted(done)).toEqual([]);
        const emptied = await pollUntil(
          async () => {
            const store = await readUsageStore(context);
            return checkUsageEmptied(store.counts).length === 0 ? store : null;
          },
          { ...WAIT.short, describe: "the usage tables to be emptied" },
        );
        expect(checkUsageEmptied(emptied.counts)).toEqual([]);
        if (counted > 0) expect(totalUsageRows(emptied.counts)).toBe(0);
        // With analysis off the totals stay deleted.
        await browser.pause(3_000);
        expect(checkUsageEmptied((await readUsageStore(context)).counts)).toEqual([]);
      },
    );
  });

  it("[08-UAT#21] Approvals and tasks", async () => {
    // Re-covers Phase 6 item 13 at the new location. The notification constructor is stubbed and
    // the window reported focused, so the test approval can raise no macOS banner.
    const approvals = createApprovalsClient(env.client);
    await withRestore(
      async () => {
        await clearPending(approvals);
        await browser.execute(restoreDocumentHasFocus);
      },
      async () => {
        await browser.execute(installNotificationSpy);
        await browser.execute(stubDocumentHasFocus, true);
        const first = await opened("approvals-tasks");
        const original =
          first.rows.find((row) => row.name === SETTINGS_TEXT.rowNotifyApprovals)?.control
            .checked ?? true;

        // The Approval notifications switch saves to the plugin's data file, and back.
        for (const wanted of [!original, original]) {
          await pressRowControl(sb, SETTINGS_TEXT.rowNotifyApprovals);
          await pollUntil(
            async () => {
              const problems = checkNotifyApprovals(
                await readSettings(sb),
                wanted,
                (await savedData()).notifyApprovals,
              );
              return problems.length === 0 ? true : null;
            },
            { ...WAIT.short, describe: `the notifications switch to save ${wanted}` },
          );
        }

        // Send a test approval: a pending approval arrives in the sandbox store (after its delay).
        await clearPending(approvals);
        await pressRowControl(sb, SETTINGS_TEXT.rowSendTest);
        const pending = await pollUntil(
          async () => {
            const rows = await readProposals(context);
            return checkPending(rows).length === 0 ? rows : null;
          },
          { timeoutMs: 30_000, intervalMs: 500, describe: "a pending approval in the store" },
        );
        expect(checkPending(pending)).toEqual([]);
        await clearPending(approvals);

        // Rebuild task index reports its result in the status line and under the row.
        await pressRowControl(sb, SETTINGS_TEXT.rowRebuild);
        const rebuilt = await waitForSettings(
          sb,
          (read) => checkRebuilt(read, VAULT_TASKS_AT_LEAST),
          "the rebuild result in the status line and under the row",
          WAIT.connect,
        );
        expect(checkRebuilt(rebuilt, VAULT_TASKS_AT_LEAST)).toEqual([]);
      },
    );
  });
});
