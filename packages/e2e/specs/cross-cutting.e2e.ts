/**
 * Cross-cutting UAT items of Phase 6 (05.2-08): reduced motion (23), the no-always-allow walk
 * (12), completing a task changes nothing outside the note (20), the keyboard-only pass (22) and
 * the privacy check (25). Item 25 stays LAST so the service log has content to search.
 *
 * Authored and CI-checked only (D-15): typecheck, lint and the static guard run in CI; the live
 * run is the orchestrator's baseline in plan 05.2-09. Everything touches the synthetic vault and
 * the throwaway service inside the run root.
 *
 * Recorded spike decisions that shape these tests (05.2-RESEARCH.md):
 * - S5 failed (reducedMotion setting-only): no media-feature emulation exists on the Electron
 *   session, so item 23 toggles the plugin setting through data.json and reloads the plugin.
 * - S2 (a programmatic focus shows no focus ring): item 22 drives focus with real key presses.
 * - S3 failed (onclick-only): the retained notification handler is called in process.
 *
 * Look items (12, 20, 22) assert everything they can first, then write PAGE screenshots into the
 * private shots folder and record them as a pending look; the resolver reports such an item as
 * "inconclusive (look pending)" until Claude records a verdict. This file never uses the screen
 * capture tool, and a screenshot failure fails the test.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApprovalsClient, createAuthenticatedClient } from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { Key } from "webdriverio";
import {
  assertSandboxConnected,
  type DriverBrowser,
  parseCountInWords,
  pollUntil,
  runPluginCommand,
} from "../src/driver.js";
import { readLedger } from "../src/ledger.js";
import { assertPluginDataKeys } from "../src/plugin-data.js";
import { readProcessTable } from "../src/process-table.js";
import {
  fireNotificationClick,
  installConsoleCapture,
  installNotificationSpy,
  readNotifications,
  restoreDocumentHasFocus,
  stubDocumentHasFocus,
} from "../src/renderer-spies.js";
import { INSTALLED_OBSIDIAN_BINARY } from "../src/repo-paths.js";
import { installResultRecorder, type RecorderOptions } from "../src/results.js";
import { assertShotInside, shotPath } from "../src/screenshots.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../src/spec-context.js";
import {
  clearPending,
  openSettingsTab,
  sendTestApproval,
  supportBrowser,
} from "../src/spec-support/approvals-support.js";
import {
  APPROVE_LABEL,
  commandId,
  DENY_LABEL,
  PLUGIN_ID,
  SETUP_CONFIRM_LABEL,
  SYNTHETIC_MARKERS,
} from "../src/spec-support/cross-copy.js";
import {
  allMotionOff,
  anyMotionOn,
  checkFocusOrder,
  checkPluginDataKeys,
  countOccurrences,
  diffFileHashes,
  diffNewDescendants,
  type FocusRecord,
  firstFocusInRequestIsDeny,
  focusRingVisible,
  hashVaultFiles,
  motionAnnouncementPresent,
  type ProcessNode,
  readLiveRegionsInRenderer,
  readProcessTree,
  readTextInRenderer,
  recordFocusInRenderer,
  recordLookPending,
  sampleMotionInRenderer,
  scanForAlwaysAllow,
} from "../src/spec-support/cross-support.js";
import { waitUntilQuiet } from "../src/spec-support/quiescence.js";
import { TASKS_TEXT } from "../src/spec-support/tasks-copy.js";
import {
  asTasksBrowser,
  GLOBAL_ROOT,
  openTasks,
  pressDetailAction,
  readTasks,
  selectRow,
  showFilter,
} from "../src/spec-support/tasks-support.js";
import { copyStore, queryStore } from "../src/store-copy.js";

const asDriver = (): DriverBrowser => browser as unknown as DriverBrowser;
const DATA_FILE = (configDir: string): string => `${configDir}/plugins/${PLUGIN_ID}/data.json`;
/** A fixed statement over the copied store (never built from request text). */
const PROPOSAL_COUNT_SQL = "select count(*) as n from proposals;";
/** Elements that carry a transition or animation in the plugin's styles (styles.css motion tokens). */
const MOTION_SELECTORS = [
  ".ccc-nav-item",
  ".ccc-nav-count",
  ".ccc-filter-chip",
  ".ccc-approval-row-button",
  ".ccc-task-title",
  ".ccc-kpi-number",
  ".ccc-twinkle",
  ".ccc-card",
];

