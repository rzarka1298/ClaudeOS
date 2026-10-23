/**
 * The Settings > Diagnostics items of the Phase 8 UAT (plan 08-20, DIAG-02, DIAG-03, D-09, D-27,
 * D-28): the fresh-install look and, in later cases, every break drill the sandbox can make. Everything
 * runs inside the run's sandbox: its own runtime folder, Claude config folder, Codex folders, store
 * and throwaway vaults, through the 08-05 drill helpers, with every permission change undone in a
 * finally. The service comes from `startResearchEnvironment`, so a gesture check asks about the
 * sandbox's nonexistent research-key account and never the owner's. No drill launches an app.
 * Authored and CI-verified only (D-15); the live behaviour is first seen in the orchestrator's run at
 * the final head (D-30).
 *
 * The cases share one service, so their order matters: the fresh-install look first (no vault is
 * set up yet), then the cases that change the sandbox.
 */
import { browser, expect } from "@wdio/globals";
import { assertSandboxConnected } from "../src/driver.js";
import { loadRunContext } from "../src/spec-context.js";
import {
  asHealthBrowser,
  checkFreshInstall,
  openDiagnostics,
  waitForHealth,
} from "../src/spec-support/health-support.js";
import {
  type ResearchEnvironment,
  startResearchEnvironment,
} from "../src/spec-support/research-support.js";
import { asTasksBrowser, recordResults, WAIT } from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const hb = asHealthBrowser(browser);

describe("health drills", () => {
  let env: ResearchEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    // A fresh sandbox service: no managed vault, no hooks, no launcher, nothing run.
    env = await startResearchEnvironment();
  });

  after(async () => {
    await env?.stop();
  });

  it("[08-UAT#22] Fresh install: one working, five needing setup, nothing failing", async () => {
    await openDiagnostics(hb);
    // Wait for the settled look, then judge it: a timeout names the problems the page showed last.
    const read = await waitForHealth(hb, checkFreshInstall, "the fresh-install look", WAIT.connect);
    expect(checkFreshInstall(read)).toEqual([]);
  });
});
