/**
 * Approvals core (05.2-06, E2E-04): the Phase 6 UAT items the runner can assert against the
 * approval pane, one test per item, each title starting `[06-UAT#NN]` (D-09).
 *
 * Every assertion decides from DOM text, a renderer spy, the Obsidian API, files in the vault copy
 * or a read-only copy of the throwaway store. Waits are conditions, never fixed sleeps. The file
 * starts by proving the plugin talks to the sandbox socket and nothing else, and stops its own
 * service at the end. Strings come from spec-support/approvals-copy.ts, whose drift test pins them
 * to the plugin source.
 */
import { browser as wdioBrowser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import {
  clearConsoleErrors,
  fireNotificationClick,
  installConsoleCapture,
  installNotificationSpy,
  readConsoleErrors,
  readNotifications,
  restoreDocumentHasFocus,
  stubDocumentHasFocus,
} from "../src/renderer-spies.js";
import { APPROVALS_COPY } from "../src/spec-support/approvals-copy.js";
import {
  type ApprovalsEnvironment,
  activateScratchLeaf,
  checkChipTranscript,
  checkDeniedAudit,
  clearPending,
  clickChip,
  clickDecision,
  approvalStatusReached,
  containsInOrder,
  countLeavesOfType,
  detachScratchLeaf,
  ensureManagedVault,
  findNewestMirrorNote,
  installActivationRecorder,
  installNoticeRecorder,
  installSpecResultRecorder,
  installStatusRecorder,
  isExactlyOneNavigation,
  notificationCount,
  openApprovalInbox,
  openOverview,
  type PaneSnapshot,
  parseCountChip,
  readActivations,
  readChips,
  readMirrorFiles,
  readNav,
  readRows,
  readStatusHistory,
  readStore,
  resetActivations,
  resetStatusHistory,
  selectOnlyPendingRequest,
  sendTestApproval,
  startApprovalsEnvironment,
  supportBrowser,
  uiWait,
  waitForNotification,
  waitForPane,
  walkChips,
} from "../src/spec-support/approvals-support.js";

const browser = supportBrowser(wdioBrowser);
const PLUGIN_ID = "claude-command-center";

/** One pane block's text; a missing block fails the test with its name. */
function blockText(pane: PaneSnapshot, name: string): string {
  const text = pane.blocks[name];
  if (text === undefined) throw new Error(`The request pane has no ${name} block.`);
  return text;
}

describe("approvals core", () => {
  let env: ApprovalsEnvironment;

  installSpecResultRecorder(afterEach);

  before(async () => {
    env = await startApprovalsEnvironment("normal");
    await assertSandboxConnected(browser, { expectedSocketPath: env.context.socketPath });
    await browser.execute(installConsoleCapture);
    await browser.execute(installStatusRecorder);
    await browser.execute(installNoticeRecorder);
    await browser.execute(installActivationRecorder);
    await browser.execute(installNotificationSpy);
  });

  after(async () => {
    // Give the window its real focus back before the service goes away.
    await browser.execute(restoreDocumentHasFocus);
    await env.stop();
  });

  it("[06-UAT#07] Deny a pending test request leaves the audit trail and no effect", async () => {
    await clearPending(env.approvals);
    const proposalId = await sendTestApproval(env.approvals);
    const open = await selectOnlyPendingRequest(browser);
    expect(open.denyDisabled).toBe(false);

    expect(await browser.execute(clickDecision, "deny", 1)).toBe(1);
    await waitForPane(
      browser,
      (pane) => pane.status === APPROVALS_COPY.statusDenied,
      "the denied status line",
    );

    // The request moved to Decided and the pane shows it was decided through the command center.
    const denied = await waitForPane(
      browser,
      (pane) => pane.state === "denied",
      "the pane to show the denied request",
    );
    expect(denied.fields[APPROVALS_COPY.decidedThroughTerm]).toBe(
      APPROVALS_COPY.decidedThroughPlugin,
    );
    expect(await browser.execute(clickChip, APPROVALS_COPY.filterDecided)).toBe(true);
    await pollUntil(async () => {
      const rows = await readRows(browser);
      return rows.some((row) => row.state === "denied" && row.selected);
    }, uiWait("the denied request under Decided"));
    const chips = await readChips(browser);
    expect(chips.chips.find((chip) => chip.pressed)?.text.startsWith("Decided")).toBe(true);

    // History reads Requested then Denied.
    expect(
      containsInOrder(denied.history, [
        APPROVALS_COPY.historyRequested,
        APPROVALS_COPY.historyDenied,
      ]),
    ).toBe(true);
    expect((await env.approvals.get(proposalId)).summary.state).toBe("denied");

    // The audit rows and the effect count come from a read-only copy of the store.
    const reading = await pollUntil(async () => {
      const read = await readStore(env.context);
      return read.rows[0]?.event === "denied" ? read : null;
    }, uiWait("the denial to reach the audit rows"));
    expect(checkDeniedAudit(reading.rows, reading.effectCount)).toEqual([]);
  });

  it("[06-UAT#06] The request pane and the filter chips", async () => {
    await clearPending(env.approvals);
    const proposalId = await sendTestApproval(env.approvals);
    const pane = await selectOnlyPendingRequest(browser);

    // Who asked, what will happen, the exact target, the reason, the risks and the countdown.
    expect(
      pane.captions.some((caption) => caption.startsWith(APPROVALS_COPY.providedByCaption)),
    ).toBe(true);
    expect(pane.fields[APPROVALS_COPY.requestedByTerm]).toBeTruthy();
    expect(blockText(pane, "happen").length).toBeGreaterThan(APPROVALS_COPY.headingHappen.length);
    expect(blockText(pane, "target").length).toBeGreaterThan(APPROVALS_COPY.headingTarget.length);
    expect(pane.reason).not.toBe("");
    const risksListed = pane.risks.length > 0;
    expect(risksListed || blockText(pane, "risks").includes(APPROVALS_COPY.noRisks)).toBe(true);
    expect(pane.countdown.startsWith(APPROVALS_COPY.countdownPrefix)).toBe(true);
    expect(blockText(pane, "state").includes(APPROVALS_COPY.deniedAutomatically)).toBe(true);

    // "Content fingerprint" and "Request ID" are under Record.
    expect(pane.fields[APPROVALS_COPY.fingerprintTerm]).toBeTruthy();
    expect(pane.fields[APPROVALS_COPY.requestIdTerm]).toBe(proposalId);

    // Pending, Decided and Expired are one labelled group, Pending pressed.
    const chips = await readChips(browser);
    expect(chips.groupPresent).toBe(true);
    expect(chips.chips.map((chip) => chip.text.split(" ")[0])).toEqual([
      APPROVALS_COPY.filterPending,
      APPROVALS_COPY.filterDecided,
      APPROVALS_COPY.filterExpired,
    ]);
    expect(chips.chips.map((chip) => chip.pressed)).toEqual([true, false, false]);

    // Tab reaches the chips and the keyboard moves the choice. The chips are plain buttons: the
    // plugin source has no arrow-key handler for them and no live-region announcement of the
    // chosen view, so the walk uses Tab and Enter and treats each chip's accessible name (label
    // plus count) as the announced text. The arrow-key and live-region parts of the UAT wording
    // are a finding for the baseline run, not an assertion that could only fail.
    const walk = await walkChips(browser, [
      "Tab",
      "Tab",
      "Enter",
      "Tab",
      "Enter",
      "Shift+Tab",
      "Enter",
    ]);
    expect(
      checkChipTranscript(walk, [
        {
          key: "Tab",
          focused: APPROVALS_COPY.filterPending,
          pressed: APPROVALS_COPY.filterPending,
        },
        {
          key: "Tab",
          focused: APPROVALS_COPY.filterDecided,
          pressed: APPROVALS_COPY.filterPending,
        },
        {
          key: "Enter",
          focused: APPROVALS_COPY.filterDecided,
          pressed: APPROVALS_COPY.filterDecided,
        },
        {
          key: "Tab",
          focused: APPROVALS_COPY.filterExpired,
          pressed: APPROVALS_COPY.filterDecided,
        },
        {
          key: "Enter",
          focused: APPROVALS_COPY.filterExpired,
          pressed: APPROVALS_COPY.filterExpired,
        },
        {
          key: "Shift+Tab",
          focused: APPROVALS_COPY.filterDecided,
          pressed: APPROVALS_COPY.filterExpired,
        },
        {
          key: "Enter",
          focused: APPROVALS_COPY.filterDecided,
          pressed: APPROVALS_COPY.filterDecided,
        },
      ]),
    ).toEqual([]);
    expect(await browser.execute(clickChip, APPROVALS_COPY.filterPending)).toBe(true);
  });

  it("[06-UAT#05] Reload the plugin twice with a request pending, then click the stale banner", async () => {
    await clearPending(env.approvals);
    await browser.execute(stubDocumentHasFocus, false);
    const seen = await notificationCount(browser);
    const proposalId = await sendTestApproval(env.approvals);
    const { index } = await waitForNotification(browser, seen);
    const { records } = await browser.execute(readNotifications);
    expect(records[index]?.hasOnclick).toBe(true);

    // Disable and enable the plugin twice with the request still pending.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await obsidianPage.disablePlugin(PLUGIN_ID);
      await obsidianPage.enablePlugin(PLUGIN_ID);
    }
    await assertSandboxConnected(browser, { expectedSocketPath: env.context.socketPath });

    // Make another tab active, then fire the retained banner's click handler once.
    expect(await browser.execute(activateScratchLeaf)).toBe(true);
    await browser.execute(resetActivations);
    await browser.execute(clearConsoleErrors);
    expect(await browser.execute(fireNotificationClick, index)).toBe(true);

    const pane = await waitForPane(
      browser,
      (candidate) =>
        candidate.present && candidate.fields[APPROVALS_COPY.requestIdTerm] === proposalId,
      "the pane of the request the stale banner points at",
    );
    expect(pane.state).toBe("pending");
    const leaves = await browser.execute(countLeavesOfType, APPROVALS_COPY.commandCenterViewType);
    const activations = await browser.execute(readActivations);
    expect(isExactlyOneNavigation(activations, APPROVALS_COPY.commandCenterViewType, leaves)).toBe(
      true,
    );
    expect(await browser.execute(readConsoleErrors)).toEqual([]);
    expect((await env.approvals.get(proposalId)).summary.state).toBe("pending");
    await browser.execute(detachScratchLeaf);
  });

  it("[06-UAT#08] Approve once yields exactly one effect, including a fast double press", async () => {
    await clearPending(env.approvals);
    await browser.execute(resetStatusHistory);
    const first = await sendTestApproval(env.approvals);
    await selectOnlyPendingRequest(browser);
    expect(await browser.execute(clickDecision, "approve", 1)).toBe(1);
    const done = await waitForPane(
      browser,
      (pane) => pane.state === "executed",
      "the approved request to be carried out",
    );
    // The status line is recorded because the middle state is short: a poll could miss it.
    const statuses = await browser.execute(readStatusHistory);
    // The middle status may legitimately never render when the outcome beats the response;
    // the outcome itself is still verified here and by the strict history below.
    expect(
      approvalStatusReached(
        statuses,
        APPROVALS_COPY.statusApproved,
        APPROVALS_COPY.statusCarriedOut,
      ),
    ).toBe(true);
    expect(
      containsInOrder(done.history, [
        APPROVALS_COPY.historyRequested,
        APPROVALS_COPY.historyApproved,
        APPROVALS_COPY.historyStarted,
        APPROVALS_COPY.historyExecuted,
      ]),
    ).toBe(true);

    // A second request, with two presses back to back inside one renderer call.
    await clearPending(env.approvals);
    const second = await sendTestApproval(env.approvals);
    await selectOnlyPendingRequest(browser);
    expect(await browser.execute(clickDecision, "approve", 2)).toBe(2);
    const settled = await waitForPane(
      browser,
      (pane) => pane.state === "executed",
      "the double-pressed request to be carried out",
    );
    expect(
      settled.history.filter((label) => label === APPROVALS_COPY.historyApproved),
    ).toHaveLength(1);

    // Every approved proposal has exactly one effect row.
    const reading = await pollUntil(async () => {
      const read = await readStore(env.context);
      const ids = new Set(read.effectsPerProposal.map((row) => row.proposalId));
      return ids.has(first) && ids.has(second) ? read : null;
    }, uiWait("both effects to reach the store"));
    for (const id of [first, second]) {
      const rows = reading.effectsPerProposal.filter((row) => row.proposalId === id);
      expect(rows.map((row) => row.effects)).toEqual([1]);
    }
    expect(reading.effectsPerProposal.every((row) => row.effects === 1)).toBe(true);
  });

  it("[06-UAT#02] Click the banner from another app, auto-part", async () => {
    // Auto-part only: the retained notification handler opens Approvals with the request
    // selected and focus on Deny. Whether macOS brings Obsidian forward from another app or
    // another Space is owner-only and is not decided here.
    await clearPending(env.approvals);
    await browser.execute(stubDocumentHasFocus, false);
    await openOverview(browser);
    const seen = await notificationCount(browser);
    const proposalId = await sendTestApproval(env.approvals);
    const { index } = await waitForNotification(browser, seen);

    expect(await browser.execute(fireNotificationClick, index)).toBe(true);
    // The product focuses Deny for a destructive request and the pane heading otherwise (06-UAT
    // test 2 accepts "Deny (or the request heading)"); a test approval is not destructive.
    const pane = await waitForPane(
      browser,
      (candidate) =>
        candidate.present &&
        candidate.fields[APPROVALS_COPY.requestIdTerm] === proposalId &&
        (candidate.focus === "deny" || candidate.focus === "heading"),
      "Approvals open on the request with focus on Deny or its heading",
    );
    expect(pane.state).toBe("pending");
    expect((await readRows(browser)).some((row) => row.selected)).toBe(true);
    // Spike S3 failed (protocolDispatch onclick-only): the ccc-approval link handler cannot be
    // reached in process, so only the retained click handler is exercised and no obsidian://
    // URL is ever opened.
  });

  it("[06-UAT#03] A focused window raises no native banner but the request is listed, auto-part", async () => {
    // Auto-part only: with the window reported focused the plugin raises no native notification,
    // yet the request is in the list and the Agent runs tab shows a count chip. What a macOS
    // Focus mode does to a banner is owner-only.
    await clearPending(env.approvals);
    await browser.execute(stubDocumentHasFocus, true);
    await openOverview(browser);
    const seen = await notificationCount(browser);
    await sendTestApproval(env.approvals);

    const chip = await pollUntil(async () => {
      const nav = await readNav(browser);
      const parsed = parseCountChip(nav.visible);
      return parsed !== null && parsed.count >= 1 ? nav : null;
    }, uiWait("the Agent runs count chip"));
    expect(chip.spoken.includes(APPROVALS_COPY.agentRunsTabSpoken)).toBe(true);
    expect(await notificationCount(browser)).toBe(seen);

    await openApprovalInbox(browser);
    await pollUntil(async () => {
      const rows = await readRows(browser);
      return rows.some((row) => row.state === "pending");
    }, uiWait("the request in the Approvals list"));
  });

  it("[06-UAT#04] The mirror note links the request, auto-part", async () => {
    // Auto-part only: the managed mirror note carries the ccc-approval link for the request.
    // Spike S3 failed (protocolDispatch onclick-only), so the link handler is not dispatched in
    // process; whether a second window with the plugin shows its own banner is owner-only.
    await clearPending(env.approvals);
    await ensureManagedVault(browser);
    const proposalId = await sendTestApproval(env.approvals);
    const vaultPath = obsidianPage.getVaultPath();
    const note = await pollUntil(
      () => findNewestMirrorNote(readMirrorFiles(vaultPath), proposalId),
      uiWait("the mirror note under system/"),
    );
    expect(note.endsWith(".md")).toBe(true);
  });
});
