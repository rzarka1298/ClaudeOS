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
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { installConsoleCapture } from "../src/renderer-spies.js";
import { APPROVALS_COPY } from "../src/spec-support/approvals-copy.js";
import {
  type ApprovalsEnvironment,
  checkDeniedAudit,
  clearPending,
  clickChip,
  clickDecision,
  containsInOrder,
  installSpecResultRecorder,
  installStatusRecorder,
  readChips,
  readRows,
  readStore,
  selectOnlyPendingRequest,
  sendTestApproval,
  startApprovalsEnvironment,
  supportBrowser,
  uiWait,
  waitForPane,
} from "../src/spec-support/approvals-support.js";

const browser = supportBrowser(wdioBrowser);

describe("approvals core", () => {
  let env: ApprovalsEnvironment;

  installSpecResultRecorder(afterEach);

  before(async () => {
    env = await startApprovalsEnvironment("normal");
    await assertSandboxConnected(browser, { expectedSocketPath: env.context.socketPath });
    await browser.execute(installConsoleCapture);
    await browser.execute(installStatusRecorder);
  });

  after(async () => {
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
});
