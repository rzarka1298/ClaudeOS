/**
 * Ten-thousand-task responsiveness (05.2-07, E2E-10, Phase 6 UAT item 21). FULL PROFILE ONLY: the
 * wdio configuration lists this file for the big-vault capability alone and the standard
 * capability excludes it. The runner generates the 10,000-task vault under the run root before
 * the run (plan 05.2-09); this spec never generates a vault and uses the one it is given in
 * place. The bar is the UAT's 300 ms and is measured with a long-task observer and per-interaction
 * timings: a renderer that cannot report long tasks makes the test inconclusive, never a pass.
 * Do not lower the bar, add retries or widen a wait to make a slow run pass; a slow run is a
 * finding. Authored and CI-verified only (D-15).
 */
import { TASK_FILTERS } from "@ccc/domain";
import { browser, expect } from "@wdio/globals";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { installLongtaskObserver, readLongtasks, resetLongtasks } from "../src/renderer-spies.js";
import { loadRunContext } from "../src/spec-context.js";
import { TASKS_CLASSES, TASKS_TEXT } from "../src/spec-support/tasks-copy.js";
import {
  asTasksBrowser,
  chipCounts,
  confirmManagedVaultSetup,
  evaluateLongtasks,
  GLOBAL_ROOT,
  LONGTASK_BAR_MS,
  measureInteractions,
  openCreateForm,
  openTasks,
  readTasks,
  recordResults,
  rendererTimedClick,
  rendererTimedScroll,
  SCALE_MOCHA_TIMEOUT_MS,
  SCALE_SERVICE_WAIT_ATTEMPTS,
  startTasksEnvironment,
  submitCreateForm,
  type TasksEnvironment,
  WAIT,
  waitForChipCounts,
} from "../src/spec-support/tasks-support.js";
import { BIG_TASK_COUNT } from "../src/uat-vault.js";

const tb = asTasksBrowser(browser);

describe("tasks scale", function () {
  this.timeout(SCALE_MOCHA_TIMEOUT_MS);
  let env: TasksEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  before(async function () {
    this.timeout(SCALE_MOCHA_TIMEOUT_MS);
    const context = loadRunContext();
    // The big vault belongs to the full profile; anything else is a configuration error.
    if (context.profile !== "full") {
      throw new Error("The ten-thousand-task item runs only in the full profile.");
    }
    await assertSandboxConnected(tb, { expectedSocketPath: context.socketPath });
    // The service gets the larger socket wait: it walks a big vault before it answers.
    env = await startTasksEnvironment({ waitAttempts: SCALE_SERVICE_WAIT_ATTEMPTS });
    await openTasks(tb);
    await confirmManagedVaultSetup(tb);
    // Restart so the boot walk indexes the vault, then wait for every generated task.
    await env.restart();
    await waitForChipCounts(tb, GLOBAL_ROOT, (counts) => (counts["all"] ?? 0) >= BIG_TASK_COUNT, {
      ...WAIT.scale,
      describe: `the Tasks destination to count at least ${BIG_TASK_COUNT} tasks`,
    });
  });

  after(async () => {
    await env?.stop();
  });

  it("[06-UAT#21] Ten-thousand-task responsiveness", async function () {
    this.timeout(SCALE_MOCHA_TIMEOUT_MS);
    const installed = await tb.executeObsidian(installLongtaskObserver);
    await tb.executeObsidian(resetLongtasks);
    const timings: Array<{ label: string; ms: number }> = [];

    const timed = async (label: string, selector: string, text: string | null) => {
      const result = await tb.executeObsidian(rendererTimedClick, selector, text);
      if (!result.clicked) throw new Error(`Nothing to press for: ${label}`);
      timings.push({ label, ms: result.ms });
    };

    // Switch every chip, scroll the list.
    for (const filter of TASK_FILTERS) {
      await timed(
        `chip ${filter}`,
        `${GLOBAL_ROOT} button.${TASKS_CLASSES.filterChip}[data-filter="${filter}"]`,
        null,
      );
      await pollUntil(
        async () =>
          (await readTasks(tb, GLOBAL_ROOT)).chips.some((c) => c.filter === filter && c.pressed),
        { ...WAIT.short, describe: `the ${filter} chip to be pressed` },
      );
    }
    await timed(
      "chip all",
      `${GLOBAL_ROOT} button.${TASKS_CLASSES.filterChip}[data-filter="all"]`,
      null,
    );
    await pollUntil(async () => (await readTasks(tb, GLOBAL_ROOT)).rows.length > 0, {
      ...WAIT.short,
      describe: "the All list to render",
    });
    const scrolled = await tb.executeObsidian(
      rendererTimedScroll,
      `${GLOBAL_ROOT} li.${TASKS_CLASSES.taskRow}`,
    );
    if (!scrolled.scrolled) throw new Error("Nothing to scroll in the list.");
    timings.push({ label: "scroll the list", ms: scrolled.ms });

    // Create one task and change one task's status.
    const title = `Runner scale task ${env.context.runId}`;
    const form = await openCreateForm(tb);
    const submitStart = Date.now();
    await submitCreateForm(tb, form, title, "inbox");
    await pollUntil(async () => (await readTasks(tb, GLOBAL_ROOT)).status.includes(title), {
      ...WAIT.short,
      describe: "the create confirmation",
    });
    timings.push({ label: "create a task (to confirmation)", ms: Date.now() - submitStart });
    await timed(
      "change a status (Mark done)",
      `${GLOBAL_ROOT} li.${TASKS_CLASSES.taskRow} button.${TASKS_CLASSES.taskAction}[data-action="mark-done"]`,
      null,
    );
    await pollUntil(async () => (await readTasks(tb, GLOBAL_ROOT)).status !== "", {
      ...WAIT.short,
      describe: "the status change to be announced",
    });

    // Judge: long tasks first, then the per-interaction timings, against the same bar.
    const reading = await tb.executeObsidian(readLongtasks);
    const longtasks = evaluateLongtasks(reading, LONGTASK_BAR_MS);
    if (longtasks.verdict === "inconclusive") {
      console.log(`[06-UAT#21] inconclusive: ${longtasks.reason}`);
      this.skip();
    }
    expect(longtasks).toEqual({ verdict: "pass" });
    const interactions = measureInteractions(timings, LONGTASK_BAR_MS);
    expect(interactions).toMatchObject({ ok: true });
    expect(installed).toBe(true);
    console.log(
      `[06-UAT#21] slowest interaction: ${interactions.slowest}; chips: ${JSON.stringify(chipCounts(await readTasks(tb, GLOBAL_ROOT)))} ${TASKS_TEXT.chipAll}`,
    );
  });
});
