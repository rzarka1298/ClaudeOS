/**
 * Tasks core items of the Phase 6 UAT (05.2-07, E2E-04): create a task with both submits, the
 * Properties-style date and a status change, a copy of a task note, and proposed tasks. Every
 * note-level assertion reads the raw bytes of the sandbox vault copy; nothing outside it is
 * touched. Authored and CI-verified only (D-15): the live behaviour is first seen in the
 * orchestrator's baseline run (plan 05.2-09).
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { loadRunContext } from "../src/spec-context.js";
import { TASKS_TEXT } from "../src/spec-support/tasks-copy.js";
import {
  asTasksBrowser,
  checkCreatedNote,
  clickChip,
  GLOBAL_ROOT,
  LIVE_CHECK_VALID_TASKS,
  notesForTitle,
  openCreateForm,
  readGlobalTaskNotes,
  readTasks,
  recordResults,
  runSetUpManagedVault,
  startTasksEnvironment,
  submitCreateForm,
  type TasksEnvironment,
  WAIT,
} from "../src/spec-support/tasks-support.js";
import { LIVE_TASK_COUNT } from "../src/uat-vault.js";

const tb = asTasksBrowser(browser);

describe("tasks core", () => {
  let env: TasksEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  before(async () => {
    // The sandbox is asserted before anything else happens in this file.
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startTasksEnvironment();
    await runSetUpManagedVault(tb, LIVE_TASK_COUNT + LIVE_CHECK_VALID_TASKS);
  });

  after(async () => {
    await env?.stop();
  });

  it("[06-UAT#14] Create a task with Add to inbox and with Add as ready", async () => {
    const tag = env.context.runId;
    const created = [
      { title: `Runner inbox task ${tag}`, intent: "inbox" as const },
      { title: `Runner ready task ${tag}`, intent: "ready" as const },
    ];
    const form = await openCreateForm(tb);
    for (const item of created) {
      await submitCreateForm(tb, form, item.title, item.intent);
      // The success line points to All: the new task appears there straight away.
      await clickChip(tb, GLOBAL_ROOT, "all");
      await pollUntil(
        async () => (await readTasks(tb, GLOBAL_ROOT)).rows.some((row) => row.title === item.title),
        { ...WAIT.short, describe: `"${item.title}" to appear in the ${TASKS_TEXT.chipAll} list` },
      );
    }

    const vaultPath = obsidianPage.getVaultPath();
    for (const item of created) {
      const note = await pollUntil(
        () => notesForTitle(readGlobalTaskNotes(vaultPath, env.context.runRoot), item.title)[0],
        { ...WAIT.short, describe: `the note file of "${item.title}"` },
      );
      const verdict = checkCreatedNote(note.text, note.name, {
        status: item.intent,
        title: item.title,
      });
      expect(verdict).toEqual({ ok: true });
    }
  });
});