let context: RunContext;
let fixture: ReturnType<typeof serviceFixtureFor> | undefined;
const service = (): ReturnType<typeof serviceFixtureFor> => {
  if (fixture === undefined) fixture = serviceFixtureFor(context);
  return fixture;
};

/** Presses a tab of the command center by its destination id. */
async function openDestination(id: string): Promise<void> {
  await pollUntil(
    () => browser.execute((tab: string) => document.getElementById(`ccc-tab-${tab}`) !== null, id),
    { timeoutMs: 15_000, intervalMs: 250, describe: `the ${id} tab` },
  );
  await browser.execute((tab: string) => {
    (document.getElementById(`ccc-tab-${tab}`) as HTMLElement).click();
  }, id);
}

/** Opens the plugin's settings tab like a user would and waits until its rows are on screen. */
async function _openSettings(): Promise<void> {
  await openSettingsTab(supportBrowser(browser));
}

/** Runs Set up managed vault, confirms the plan and waits until Tasks shows a count. */
async function ensureVaultSetup(): Promise<void> {
  await runPluginCommand(asDriver(), commandId("set-up-managed-vault"));
  await pollUntil(
    () =>
      browser.execute((label: string) => {
        const button = Array.from(document.querySelectorAll(".modal button")).find(
          (el) => el.textContent?.trim() === label,
        );
        if (button === undefined) return false;
        (button as HTMLElement).click();
        return true;
      }, SETUP_CONFIRM_LABEL),
    { timeoutMs: 20_000, intervalMs: 250, describe: "the setup confirmation" },
  );
  await openDestination("tasks");
  await pollUntil(
    async () => {
      const name = await browser.execute(
        () => document.querySelector('[data-filter="all"]')?.getAttribute("aria-label") ?? "",
      );
      const parsed = parseCountInWords(name);
      return parsed !== null && parsed.count > 0;
    },
    { timeoutMs: 60_000, intervalMs: 500, describe: "the Tasks count after setup" },
  );
}

/**
 * Settles every pending request through the service API and waits until none is left, so the
 * next "Send a test approval" is a NEW request: the service answers a second test request while
 * one is pending with the same proposal, and the notifier skips proposal ids it has seen, so a
 * reused request produces no fresh notification event (Codex finding 3).
 */
async function settlePendingRequests(): Promise<void> {
  const approvals = createApprovalsClient(
    createAuthenticatedClient({ socketPath: context.socketPath }),
  );
  await clearPending(approvals);
  await pollUntil(async () => (await approvals.list()).pending.length === 0, {
    timeoutMs: 15_000,
    intervalMs: 250,
    describe: "the earlier test request to be settled",
  });
}

/** Sends a test approval and waits until its row shows in the Pending list of Approvals. */
async function sendTestApprovalAndWait(): Promise<void> {
  await settlePendingRequests();
  // The request is made through the service client, the same call the settings row makes after
  // its delay. Opening the settings dialog programmatically does not attach it in this Obsidian
  // (see item 13), and the notification path under test starts at the plugin's upsert hook, not at
  // the button. Item 13 still presses the real row.
  await sendTestApproval(
    createApprovalsClient(createAuthenticatedClient({ socketPath: context.socketPath })),
  );
  await openDestination("agent-runs");
  await pollUntil(
    () => browser.execute(() => document.querySelectorAll(".ccc-approval-row").length > 0),
    { timeoutMs: 30_000, intervalMs: 500, describe: "the test request in Approvals" },
  );
}

/** A page screenshot into the private shots folder; a failure fails the test (never swallowed). */
async function shot(item: number, label: string): Promise<string> {
  const dir = context.shotsDir;
  if (dir === undefined) throw new Error("No shots folder: a look item cannot record images.");
  const path = shotPath(dir, item, label);
  assertShotInside(dir, path);
  await browser.saveScreenshot(path);
  return label;
}

