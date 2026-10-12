/**
 * Approvals lifecycle (05.2-06, E2E-04): Phase 6 UAT items 13, 24 and 10 on a service with the
 * normal lifetime (never the expiry kind: a 15 second lifetime would expire the request while
 * the service is down, which is the Gap recorded in the UAT script). The order matters: item 13
 * needs the service up and ends with it stopped, item 24 starts it again first, and item 10
 * ends with a full Obsidian reload. The file starts by proving the plugin talks to the sandbox
 * socket only and stops its own service at the end.
 */
import { browser as wdioBrowser } from "@wdio/globals";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import {
  installConsoleCapture,
  installNotificationSpy,
  readNotifications,
  restoreDocumentHasFocus,
  stubDocumentHasFocus,
} from "../src/renderer-spies.js";
import { APPROVALS_COPY } from "../src/spec-support/approvals-copy.js";
import {
  type ApprovalsEnvironment,
  clearNotices,
  clearPending,
  closeSettings,
  countLeavesOfType,
  ensureManagedVault,
  ensureRunning,
  installNoticeRecorder,
  installSpecResultRecorder,
  installStatusRecorder,
  notificationCount,
  openApprovalInbox,
  openOverview,
  openSettingsTab,
  parseRebuildStatus,
  pressSettingRow,
  readNav,
  readNotices,
  readPane,
  readPanel,
  readPluginSettings,
  readRows,
  SETTINGS_POLL_MS,
  selectOnlyPendingRequest,
  sendTestApproval,
  settingRow,
  startApprovalsEnvironment,
  supportBrowser,
  toggleSettingRow,
  uiWait,
  visitDestination,
  waitForPane,
} from "../src/spec-support/approvals-support.js";

const browser = supportBrowser(wdioBrowser);

