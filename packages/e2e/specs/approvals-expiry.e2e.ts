/**
 * Approvals expiry (05.2-06, E2E-04): Phase 6 UAT item 9 on a service with the 15 second test
 * lifetime. This is the only spec that starts a service of the expiry kind (D-05); it never
 * restarts it. The file starts by proving the plugin talks to the sandbox socket only and stops
 * its own service at the end.
 */
import { browser as wdioBrowser } from "@wdio/globals";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { installConsoleCapture } from "../src/renderer-spies.js";
import { APPROVALS_COPY } from "../src/spec-support/approvals-copy.js";
import {
  type ApprovalsEnvironment,
  clearPending,
  EXPIRY_AUDIT_BOUND_MS,
  EXPIRY_LIFETIME_CEILING_MS,
  EXPIRY_PRESS_OFFSET_MS,
  EXPIRY_SETTLE_GRACE_MS,
  installSpecResultRecorder,
  installStatusRecorder,
  readChips,
  readStore,
  scheduleDecisionClick,
  selectOnlyPendingRequest,
  sendTestApproval,
  expiredWithinBound,
  readScheduledPress,
  settledWithinGrace,
  startApprovalsEnvironment,
  supportBrowser,
  uiWait,
  waitForPane,
} from "../src/spec-support/approvals-support.js";

const browser = supportBrowser(wdioBrowser);

describe("approvals expiry", () => {
  let env: ApprovalsEnvironment;

  installSpecResultRecorder(afterEach);

  before(async () => {
    env = await startApprovalsEnvironment("expiry");
    await assertSandboxConnected(browser, { expectedSocketPath: env.context.socketPath });
    await browser.execute(installConsoleCapture);
    await browser.execute(installStatusRecorder);
  });

  after(async () => {
    await env.stop();
  });

  it("[06-UAT#09] A request nobody decides expires within a second of its lifetime and is audited", async () => {
    await clearPending(env.approvals);
    const proposalId = await sendTestApproval(env.approvals);
    const summary = (await env.approvals.get(proposalId)).summary;
    const expiresAtMs = Date.parse(summary.expiresAt);
    // The short lifetime is only in force when the expiry-kind service really carries the override.
    expect(expiresAtMs - Date.parse(summary.createdAt)).toBeLessThanOrEqual(
      EXPIRY_LIFETIME_CEILING_MS,
    );

    // Open the request while it is pending, then leave the pane open on it.
    const pane = await selectOnlyPendingRequest(browser);
    expect(pane.countdown.startsWith(APPROVALS_COPY.countdownPrefix)).toBe(true);

    // The plugin's clock ticks once a minute, so the pane still offers Deny just after the
    // lifetime ends and until the service's event arrives. A press scheduled for the instant
    // after expiry is therefore a decision on a request that expired: the service answers
    // "expired" and the pane ends with the closed-error line.
    expect(
      await browser.execute(scheduleDecisionClick, "deny", expiresAtMs + EXPIRY_PRESS_OFFSET_MS),
    ).toBe(true);

    // Wait on the request's own state, never a sleep: it leaves Pending and appears under Expired.
    await waitForPane(
      browser,
      (candidate) => candidate.state === "expired",
      "the open request to show as expired",
      EXPIRY_LIFETIME_CEILING_MS * 2,
    );
    const observedAtMs = Date.now();
    expect(settledWithinGrace(expiresAtMs, observedAtMs, EXPIRY_SETTLE_GRACE_MS)).toBe(true);
    // The scheduled press must have found the Deny button; if the pane had already dropped it,
    // the closed-error line below can never appear and the cause is this, not a slow service.
    expect(await browser.execute(readScheduledPress)).toBe("clicked");

    const closed = await waitForPane(
      browser,
      (candidate) => candidate.status === APPROVALS_COPY.statusExpiredClosed,
      "the closed-error line after a decision on the expired request",
    );
    expect(closed.status).toBe(APPROVALS_COPY.statusExpiredClosed);

    const chips = await readChips(browser);
    const expiredChip = chips.chips.find((chip) =>
      chip.name.startsWith(APPROVALS_COPY.filterExpired),
    );
    expect(expiredChip?.name).toMatch(/^Expired, [1-9]\d* requests?$/);

    // The audit rows end with an expired event, read from a copy of the store.
    const reading = await pollUntil(async () => {
      const read = await readStore(env.context);
      return read.expired.some((row) => row.proposalId === proposalId) ? read : null;
    }, uiWait("the expired event in the audit rows"));
    const audited = reading.expired.find((row) => row.proposalId === proposalId);
    expect(audited?.event).toBe("expired");
    // The UAT bound (about a second) is checked on the service's own audit timestamp, not on
    // when wdio happened to observe the pane.
    expect(expiredWithinBound(expiresAtMs, audited?.at, EXPIRY_AUDIT_BOUND_MS)).toBe(true);
  });
});
