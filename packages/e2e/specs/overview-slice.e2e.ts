/**
 * The Overview slice of the Phase 8 UAT (plan 08-19, SLICE-01, D-19 to D-23, D-27): a registered
 * project with its launch control, a synthetic Claude session, a managed task of the fixture
 * vault and the latest cited research report, read on one Overview screen with their source and
 * freshness. Everything runs inside the run's sandbox: its own runtime folder and service, a
 * project folder in the run root, a sacrificial child standing in for the Claude process, the
 * 300-task fixture vault and the Phase 7 extractive research fixture. No network, no model, and
 * nothing of the owner's runtime, store, vaults or Keychain; the service gets the sandbox
 * research-key account through `startResearchEnvironment`. Authored and CI-verified only (D-15);
 * the live behaviour is first seen in the orchestrator's run at the final head (D-30).
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected } from "../src/driver.js";
import { loadRunContext } from "../src/spec-context.js";
import {
  asOverviewBrowser,
  checkSliceCards,
  reopenOverview,
  type SliceSeed,
  seedSlice,
  sliceSeedDeps,
  waitForSlice,
} from "../src/spec-support/overview-support.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  type ResearchEnvironment,
  runScenario,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
} from "../src/spec-support/research-support.js";
import {
  reapSacrificialChildren,
  type SacrificialChild,
} from "../src/spec-support/synthetic-session.js";
import {
  asTasksBrowser,
  recordResults,
  runSetUpManagedVault,
} from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const rb = asResearchBrowser(browser);
const ob = asOverviewBrowser(browser);

describe("overview slice", () => {
  let env: ResearchEnvironment;
  /** The sacrificial children standing in for Claude processes; reaped in `after`. */
  const registry: SacrificialChild[] = [];
  let seed: SliceSeed | undefined;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
    clearResearchNotes(obsidianPage.getVaultPath(), env.context.runRoot);
  });

  after(async () => {
    await reapSacrificialChildren(registry);
    await env?.stop();
  });

  /** Registers the sandbox project and starts the synthetic session once; later cases reuse them. */
  async function ensureSeed(): Promise<SliceSeed> {
    if (seed === undefined) {
      seed = await seedSlice(sliceSeedDeps(env.context, env.client, registry));
    }
    return seed;
  }

  /** Makes sure one cited fixture report exists, running the extractive fixture scenario if not. */
  async function ensureReport(): Promise<void> {
    const list = await env.research.list({ limit: 1 });
    if (list.rows.some((row) => row.readable)) return;
    const run = await runScenario(rb, env, "base");
    expect(run.ok).toBe(true);
  }

  it("[08-UAT#01] The Overview shows the slice on fixture sources", async () => {
    const planted = await ensureSeed();
    await ensureReport();
    await reopenOverview(ob);
    // The session reaches the Overview by event and the report by the remount's fetch; wait for
    // all five parts to be on the screen, then judge them (a timeout names what was missing).
    const cards = await waitForSlice(ob, planted);
    expect(checkSliceCards(cards, planted)).toEqual([]);
  });
});