describe("approvals lifecycle", () => {
  let env: ApprovalsEnvironment;

  installSpecResultRecorder(afterEach);

  before(async () => {
    env = await startApprovalsEnvironment("normal");
    await assertSandboxConnected(browser, { expectedSocketPath: env.context.socketPath });
    await browser.execute(installConsoleCapture);
    await browser.execute(installStatusRecorder);
    await browser.execute(installNoticeRecorder);
    await browser.execute(installNotificationSpy);
    // Rebuild task index needs the vault the service was told about.
    await ensureManagedVault(browser);
  });

  after(async () => {
    await browser.execute(restoreDocumentHasFocus);
    await env.stop();
  });

  it("[06-UAT#13] Settings: Approvals and Tasks groups", async () => {
    const settings = await openSettingsTab(browser);
    expect(settings.headings).toEqual(
      expect.arrayContaining([
        APPROVALS_COPY.approvalsGroupHeading,
        APPROVALS_COPY.tasksGroupHeading,
      ]),
    );
    const notifyRow = settingRow(settings, APPROVALS_COPY.notifyApprovalsName);
    expect(notifyRow.hasToggle).toBe(true);
    settingRow(settings, APPROVALS_COPY.sendTestApprovalName);
    settingRow(settings, APPROVALS_COPY.rebuildName);

    // Approval notifications off: no native banner, the request still lists, a Notice appears.
    try {
      if (notifyRow.toggleOn) {
        expect(await browser.execute(toggleSettingRow, APPROVALS_COPY.notifyApprovalsName)).toBe(
          true,
        );
      }
      await pollUntil(
        async () =>
          (await readPluginSettings(browser))[APPROVALS_COPY.notifyApprovalsKey] === false,
        uiWait("the notification setting to be saved off"),
      );
      await browser.execute(closeSettings);

      await clearPending(env.approvals);
      await browser.execute(stubDocumentHasFocus, false);
      const seen = await notificationCount(browser);
      await sendTestApproval(env.approvals);
      await pollUntil(
        async () => (await env.approvals.list()).pending.length === 1,
        uiWait("the request to be listed by the service"),
      );
      await pollUntil(async () => {
        const nav = await readNav(browser);
        return nav.visible !== "";
      }, uiWait("the request to reach the plugin"));
      expect((await browser.execute(readNotifications)).records).toHaveLength(seen);

      // Window focused and the section off screen: an Obsidian Notice replaces the banner.
      await clearPending(env.approvals);
      await browser.execute(stubDocumentHasFocus, true);
      await openOverview(browser);
      await browser.execute(clearNotices);
      await sendTestApproval(env.approvals);
      await pollUntil(
        async () => (await browser.execute(readNotices)).includes(APPROVALS_COPY.inboxNoticeText),
        uiWait("the Obsidian Notice for the new request"),
      );
      expect(await notificationCount(browser)).toBe(seen);
      await openApprovalInbox(browser);
      await pollUntil(async () => {
        const rows = await readRows(browser);
        return rows.some((row) => row.state === "pending");
      }, uiWait("the request in the Approvals list"));
    } finally {
      // Leave the setting on for whatever runs after this file.
      const restore = await openSettingsTab(browser);
      if (!settingRow(restore, APPROVALS_COPY.notifyApprovalsName).toggleOn) {
        await browser.execute(toggleSettingRow, APPROVALS_COPY.notifyApprovalsName);
      }
      await browser.execute(closeSettings);
    }

    // Rebuild task index: "Rebuilding ..." then "Task index rebuilt. N tasks found." with two
    // notes needing attention in the live vault.
    await openSettingsTab(browser);
    await browser.execute(clearNotices);
    expect(await browser.execute(pressSettingRow, APPROVALS_COPY.rebuildName)).toBe(true);
    const rebuilt = await pollUntil(async () => {
      const statuses = (await browser.execute(readNotices)).map(parseRebuildStatus);
      const done = statuses.find((status) => status?.phase === "rebuilt");
      return done?.phase === "rebuilt" && statuses.some((s) => s?.phase === "rebuilding")
        ? done
        : null;
    }, uiWait("the task index rebuild to report"));
    expect(rebuilt.tasks).toBeGreaterThanOrEqual(300);
    expect(rebuilt.attention).toBe(2);

    // With the service stopped both rows say the companion service is needed. The settings tab
    // only re-renders when it is opened, so each poll reopens it.
    await env.fixture.stop();
    await pollUntil(
      async () => {
        await browser.execute(closeSettings);
        const settings = await openSettingsTab(browser);
        return [APPROVALS_COPY.sendTestApprovalName, APPROVALS_COPY.rebuildName].every((name) =>
          settingRow(settings, name).description.includes(APPROVALS_COPY.needsService),
        );
      },
      { ...uiWait("both rows to need the companion service"), intervalMs: SETTINGS_POLL_MS },
    );
    await browser.execute(closeSettings);
  });

  it("[06-UAT#24] Disconnect drill: both destinations say so, controls are disabled, Obsidian responds, and they recover", async () => {
    await ensureRunning(env.fixture);
    await clearPending(env.approvals);
    await sendTestApproval(env.approvals);
    await selectOnlyPendingRequest(browser);
    // Visit both destinations, ending on Agent runs with the request open.
    await visitDestination(browser, "tasks", APPROVALS_COPY.tasksLabel);
    await visitDestination(browser, "agent-runs", APPROVALS_COPY.agentRunsLabel);

    await env.fixture.stop();

    // Agent runs: the service-down sentence, decisions disabled with a visible reason.
    const down = await waitForPane(
      browser,
      (pane) => pane.denyDisabled && pane.approveDisabled && pane.decisionReasons.length > 0,
      "the decisions to be disabled while the service is down",
    );
    expect(down.decisionReasons).toContain(APPROVALS_COPY.serviceDown);
    expect((await readPanel(browser)).text).toContain(APPROVALS_COPY.serviceDisconnected);

    // Tasks: "Service disconnected", the reason on the controls, task actions disabled.
    await visitDestination(browser, "tasks", APPROVALS_COPY.tasksLabel);
    const tasksDown = await pollUntil(async () => {
      const panel = await readPanel(browser);
      return panel.text.includes(APPROVALS_COPY.serviceDisconnected) &&
        panel.text.includes(APPROVALS_COPY.tasksDisconnectedReason) &&
        panel.disabledCount > 0
        ? panel
        : null;
    }, uiWait("the Tasks destination to say the service is disconnected"));
    expect(tasksDown.disabledCount).toBeGreaterThan(0);

    // The rest of Obsidian still responds: a workspace call succeeds.
    expect(await browser.execute(countLeavesOfType, APPROVALS_COPY.commandCenterViewType)).toBe(1);

    // Start the service again: both recover without a manual refresh.
    await env.fixture.start({ kind: "normal" });
    await pollUntil(async () => {
      const panel = await readPanel(browser);
      return panel.text.includes(APPROVALS_COPY.serviceDisconnected) ? null : panel;
    }, uiWait("Tasks to recover"));
    await visitDestination(browser, "agent-runs", APPROVALS_COPY.agentRunsLabel);
    const back = await waitForPane(
      browser,
      (pane) => pane.present && pane.state === "pending" && !pane.denyDisabled,
      "the pending request to be decidable again after the restart",
    );
    expect(back.decisionReasons).not.toContain(APPROVALS_COPY.serviceDown);
  });

  it("[06-UAT#10] Service restart and full Obsidian reload while a request is pending", async () => {
    await ensureRunning(env.fixture);
    await clearPending(env.approvals);
    const proposalId = await sendTestApproval(env.approvals);
    const before = await selectOnlyPendingRequest(browser);
    const fingerprint = before.fields[APPROVALS_COPY.fingerprintTerm];
    expect(fingerprint).toBeTruthy();
    expect(before.fields[APPROVALS_COPY.requestIdTerm]).toBe(proposalId);

    // While the service is down: the disconnect copy and disabled decisions.
    await env.fixture.stop();
    const down = await waitForPane(
      browser,
      (pane) => pane.denyDisabled && pane.decisionReasons.includes(APPROVALS_COPY.serviceDown),
      "the disconnect copy and disabled decisions",
    );
    expect(down.approveDisabled).toBe(true);

    // Restart on the same runtime directory: the same request is pending, same fingerprint.
    await env.fixture.start({ kind: "normal" });
    const after = await waitForPane(
      browser,
      (pane) =>
        pane.present &&
        pane.state === "pending" &&
        !pane.denyDisabled &&
        !pane.decisionReasons.includes(APPROVALS_COPY.serviceDown),
      "the same request to be decidable after the restart",
    );
    expect(after.fields[APPROVALS_COPY.requestIdTerm]).toBe(proposalId);
    expect(after.fields[APPROVALS_COPY.fingerprintTerm]).toBe(fingerprint);

    // Quit and reopen Obsidian fully: the request is still there and decidable. A reload clears
    // the window, so the sandbox check runs again before anything else.
    await browser.reloadObsidian();
    await assertSandboxConnected(browser, { expectedSocketPath: env.context.socketPath });
    await browser.execute(installStatusRecorder);
    await selectOnlyPendingRequest(browser);
    const reloaded = await readPane(browser);
    expect(reloaded.fields[APPROVALS_COPY.requestIdTerm]).toBe(proposalId);
    expect(reloaded.fields[APPROVALS_COPY.fingerprintTerm]).toBe(fingerprint);
    expect(reloaded.denyDisabled).toBe(false);
    expect(reloaded.approvePresent).toBe(true);
  });
});
