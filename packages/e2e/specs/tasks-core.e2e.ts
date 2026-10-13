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
import {
  LIVE_CHECK_TITLES,
  SYNTHETIC_LINK_HOST,
  TASKS_TEXT,
} from "../src/spec-support/tasks-copy.js";
import {
  asTasksBrowser,
  checkCreatedNote,
  checkStatusChangeDiff,
  classifyDuplicateAttention,
  clickChip,
  duePropertyVerdict,
  GLOBAL_ROOT,
  inspectUntrustedRender,
  LIVE_CHECK_VALID_TASKS,
  loadRowsFor,
  localDateIn,
  noteById,
  notesForTitle,
  notInEitherList,
  openCreateForm,
  openTasks,
  parseNoteFrontmatter,
  pressDetailAction,
  pressRowAction,
  readDecisionOutcome,
  readDueProperty,
  readGlobalTaskNotes,
  readTasks,
  recordResults,
  redateDueLine,
  rendererVaultOp,
  rowByTitle,
  runSetUpManagedVault,
  selectRow,
  showFilter,
  startTasksEnvironment,
  submitCreateForm,
  type TasksEnvironment,
  untrustedRenderVerdict,
  WAIT,
  writeGlobalTaskNote,
} from "../src/spec-support/tasks-support.js";
import { LIVE_TASK_COUNT } from "../src/uat-vault.js";

const tb = asTasksBrowser(browser);

