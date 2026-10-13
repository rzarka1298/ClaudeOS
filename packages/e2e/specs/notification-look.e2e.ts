/**
 * 06-UAT test 1 (05.2-08, E2E-04, E2E-05): the unfocused notification banner.
 *
 * What is asserted: with the window reported focused no native notification is created; with the
 * window reported unfocused (and Finder, the one allowlisted app, brought to the front) the
 * plugin creates exactly the generic notification (fixed title, generic body, no actions, a click
 * handler, permission granted). That content check is the spy's part.
 *
 * What is looked at: the banner's appearance. Recorded spike decisions (05.2-RESEARCH.md): S1's
 * re-run is pending, so `bannerAutomation` is spy-only and NO screen region is captured; the
 * banner's appearance then stays with the owner. Only when the decision is changed to
 * spy-and-region does this file take the small top-right region capture (once, then once a
 * second later), into the private shots folder, viewed once and deleted, never committed (PRIV-04).
 * This is the only spec allowed to reference the region capture (static guard).
 *
 * Authored and CI-checked only (D-15); the live run is the orchestrator's baseline in 05.2-09.
 */
import { createApprovalsClient, createAuthenticatedClient } from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import {
  assertSandboxConnected,
  type DriverBrowser,
  pollUntil,
  runPluginCommand,
} from "../src/driver.js";
import {
  installConsoleCapture,
  installNotificationSpy,
  readNotifications,
  restoreDocumentHasFocus,
  stubDocumentHasFocus,
} from "../src/renderer-spies.js";
import { installResultRecorder, type RecorderOptions } from "../src/results.js";
import { captureRegion, shotPath } from "../src/screenshots.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../src/spec-context.js";
import {
  clearPending,
  pressSettingByName,
  readSettingsOutline,
} from "../src/spec-support/approvals-support.js";
import { SEND_TEST_APPROVAL_NAME, SYNTHETIC_MARKERS } from "../src/spec-support/cross-copy.js";
import { recordLookPending } from "../src/spec-support/cross-support.js";
import {
  activateAllowlistedApp,
  bannerRegion,
  checkNoNotificationWhileFocused,
  checkNotificationRecord,
} from "../src/spec-support/synthetic-session.js";
import { SPIKE_DECISIONS } from "../src/spike-decisions.js";

const BANNER_SETTLE_MS = 1_000;

let context: RunContext;
let fixture: ReturnType<typeof serviceFixtureFor> | undefined;
const service = (): ReturnType<typeof serviceFixtureFor> => {
  if (fixture === undefined) fixture = serviceFixtureFor(context);
  return fixture;
};

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

/** Presses Send a test approval in the plugin's settings and closes the dialog. */
async function sendTestApproval(): Promise<void> {
  // Open the tab once, then poll for the row: it renders from declarative definitions, so a read
  // straight after the open can miss it (and re-opening on every poll restarts the render).
  await browser.executeObsidian(({ app }) => {
    const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } })
      .setting;
    setting.open();
    setting.openTabById("claude-command-center");
  });
  let pressed: boolean;
  try {
    pressed = await pollUntil(() => browser.execute(pressSettingByName, SEND_TEST_APPROVAL_NAME), {
      timeoutMs: 15_000,
      intervalMs: 500,
      describe: "the Send a test approval settings row",
    });
  } catch (error) {
    const outline = await browser.execute(readSettingsOutline);
    throw new Error(`${error instanceof Error ? error.message : String(error)} | ${outline}`);
  }
  await browser.executeObsidian(({ app }) => {
    (app as unknown as { setting: { close(): void } }).setting.close();
  });
  expect(pressed).toBe(true);
}

const pendingRows = (): Promise<number> =>
  browser.execute(() => document.querySelectorAll(".ccc-approval-row").length);

before(async function startRun() {
  context = loadRunContext();
  installResultRecorder({
    afterEach: afterEach as unknown as RecorderOptions["afterEach"],
    resultsPath: context.paths.resultsPath,
  });
  await service().start({ kind: "normal" });
  await assertSandboxConnected(browser as unknown as DriverBrowser, {
    expectedSocketPath: context.socketPath,
  });
  await browser.execute(installConsoleCapture);
  await browser.execute(installNotificationSpy);
  // Nothing has opened the command center yet in this spec's fresh window, so open it first.
  await runPluginCommand(
    browser as unknown as DriverBrowser,
    "claude-command-center:open-overview",
  );
  await pollUntil(
    () => browser.execute(() => document.getElementById("ccc-tab-agent-runs") !== null),
    {
      timeoutMs: 15_000,
      intervalMs: 250,
      describe: "the Agent runs tab",
    },
  );
  await browser.execute(() => {
    (document.getElementById("ccc-tab-agent-runs") as HTMLElement).click();
  });
});

after(async function stopRun() {
  await browser.execute(restoreDocumentHasFocus);
  await service().stop();
});

describe("notification banner", () => {
  it("[06-UAT#01] An unfocused window gets one generic banner; a focused window gets none", async () => {
    // Focused: the window reports focus, so the plugin must create no native notification.
    await browser.execute(stubDocumentHasFocus, true);
    await sendTestApproval();
    await pollUntil(async () => (await pendingRows()) >= 1, {
      timeoutMs: 30_000,
      intervalMs: 500,
      describe: "the first test request in Approvals",
    });
    const whileFocused = await browser.execute(readNotifications);
    expect(checkNoNotificationWhileFocused(whileFocused.records)).toEqual({
      ok: true,
      problems: [],
    });

    // Unfocused: Finder (the only allowlisted app) comes to the front and the renderer reports no focus.
    await activateAllowlistedApp("Finder");
    await browser.execute(stubDocumentHasFocus, false);
    await settlePendingRequests();
    await sendTestApproval();
    const seen = await pollUntil(
      async () => {
        const current = await browser.execute(readNotifications);
        return current.records.length > 0 ? current : null;
      },
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        describe: "the notification of the second test request",
      },
    );
    const record = seen.records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    const verdict = checkNotificationRecord(
      { ...record, permission: seen.permission },
      { forbidden: SYNTHETIC_MARKERS },
    );
    expect(verdict).toEqual({ ok: true, problems: [] });

    if (SPIKE_DECISIONS.bannerAutomation !== "spy-and-region") {
      console.log(
        "banner region capture skipped: bannerAutomation is spy-only (S1 re-run pending); the banner's appearance stays with the owner",
      );
      return;
    }
    const shotsDir = context.shotsDir;
    if (shotsDir === undefined)
      throw new Error("No shots folder: the banner capture cannot be recorded.");
    const screen = await browser.execute(() => ({
      width: Math.round(window.screen.width),
      height: Math.round(window.screen.height),
    }));
    const rect = bannerRegion(screen);
    const labels: string[] = [];
    for (const label of ["banner-first", "banner-second"]) {
      await captureRegion({ shotsDir, outPath: shotPath(shotsDir, 1, label), rect });
      labels.push(label);
      if (labels.length < 2) await browser.pause(BANNER_SETTLE_MS);
    }
    recordLookPending({ runRoot: context.runRoot, item: 1, labels });
  });
});