/** Writes the plugin's reducedMotion setting, reloads the plugin and reopens the overview. */
async function setReducedMotion(value: "auto" | "reduced"): Promise<void> {
  const file = DATA_FILE(await obsidianPage.getConfigDir());
  const data = JSON.parse(await obsidianPage.read(file)) as Record<string, unknown>;
  data.reducedMotion = value;
  assertPluginDataKeys(data);
  await obsidianPage.write(file, `${JSON.stringify(data, null, 2)}\n`);
  await obsidianPage.disablePlugin(PLUGIN_ID);
  await obsidianPage.enablePlugin(PLUGIN_ID);
  await runPluginCommand(asDriver(), commandId("open-overview"));
}

async function pressTabUntil(
  match: (record: FocusRecord) => boolean,
  max: number,
  sequence: FocusRecord[],
): Promise<FocusRecord> {
  for (let press = 0; press < max; press += 1) {
    await browser.keys(Key.Tab);
    const record = await browser.execute(recordFocusInRenderer);
    if (record === null) continue;
    sequence.push(record);
    if (match(record)) return record;
  }
  throw new Error("Keyboard focus never reached the expected control.");
}

before(async function startRun() {
  context = loadRunContext();
  installResultRecorder({
    afterEach: afterEach as unknown as RecorderOptions["afterEach"],
    resultsPath: context.paths.resultsPath,
  });
  await service().start({ kind: "normal" });
  await assertSandboxConnected(asDriver(), { expectedSocketPath: context.socketPath });
  await browser.execute(installConsoleCapture);
  await runPluginCommand(asDriver(), commandId("open-overview"));
  await ensureVaultSetup();
});

after(async function stopRun() {
  await service().stop();
});