describe("tasks core", () => {
  let env: TasksEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const notes = (): ReturnType<typeof readGlobalTaskNotes> =>
    readGlobalTaskNotes(obsidianPage.getVaultPath(), env.context.runRoot);

  /** Polls the vault copy until the note of `id` satisfies `accept`; returns its text. */
  async function waitForNote(
    id: string,
    accept: (text: string) => boolean,
    describe: string,
  ): Promise<string> {
    const found = await pollUntil(
      () => {
        const note = noteById(notes(), id);
        return note !== undefined && accept(note.text) ? note : null;
      },
      { ...WAIT.short, describe },
    );
    return found.text;
  }

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

    for (const item of created) {
      const note = await pollUntil(() => notesForTitle(notes(), item.title)[0], {
        ...WAIT.short,
        describe: `the note file of "${item.title}"`,
      });
      const verdict = checkCreatedNote(note.text, note.name, {
        status: item.intent,
        title: item.title,
      });
      expect(verdict).toEqual({ ok: true });
    }
  });

  it("[06-UAT#15] Properties-style date and a status change by the plugin", async () => {
    const title = LIVE_CHECK_TITLES.propertiesDate;
    const found = notesForTitle(notes(), title);
    expect(found.length).toBe(1);
    const original = found[0];
    if (original === undefined) throw new Error("The live-check dated note is missing.");

    // The fixture vault is generated against a fixed clock, so re-date the note to the
    // machine's today, as an unquoted date line, directly in the sandbox copy.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = localDateIn(zone, Date.now());
    writeGlobalTaskNote(
      obsidianPage.getVaultPath(),
      env.context.runRoot,
      original.name,
      redateDueLine(original.text, today),
    );

    // Obsidian's own Properties view shows due as a date with no time.
    await obsidianPage.openFile(original.path);
    const property = await readDueProperty(tb);
    expect(duePropertyVerdict(property)).toEqual({ ok: true });

    // In Tasks it appears under Today as an all-day item.
    await openTasks(tb);
    await showFilter(tb, GLOBAL_ROOT, "today");
    const row = await pollUntil(
      async () => {
        const candidate = rowByTitle(await readTasks(tb, GLOBAL_ROOT), title);
        return candidate?.datePhrase === TASKS_TEXT.dueToday ? candidate : null;
      },
      { ...WAIT.short, describe: `"${title}" under Today as an all-day item` },
    );

    const before = notes().find((note) => note.name === original.name)?.text ?? "";
    await selectRow(tb, GLOBAL_ROOT, row.id);
    await pressDetailAction(tb, GLOBAL_ROOT, TASKS_TEXT.markDone);
    const after = await waitForNote(
      row.id,
      (text) => parseNoteFrontmatter(text).ok && text.includes(`status: ${TASKS_TEXT.statusDone}`),
      "the note to show the done status",
    );
    expect(checkStatusChangeDiff(before, after, { expectStatus: TASKS_TEXT.statusDone })).toEqual({
      ok: true,
    });
  });

  it("[06-UAT#16] Make a copy of a task note", async () => {
    await openTasks(tb);
    await showFilter(tb, GLOBAL_ROOT, "upcoming");
    const files = notes();
    const listed = await pollUntil(
      async () => {
        const tasks = await readTasks(tb, GLOBAL_ROOT);
        return tasks.rows.some((row) => noteById(files, row.id) !== undefined) ? tasks : null;
      },
      { ...WAIT.short, describe: "an Upcoming task whose note is in the global folder" },
    );
    const target = listed.rows.find((row) => noteById(files, row.id) !== undefined);
    const original = target === undefined ? undefined : noteById(files, target.id);
    if (target === undefined || original === undefined) throw new Error("No task to copy.");

    const copyName = original.name.replace(/\.md$/, " 1.md");
    const copyPath = original.path.replace(/[^/]+$/, copyName);
    expect(await tb.executeObsidian(rendererVaultOp, "copy", original.path, copyPath)).toBe("ok");

    // Both notes land under Notes need attention (duplicate id) and no list counts them.
    const names = new Set([original.name, copyName]);
    const held = (attention: { path: string }[]): { path: string; title: string }[] =>
      attention.filter((item) => [...names].some((name) => item.path.endsWith(`/${name}`))) as {
        path: string;
        title: string;
      }[];
    const attention = await pollUntil(
      async () => {
        const rows = held((await readTasks(tb, GLOBAL_ROOT)).attention);
        return rows.length >= 2 ? rows : null;
      },
      {
        ...WAIT.short,
        describe: `both copies of "${target.title}" under ${TASKS_TEXT.attentionHeading}`,
      },
    );
    const attentionTitles = attention.map(() => target.title);
    const lists: Record<string, string[]> = {};
    for (const filter of ["today", "upcoming"]) {
      await showFilter(tb, GLOBAL_ROOT, filter);
      lists[filter] = (await readTasks(tb, GLOBAL_ROOT)).rows.map((row) => row.title);
    }
    expect(notInEitherList(lists["today"] ?? [], lists["upcoming"] ?? [], target.title)).toBe(true);
    expect(classifyDuplicateAttention(attentionTitles, target.title, [])).toBe(true);

    // Delete the copy: the attention list clears and the task returns.
    expect(await tb.executeObsidian(rendererVaultOp, "delete", copyPath, "")).toBe("ok");
    const returned = async (): Promise<boolean> => {
      const tasks = await readTasks(tb, GLOBAL_ROOT);
      return held(tasks.attention).length === 0;
    };
    let rebuilt = false;
    try {
      await pollUntil(returned, {
        timeoutMs: 8_000,
        intervalMs: 500,
        describe: "the attention list to clear",
      });
    } catch {
      // The same service route the Rebuild task index setting calls.
      rebuilt = true;
      await env.tasks.rebuild();
      await pollUntil(returned, {
        ...WAIT.short,
        describe: "the attention list to clear after Rebuild task index",
      });
    }
    if (rebuilt) console.log("[06-UAT#16] the attention list needed Rebuild task index to clear");
    await showFilter(tb, GLOBAL_ROOT, "upcoming");
    await pollUntil(
      async () => rowByTitle(await readTasks(tb, GLOBAL_ROOT), target.title) !== undefined,
      { ...WAIT.short, describe: `"${target.title}" to return to Upcoming` },
    );
  });

  it("[06-UAT#17] Proposed tasks: accept and dismiss", async () => {
    const titles = {
      plain: LIVE_CHECK_TITLES.proposedPlain,
      hostile: LIVE_CHECK_TITLES.hostile,
      source: LIVE_CHECK_TITLES.proposedWithSource,
    };
    await openTasks(tb);
    await showFilter(tb, GLOBAL_ROOT, "proposed");
    const listed = await loadRowsFor(tb, GLOBAL_ROOT, Object.values(titles));
    for (const title of Object.values(titles)) {
      expect(rowByTitle(listed, title)).toBeDefined();
    }

    // The hostile title and the source link render as plain text.
    const hostileRow = rowByTitle(listed, titles.hostile);
    const sourceRow = rowByTitle(listed, titles.source);
    if (hostileRow === undefined || sourceRow === undefined) throw new Error("Rows missing.");
    expect(
      untrustedRenderVerdict(
        await tb.executeObsidian(inspectUntrustedRender, GLOBAL_ROOT, titles.hostile, ""),
      ),
    ).toEqual({ ok: true });
    await selectRow(tb, GLOBAL_ROOT, sourceRow.id);
    const linkText = LIVE_CHECK_TITLES.sourceLink;
    expect(linkText).toContain(SYNTHETIC_LINK_HOST);
    await pollUntil(
      async () => {
        const counts = await tb.executeObsidian(
          inspectUntrustedRender,
          GLOBAL_ROOT,
          titles.source,
          linkText,
        );
        return (counts.linkTextElements ?? 0) > 0 ? counts : null;
      },
      { ...WAIT.short, describe: "the source link to be shown in the detail pane" },
    );
    expect(
      untrustedRenderVerdict(
        await tb.executeObsidian(inspectUntrustedRender, GLOBAL_ROOT, titles.source, linkText),
        { requireLinkText: true },
      ),
    ).toEqual({ ok: true });

    // Accept one and dismiss another; each note records the decision.
    const plainRow = rowByTitle(listed, titles.plain);
    if (plainRow === undefined) throw new Error("The plain proposed row is missing.");
    await pressRowAction(tb, GLOBAL_ROOT, plainRow.id, TASKS_TEXT.rowActionAccept);
    const accepted = await waitForNote(
      plainRow.id,
      (text) => readDecisionOutcome(text) === TASKS_TEXT.decisionAccepted,
      "the accepted decision in the note",
    );
    expect(parseNoteFrontmatter(accepted)).toMatchObject({
      ok: true,
      map: { status: TASKS_TEXT.statusReady },
    });

    await pressRowAction(tb, GLOBAL_ROOT, sourceRow.id, TASKS_TEXT.rowActionDismiss);
    const dismissed = await waitForNote(
      sourceRow.id,
      (text) => readDecisionOutcome(text) === TASKS_TEXT.decisionDismissed,
      "the dismissed decision in the note",
    );
    expect(parseNoteFrontmatter(dismissed)).toMatchObject({
      ok: true,
      map: { status: TASKS_TEXT.statusCancelled },
    });
    expect(noteById(notes(), sourceRow.id)).toBeDefined();
  });
});
