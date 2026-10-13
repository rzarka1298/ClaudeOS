/**
 * Tasks views items of the Phase 6 UAT (05.2-07, E2E-04): all eight views with their chip
 * counts, and the independence of a project's task panel. Notes are edited only inside the
 * sandbox vault copy. Authored and CI-verified only (D-15); the live behaviour is first seen in
 * the orchestrator's baseline run (plan 05.2-09).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TASK_FILTERS } from "@ccc/domain";
import { registerProject } from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { isStrictlyInside } from "../src/plugin-data.js";
import { loadRunContext } from "../src/spec-context.js";
import { TASKS_TEXT } from "../src/spec-support/tasks-copy.js";
import {
  asTasksBrowser,
  chipCounts,
  countsMatchLists,
  emptyProjectVerdict,
  GLOBAL_ROOT,
  LIVE_CHECK_VALID_TASKS,
  localDateIn,
  MOVE_ALLOWANCE_MS,
  movedWithin,
  noteById,
  openDestination,
  openProjectPanel,
  openTasks,
  PROJECT_ROOT,
  panelIndependent,
  readEveryView,
  readGlobalTaskNotes,
  readTasks,
  recordResults,
  redateDueLine,
  runSetUpManagedVault,
  type SurfaceSnapshot,
  setProjectId,
  shiftLocalDate,
  showFilter,
  snapshotOf,
  startTasksEnvironment,
  type TasksEnvironment,
  WAIT,
  writeGlobalTaskNote,
} from "../src/spec-support/tasks-support.js";
import { LIVE_TASK_COUNT } from "../src/uat-vault.js";

const tb = asTasksBrowser(browser);

describe("tasks views", () => {
  let env: TasksEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const notes = (): ReturnType<typeof readGlobalTaskNotes> =>
    readGlobalTaskNotes(obsidianPage.getVaultPath(), env.context.runRoot);
  const today = (): string =>
    localDateIn(Intl.DateTimeFormat().resolvedOptions().timeZone, Date.now());

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startTasksEnvironment();
    await runSetUpManagedVault(tb, LIVE_TASK_COUNT + LIVE_CHECK_VALID_TASKS);
  });

  after(async () => {
    await env?.stop();
  });

  /** Rows of the Upcoming list whose notes sit in the global folder and carry a due line. */
  async function upcomingCandidates(): Promise<
    Array<{ id: string; title: string; name: string; text: string }>
  > {
    await showFilter(tb, GLOBAL_ROOT, "upcoming");
    const files = notes();
    const reading = await pollUntil(
      async () => {
        const tasks = await readTasks(tb, GLOBAL_ROOT);
        return tasks.rows.length > 0 ? tasks : null;
      },
      { ...WAIT.short, describe: "the Upcoming list to show tasks" },
    );
    const found: Array<{ id: string; title: string; name: string; text: string }> = [];
    for (const row of reading.rows) {
      const note = noteById(files, row.id);
      if (note !== undefined && /^due:/m.test(note.text)) {
        found.push({ id: row.id, title: row.title, name: note.name, text: note.text });
      }
    }
    return found;
  }

  it("[06-UAT#18] All eight views and the chip counts", async () => {
    await openTasks(tb);
    const reading = await readEveryView(tb, GLOBAL_ROOT, TASK_FILTERS);

    // The Project view lists nothing until a project is chosen (project panels are item 19),
    // so its list is compared there; here its chip must still state a count.
    expect(reading.counts["project"]).not.toBeNull();
    const without = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([view]) => view !== "project"));
    expect(countsMatchLists(without(reading.counts), without(reading.listLengths))).toEqual({
      ok: true,
    });
    for (const view of TASK_FILTERS) {
      const total = reading.showing[view];
      if (view !== "project" && total !== null && total !== undefined) {
        expect({ view, total }).toEqual({ view, total: reading.counts[view] });
      }
    }

    // A due date moved to yesterday, then to today, moves the counts without a manual refresh.
    const candidate = (await upcomingCandidates())[0];
    if (candidate === undefined) throw new Error("No Upcoming task with a due line to move.");
    const settle = async (accept: (c: Record<string, number | null>) => boolean) => {
      const started = Date.now();
      const counts = await pollUntil(
        async () => {
          const current = chipCounts(await readTasks(tb, GLOBAL_ROOT));
          return accept(current) ? current : null;
        },
        { timeoutMs: 10_000, intervalMs: 100, describe: "the chip counts to move" },
      );
      return { counts, elapsedMs: Date.now() - started };
    };

    const start = chipCounts(await readTasks(tb, GLOBAL_ROOT));
    writeGlobalTaskNote(
      obsidianPage.getVaultPath(),
      env.context.runRoot,
      candidate.name,
      redateDueLine(candidate.text, shiftLocalDate(today(), -1)),
    );
    const toOverdue = await settle((c) => c["overdue"] === (start["overdue"] ?? 0) + 1);
    expect(
      movedWithin(
        start,
        toOverdue.counts,
        { overdue: 1, upcoming: -1 },
        toOverdue.elapsedMs,
        MOVE_ALLOWANCE_MS,
      ),
    ).toBe(true);

    writeGlobalTaskNote(
      obsidianPage.getVaultPath(),
      env.context.runRoot,
      candidate.name,
      redateDueLine(candidate.text, today()),
    );
    const toToday = await settle((c) => c["today"] === (toOverdue.counts["today"] ?? 0) + 1);
    expect(
      movedWithin(
        toOverdue.counts,
        toToday.counts,
        { overdue: -1, today: 1 },
        toToday.elapsedMs,
        MOVE_ALLOWANCE_MS,
      ),
    ).toBe(true);
  });

  it("[06-UAT#19] Project panel independence", async () => {
    const { paths, runRoot } = env.context;
    const projects: Array<{ name: string; id: string }> = [];
    for (const name of ["uat-project-tasks", "uat-project-empty"]) {
      const folder = join(paths.tmpDir, name);
      if (!isStrictlyInside(runRoot, folder))
        throw new Error("Refusing a folder outside the run root.");
      mkdirSync(folder, { recursive: true });
      const registered = await registerProject(env.client, folder);
      if (registered.kind === "protected-location")
        throw new Error("The folder was refused as protected.");
      projects.push({ name, id: registered.projectId });
    }
    const [withTasks, empty] = projects;
    if (withTasks === undefined || empty === undefined) throw new Error("Projects missing.");

    // Bind two tasks to the first project by their notes; the second project stays empty.
    await openTasks(tb);
    const bound = (await upcomingCandidates()).slice(0, 2);
    expect(bound.length).toBe(2);
    for (const task of bound) {
      writeGlobalTaskNote(
        obsidianPage.getVaultPath(),
        runRoot,
        task.name,
        setProjectId(task.text, withTasks.id),
      );
    }

    // The panel lists only those tasks, with their counts.
    await openProjectPanel(tb, withTasks.name);
    const panel = await pollUntil(
      async () => {
        const reading = await readTasks(tb, PROJECT_ROOT);
        return chipCounts(reading)["all"] === 2 ? reading : null;
      },
      { ...WAIT.connect, describe: "the project panel to count its two tasks" },
    );
    expect(panel.rows.map((row) => row.title).sort()).toEqual(
      bound.map((task) => task.title).sort(),
    );
    const panelBefore = snapshotOf(panel);

    // Changing the global chip leaves the panel unchanged ...
    await openDestination(tb, TASKS_TEXT.tabTasksId);
    await pollUntil(async () => (await readTasks(tb, GLOBAL_ROOT)).mounted, {
      ...WAIT.short,
      describe: "the Tasks destination",
    });
    const globalBefore = snapshotOf(await readTasks(tb, GLOBAL_ROOT));
    await showFilter(tb, GLOBAL_ROOT, globalBefore.active === "overdue" ? "upcoming" : "overdue");
    const globalAfterReading = await readTasks(tb, GLOBAL_ROOT);
    const globalAfter = snapshotOf(globalAfterReading);
    await openProjectPanel(tb, withTasks.name);
    const panelAfter = snapshotOf(
      await pollUntil(
        async () => {
          const reading = await readTasks(tb, PROJECT_ROOT);
          return chipCounts(reading)["all"] === 2 ? reading : null;
        },
        { ...WAIT.short, describe: "the reopened project panel" },
      ),
    );
    expect(panelIndependent(globalBefore, globalAfter, panelBefore, panelAfter)).toBe(true);

    // ... and changing the panel chip leaves the global Tasks view unchanged.
    await showFilter(tb, PROJECT_ROOT, "completed");
    const panelMoved = snapshotOf(await readTasks(tb, PROJECT_ROOT));
    await openDestination(tb, TASKS_TEXT.tabTasksId);
    await pollUntil(async () => (await readTasks(tb, GLOBAL_ROOT)).mounted, {
      ...WAIT.short,
      describe: "the Tasks destination",
    });
    const globalNow: SurfaceSnapshot = snapshotOf(await readTasks(tb, GLOBAL_ROOT));
    expect(panelIndependent(panelAfter, panelMoved, globalAfter, globalNow)).toBe(true);

    // A project with no tasks shows its own empty line, not the global list.
    await showFilter(tb, GLOBAL_ROOT, "all");
    const globalRows = (await readTasks(tb, GLOBAL_ROOT)).rows.map((row) => row.id);
    await openProjectPanel(tb, empty.name);
    const emptyPanel = await pollUntil(
      async () => {
        const reading = await readTasks(tb, PROJECT_ROOT);
        return reading.emptyHeading !== null || reading.rows.length > 0 ? reading : null;
      },
      { ...WAIT.short, describe: "the empty project's list state" },
    );
    expect(
      emptyProjectVerdict({
        panelRowIds: emptyPanel.rows.map((row) => row.id),
        globalRowIds: globalRows,
        emptyHeading: emptyPanel.emptyHeading,
      }),
    ).toEqual({ ok: true });
    expect(emptyPanel.emptyHeading).toBe(TASKS_TEXT.emptyAllHeading);
  });
});