describe("cross-cutting items", () => {
  // Never leave Obsidian's settings dialog open between tests.
  afterEach(async () => {
    await browser.executeObsidian(({ app }) => {
      (app as unknown as { setting?: { close(): void } }).setting?.close();
    });
  });

  it("[06-UAT#23] Reduced motion turns every transition and animation off and still announces", async function reducedMotion() {
    try {
      await setReducedMotion("auto");
      await sendTestApprovalAndWait();
      const full = await browser.execute(sampleMotionInRenderer, MOTION_SELECTORS);
      if (full.rootMotion === "reduced") {
        // The macOS Reduce motion preference is already on, so the full-motion baseline cannot be
        // taken: an environment limit, reported as skipped (inconclusive), never as a pass.
        this.skip();
      }
      // The baseline must see motion, or "all off" below would pass on an empty sample.
      expect(anyMotionOn(full.samples)).toBe(true);

      await setReducedMotion("reduced");
      const samples: Array<{
        transitionDuration: string;
        animationDuration: string;
        animationName: string;
      }> = [];
      for (const destination of ["agent-runs", "tasks"]) {
        await openDestination(destination);
        const sampled = await browser.execute(sampleMotionInRenderer, MOTION_SELECTORS);
        expect(sampled.rootMotion).toBe("reduced");
        samples.push(...sampled.samples);
      }
      expect(allMotionOff(samples)).toBe(true);

      // State changes still announce: a new request raises the polite status line.
      await openDestination("agent-runs");
      await sendTestApprovalAndWait();
      await pollUntil(
        async () =>
          motionAnnouncementPresent((await browser.execute(readLiveRegionsInRenderer)).join(" ")),
        { timeoutMs: 20_000, intervalMs: 500, describe: "a polite live-region announcement" },
      );
    } finally {
      await setReducedMotion("auto");
    }
  });

  it("[06-UAT#12] No wording or control anywhere offers to remember, always allow or skip", async () => {
    // Capture the notification text with the spy while the window is reported unfocused.
    await browser.execute(installNotificationSpy);
    await browser.execute(stubDocumentHasFocus, false);
    await sendTestApprovalAndWait();
    await browser.execute(restoreDocumentHasFocus);
    const notices = await browser.execute(readNotifications);

    await openDestination("agent-runs");
    await browser.execute(() => {
      (document.querySelector(".ccc-approval-row-button") as HTMLElement).click();
    });
    await pollUntil(
      () => browser.execute(() => document.querySelector("[data-decision]") !== null),
      { timeoutMs: 15_000, intervalMs: 250, describe: "the decision group" },
    );
    const pane = await browser.execute(readTextInRenderer, ".ccc-approvals");
    const decisions = await browser.execute(() =>
      Array.from(document.querySelectorAll(".ccc-approval-decision [data-decision]")).map(
        (el) => el.getAttribute("data-decision") ?? "",
      ),
    );
    const mirror = await pollUntil(
      () =>
        browser.executeObsidian(async ({ app }) => {
          const notes = app.vault
            .getFiles()
            .filter(
              (file) =>
                file.path.startsWith("system/") &&
                file.extension === "md" &&
                !file.path.endsWith("/index.md"),
            );
          notes.sort((a, b) => b.stat.mtime - a.stat.mtime);
          const newest = notes[0];
          return newest === undefined ? "" : await app.vault.cachedRead(newest);
        }),
      { timeoutMs: 30_000, intervalMs: 1_000, describe: "the newest mirror note" },
    );

    const texts = [
      { label: "approvals pane", text: pane },
      { label: "mirror note", text: mirror },
      ...notices.records.map((record, index) => ({
        label: `notification ${index}`,
        text: `${record.title} ${record.body ?? ""}`,
      })),
    ];
    expect(scanForAlwaysAllow(texts)).toEqual([]);
    expect([...decisions].sort()).toEqual(["approve", "deny"]);

    // Item 12 is owner-run (the settings text and the look need the dialog the driver cannot open);
    // this test is its automated partial: pane, decisions, banner text and mirror note.
  });

  it("[06-UAT#20] Marking a task done changes nothing outside the note", async () => {
    // Task rows carry no inline Mark done: it is a button of the detail pane's Task actions
    // group (the run that first used a guessed row selector found none). Select one Upcoming row
    // through the shared Tasks helpers, whose selectors are drift-checked against the plugin.
    const tb = asTasksBrowser(browser);
    await openTasks(tb);
    await showFilter(tb, GLOBAL_ROOT, "upcoming");
    const target = await pollUntil(async () => (await readTasks(tb, GLOBAL_ROOT)).rows[0] ?? null, {
      timeoutMs: 20_000,
      intervalMs: 500,
      describe: "an Upcoming task to mark done",
    });
    await selectRow(tb, GLOBAL_ROOT, target.id);

    const vaultPath = obsidianPage.getVaultPath();
    const beforeFiles = hashVaultFiles(vaultPath, context.runRoot);
    const beforeStore = copyStore({
      runtimeDir: context.paths.runtimeDir,
      destDir: context.paths.tmpDir,
      runRoot: context.runRoot,
    });
    const beforeCount = await queryStore({
      copyPath: beforeStore.copyPath,
      sql: PROPOSAL_COUNT_SQL,
      runRoot: context.runRoot,
    });
    const beforeTree: ProcessNode[] = await readProcessTree();
    const table = await readProcessTable();
    const ancestors = [
      ...readLedger(context.paths.ledgerPath)
        .filter((entry) => entry.kind === "pid" && entry.role === "service")
        .map((entry) => (entry.kind === "pid" ? entry.pid : 0)),
      ...table
        .filter(
          (row) =>
            row.command.startsWith(INSTALLED_OBSIDIAN_BINARY) &&
            row.command.includes(context.runRoot) &&
            !row.command.includes("--type="),
        )
        .map((row) => row.pid),
    ];
    expect(ancestors.length).toBeGreaterThan(0);

    await pressDetailAction(tb, GLOBAL_ROOT, TASKS_TEXT.markDone);
    await pollUntil(
      () =>
        diffFileHashes(beforeFiles, hashVaultFiles(vaultPath, context.runRoot)).changed.length > 0,
      { timeoutMs: 20_000, intervalMs: 500, describe: "the task note to change" },
    );
    // Absence of a prompt, an approval or a new process has no event to wait on, so the vault
    // files and the proposal count must stay unchanged for a whole quiet window, sampled once a
    // second, within a bound. A fixed pause passed vacuously when a late write arrived (WR-09).
    const quiet = await waitUntilQuiet({
      sample: async () => {
        const settled = copyStore({
          runtimeDir: context.paths.runtimeDir,
          destDir: context.paths.tmpDir,
          runRoot: context.runRoot,
        });
        return {
          files: diffFileHashes(beforeFiles, hashVaultFiles(vaultPath, context.runRoot)),
          proposals: await queryStore({
            copyPath: settled.copyPath,
            sql: PROPOSAL_COUNT_SQL,
            runRoot: context.runRoot,
          }),
        };
      },
      sleep: (ms) => browser.pause(ms),
      now: () => Date.now(),
      quietMs: 3_000,
      intervalMs: 1_000,
      timeoutMs: 15_000,
    });
    expect(quiet.quiet).toBe(true);

    const diff = diffFileHashes(beforeFiles, hashVaultFiles(vaultPath, context.runRoot));
    // The service regenerates a folder's index.md when a note in it changes; that is generated
    // output, not a change to another note, so it is set apart (baseline run confirms the shape).
    const notes = diff.changed.filter((path) => !path.endsWith("index.md"));
    expect(notes.length).toBe(1);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(readFileSync(join(vaultPath, notes[0] as string), "utf8")).toMatch(/status:\s*done/);

    const afterStore = copyStore({
      runtimeDir: context.paths.runtimeDir,
      destDir: context.paths.tmpDir,
      runRoot: context.runRoot,
    });
    const afterCount = await queryStore({
      copyPath: afterStore.copyPath,
      sql: PROPOSAL_COUNT_SQL,
      runRoot: context.runRoot,
    });
    expect(afterCount).toEqual(beforeCount);
    expect(diffNewDescendants(beforeTree, await readProcessTree(), ancestors)).toEqual([]);

    // The macOS network or permission prompt part of the UAT wording cannot appear in a page
    // screenshot; the absence of any new process above stands in for it.
    // The selected row's detail pane is still open for the screenshot.
    const labels = [await shot(20, "task-detail")];
    recordLookPending({ runRoot: context.runRoot, item: 20, labels });
  });

  it("[06-UAT#22] The keyboard alone reaches every control and focus lands on Deny first", async () => {
    await browser.execute(installNotificationSpy);
    await browser.execute(stubDocumentHasFocus, false);
    await sendTestApprovalAndWait();
    await browser.execute(restoreDocumentHasFocus);

    const sequence: FocusRecord[] = [];
    const labels: string[] = [];
    // The palette command is the keyboard route into the section: it lands on the Approvals heading.
    await runPluginCommand(asDriver(), commandId("open-approval-inbox"));
    await pollUntil(
      () =>
        browser.execute(
          () =>
            document.activeElement?.closest(".ccc-approvals-header") !== null &&
            document.activeElement !== document.body,
        ),
      { timeoutMs: 15_000, intervalMs: 250, describe: "focus on the Approvals heading" },
    );
    await pressTabUntil((r) => r.name.startsWith("Pending"), 12, sequence);
    await pressTabUntil((r) => r.name.startsWith("Decided"), 4, sequence);
    await pressTabUntil((r) => r.name.startsWith("Expired"), 4, sequence);
    const row = await pressTabUntil(
      (r) => r.classes.includes("ccc-approval-row-button"),
      8,
      sequence,
    );
    expect(row.focusVisible).toBe(true);
    await browser.keys(Key.ArrowDown);
    await browser.keys(Key.ArrowUp);
    const afterArrows = await browser.execute(recordFocusInRenderer);
    expect(afterArrows?.classes ?? "").toContain("ccc-approval-row-button");

    // Open the request by keyboard, then walk the decision group.
    await browser.keys(Key.Enter);
    await pollUntil(
      () =>
        browser.execute(
          () =>
            document.activeElement?.closest(".ccc-approval-detail") !== null &&
            document.activeElement !== document.body,
        ),
      { timeoutMs: 15_000, intervalMs: 250, describe: "focus inside the opened request" },
    );
    const opened: string[] = [];
    const heading = await browser.execute(recordFocusInRenderer);
    if (heading !== null) opened.push(heading.name);
    const deny = await pressTabUntil((r) => r.name.startsWith(DENY_LABEL), 6, sequence);
    opened.push(deny.name);
    labels.push(await shot(22, "deny-focused"));
    const approve = await pressTabUntil((r) => r.name.startsWith(APPROVE_LABEL), 4, sequence);
    opened.push(approve.name);
    await browser.keys([Key.Shift, Key.Tab]);
    const back = await browser.execute(recordFocusInRenderer);
    expect(back?.name.startsWith(DENY_LABEL)).toBe(true);
    expect(firstFocusInRequestIsDeny(opened)).toBe(true);

    // The retained notification handler (the banner click) lands in the same place.
    const fromBanner: string[] = [];
    expect(await browser.execute(fireNotificationClick, 0)).toBe(true);
    const landed = await browser.execute(recordFocusInRenderer);
    if (landed !== null) fromBanner.push(landed.name);
    fromBanner.push(
      (
        await pressTabUntil(
          (r) => r.name.startsWith(DENY_LABEL) || r.name.startsWith(APPROVE_LABEL),
          6,
          [],
        )
      ).name,
    );
    expect(firstFocusInRequestIsDeny(fromBanner)).toBe(true);

    // Tasks: the tab strip by arrow keys, then chips, list, detail and the create form.
    await browser.execute(() => document.getElementById("ccc-tab-agent-runs")?.focus());
    await browser.keys(Key.ArrowLeft);
    await pollUntil(
      () =>
        browser.execute(
          () => document.getElementById("ccc-tab-tasks")?.getAttribute("aria-selected") === "true",
        ),
      { timeoutMs: 10_000, intervalMs: 250, describe: "the Tasks tab selected by keyboard" },
    );
    const chip = await pressTabUntil((r) => r.name.includes("task"), 10, sequence);
    expect(chip.focusVisible).toBe(true);
    labels.push(await shot(22, "tasks-chip-focused"));
    await browser.keys(Key.ArrowRight);
    await pressTabUntil((r) => r.classes.includes("ccc-task-title"), 12, sequence);
    await browser.keys(Key.Enter);
    await pressTabUntil((r) => r.classes.includes("ccc-text-input"), 40, sequence);
    labels.push(await shot(22, "task-detail-field-focused"));
    await runPluginCommand(asDriver(), commandId("create-task"));
    await pollUntil(
      () =>
        browser.execute(() => document.querySelector('form[aria-label="Create a task"]') !== null),
      { timeoutMs: 15_000, intervalMs: 250, describe: "the create form" },
    );
    await browser.keys(Key.Escape);
    await pollUntil(
      () =>
        browser.execute(() => document.querySelector('form[aria-label="Create a task"]') === null),
      { timeoutMs: 10_000, intervalMs: 250, describe: "Escape closing the create form" },
    );

    const names = sequence.map((record) => record.name);
    const order = checkFocusOrder(names, [
      "Pending",
      "Decided",
      "Expired",
      DENY_LABEL,
      APPROVE_LABEL,
    ]);
    expect(order).toEqual({ ok: true, reason: "" });
    // Every control reached by keyboard shows a visible focus ring.
    for (const record of sequence.filter((r) => r.tag === "button" || r.tag === "input")) {
      expect(record.focusVisible).toBe(true);
      expect(focusRingVisible(record.ring)).toBe(true);
    }
    recordLookPending({ runRoot: context.runRoot, item: 22, labels });
  });

  // Item 25 runs last: its meaning depends on activity having happened (a test approval sent,
  // the managed vault set up with the live-check notes).
  it("[06-UAT#25] The service log and the settings file hold no request or task text", async () => {
    await sendTestApprovalAndWait();
    await ensureVaultSetup();

    const logPath = join(context.paths.runtimeDir, "logs", "service.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    for (const marker of SYNTHETIC_MARKERS) {
      expect(countOccurrences(log, marker)).toBe(0);
    }

    const configDir = await obsidianPage.getConfigDir();
    const data = JSON.parse(await obsidianPage.read(DATA_FILE(configDir))) as unknown;
    expect(checkPluginDataKeys(data, { socketPath: context.socketPath })).toEqual([]);
  });
});
