/**
 * Approvals lifecycle (05.2-06, E2E-04): Phase 6 UAT items 24 and 10 (item 13 is owner-run since
 * the D-09 amendment of 2026-10-13: Obsidian never attaches the settings dialog to the driver) on a service with the
 * normal lifetime (never the expiry kind: a 15 second lifetime would expire the request while
 * the service is down, which is the Gap recorded in the UAT script). The order matters: item 24
 * starts the service first and ends with it up, and item 10
 * ends with a full Obsidian reload. The file starts by proving the plugin talks to the sandbox
 * socket only and stops its own service at the end.
 */
import { browser as wdioBrowser } from "@wdio/globals";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import {
  installConsoleCapture,
  installNotificationSpy,
  restoreDocumentHasFocus,
} from "../src/renderer-spies.js";
import { APPROVALS_COPY } from "../src/spec-support/approvals-copy.js";
import {
  type ApprovalsEnvironment,
  clearPending,
  countLeavesOfType,
  ensureManagedVault,
  ensureRunning,
  installNoticeRecorder,
  installSpecResultRecorder,
  installStatusRecorder,
  readPane,
  readPanel,
  selectOnlyPendingRequest,
  sendTestApproval,
  startApprovalsEnvironment,
  supportBrowser,
  uiWait,
  visitDestination,
  waitForPane,
} from "../src/spec-support/approvals-support.js";

const browser = supportBrowser(wdioBrowser);

/**
 * Waits until the plugin's own client has reconnected after a service restart. A request opened
 * while it is still reconnecting fails to load and the pane stays on "Couldn't load this request"
 * (run 12: items 24 and 10 never saw their request), so every step that needs a loaded request
 * waits for this first.
 */
async function waitForPluginConnected(): Promise<void> {
  await pollUntil(
    async () => !(await readPanel(browser)).text.includes(APPROVALS_COPY.serviceDisconnected),
    uiWait("the plugin to be connected to the service"),
  );
}

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

  it("[06-UAT#24] Disconnect drill: both destinations say so, controls are disabled, Obsidian responds, and they recover", async () => {
    await ensureRunning(env.fixture);
    await waitForPluginConnected();
    await clearPending(env.approvals);
    await sendTestApproval(env.approvals);
    await selectOnlyPendingRequest(browser);
    // Visit both destinations, ending on Agent runs with the request open.
    await visitDestination(browser, "tasks", APPROVALS_COPY.tasksLabel);
    await visitDestination(browser, "agent-runs", APPROVALS_COPY.agentRunsLabel);
    // Coming back reloads the request; stopping the service before that finished left the pane on
    // "Couldn't load this request" with no decision controls (run 12). Stop only once it is loaded.
    await waitForPane(
      browser,
      (pane) => pane.present && pane.state === "pending" && !pane.denyDisabled,
      "the request to be loaded and decidable before the service stops",
    );

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
    await waitForPluginConnected();
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
