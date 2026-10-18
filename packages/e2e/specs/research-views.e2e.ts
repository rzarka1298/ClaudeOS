/**
 * View items of the Phase 7 UAT (plan 07-17, D-28, RSRCH-10, D-24, A11Y, UI-SPEC R4): a long
 * report as an article, the side-pane and full-width layouts, the keyboard, reduced motion, the
 * four open actions, and the unchanged Overview, with the automated part of the owner's
 * reading-quality item. The long report is the REAL pipeline's largest extractive report (12
 * sources, 24 findings) from the fixture directory; no network, no model, no key. Look items
 * record images into the run's private shots folder. Authored and CI-verified only (D-15).
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { Key } from "webdriverio";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { scenarioSources } from "../src/research-uat-fixture.js";
import { loadRunContext } from "../src/spec-context.js";
import { APPROVALS_COPY } from "../src/spec-support/approvals-copy.js";
import {
  contrastFailures,
  lowestRatios,
  readContrastInBothThemes,
} from "../src/spec-support/contrast-probe.js";
import { recordLookPending, sampleMotionInRenderer } from "../src/spec-support/cross-support.js";
import { RESEARCH_CLASSES, RESEARCH_TEXT } from "../src/spec-support/research-copy.js";
import {
  type ResearchFocus,
  rendererClickByText,
  rendererClickInSource,
  rendererClickNth,
  rendererInstallSpies,
  rendererReadCards,
  rendererReadFocus,
  rendererReadScrollBehaviour,
  rendererReadSpies,
} from "../src/spec-support/research-dom.js";
import { scalarOf } from "../src/spec-support/research-notes.js";
import {
  captureLook,
  rememberLayout,
  type ShotBrowser,
  withEnlargedLayout,
} from "../src/spec-support/research-shots.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  closeNotes,
  focusRunNow,
  openReport,
  openResearch,
  type ResearchEnvironment,
  readArticle,
  readLayout,
  readResearch,
  readSourcesPage,
  readVaultNotes,
  runScenario,
  setReducedMotion,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
  waitForNoteOpen,
} from "../src/spec-support/research-support.js";
import {
  checkArticleFacts,
  checkCitationRoundTrip,
  checkEscapeToRow,
  checkLayouts,
  checkMotion,
  checkOverviewCards,
  checkTabOrder,
} from "../src/spec-support/research-verdicts.js";
import { restoreLayout } from "../src/spec-support/shot-layout.js";
import {
  asTasksBrowser,
  recordResults,
  rendererClick,
  runSetUpManagedVault,
} from "../src/spec-support/tasks-support.js";
import { decideWideLayout, describeFit } from "../src/spec-support/window-fit.js";

const rb = asResearchBrowser(browser);
const tb = asTasksBrowser(browser);
const sb = browser as unknown as ShotBrowser;

const VIEW_TYPE = APPROVALS_COPY.commandCenterViewType;
const FINDINGS = 24;
const SOURCES = 12;
const READER = `article.${RESEARCH_CLASSES.reader}`;
/** The width of a narrow side pane in px, below the 48rem the layout stacks at. */
const NARROW_PANE_PX = 320;
/** Elements of the research view and the shell that carry a transition (styles.css motion tokens). */
const MOTION_SELECTORS = [
  `.${RESEARCH_CLASSES.runButton}`,
  `.${RESEARCH_CLASSES.rowButton}`,
  `.${RESEARCH_CLASSES.badge}`,
  ".ccc-nav-item",
  ".ccc-nav-count",
  ".ccc-filter-chip",
  ".ccc-card",
];

describe("research views", () => {
  let env: ResearchEnvironment;
  /** The long report's run, made once and opened by the items that read it. */
  let longRunId: string | undefined;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const vaultPath = () => obsidianPage.getVaultPath();
  const vaultNotes = () => readVaultNotes(vaultPath(), env.context.runRoot);

  async function ensureLongReport(): Promise<string> {
    if (longRunId !== undefined) return longRunId;
    const run = await runScenario(rb, env, "long");
    expect(run.ok).toBe(true);
    longRunId = run.runId;
    return run.runId;
  }

  /** Opens Research with the long report in the reader. */
  async function openLongReport() {
    await ensureLongReport();
    await openResearch(rb);
    return openReport(rb, 0, { items: FINDINGS, sources: SOURCES });
  }

  /**
   * Opens the long report again. A shot taken in the main area runs in a new command center view,
   * and the sidebar view is new again after the layout goes back, so each starts on the Overview.
   */
  const reopenReport = async (): Promise<void> => {
    await openLongReport();
  };

  /** Presses Tab and reads where focus landed. */
  async function tab(): Promise<ResearchFocus | null> {
    await browser.keys(Key.Tab);
    return browser.execute(rendererReadFocus, RESEARCH_CLASSES.reader, RESEARCH_CLASSES.row);
  }

  const focusNow = (): Promise<ResearchFocus | null> =>
    browser.execute(rendererReadFocus, RESEARCH_CLASSES.reader, RESEARCH_CLASSES.row);

  /** Tabs from Run now until `reached` is true of the focus, at most `limit` presses. */
  async function tabUntil(
    reached: (focus: ResearchFocus) => boolean,
    records: ResearchFocus[],
    limit = 260,
  ): Promise<ResearchFocus> {
    for (let press = 0; press < limit; press += 1) {
      const focus = await tab();
      if (focus === null) continue;
      records.push(focus);
      if (reached(focus)) return focus;
    }
    const seen = records
      .slice(-12)
      .map((entry) => `${entry.tag}:${entry.name}`)
      .join(" | ");
    throw new Error(`Keyboard focus never reached the expected control; it last visited: ${seen}`);
  }

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
    clearResearchNotes(vaultPath(), env.context.runRoot);
  });

  after(async () => {
    await env?.stop();
  });

  it("[07-UAT#15] A long report reads as an article", async () => {
    await openLongReport();
    const subject = { selector: READER, block: "start" } as const;
    // Side pane: the command center as it sits in the right sidebar, in a window at the display's size.
    expect(checkArticleFacts(await readArticle(rb), { findings: FINDINGS })).toEqual([]);
    const labels = [
      await captureLook(sb, {
        shotsDir: env.context.shotsDir,
        item: 15,
        label: "side-pane",
        subject,
        viewType: VIEW_TYPE,
        placement: "window",
      }),
    ];
    // Full width: a main-area tab in a window at the display's size, both sidebars collapsed.
    await withEnlargedLayout(
      sb,
      VIEW_TYPE,
      async () => {
        expect(checkArticleFacts(await readArticle(rb), { findings: FINDINGS })).toEqual([]);
        labels.push(
          await captureLook(sb, {
            shotsDir: env.context.shotsDir,
            item: 15,
            label: "full-width",
            subject,
            viewType: VIEW_TYPE,
            placement: "as-is",
          }),
        );
      },
      { reopen: reopenReport },
    );
    recordLookPending({ runRoot: env.context.runRoot, item: 15, labels });
  });

  it("[07-UAT#16] Side pane and full-width layouts", async function layouts() {
    await openLongReport();
    const original = await rememberLayout(sb, VIEW_TYPE);
    const labels: string[] = [];
    try {
      const wide = await withEnlargedLayout(
        sb,
        VIEW_TYPE,
        async ({ fit }) => {
          await pollUntil(async () => (await readLayout(rb)).mode === "side" || null, {
            timeoutMs: 10_000,
            intervalMs: 250,
            describe: `the layout to measure side by side (${describeFit(fit)})`,
          }).catch(() => undefined);
          labels.push(
            await captureLook(sb, {
              shotsDir: env.context.shotsDir,
              item: 16,
              label: "full-width",
              subject: { selector: `.${RESEARCH_CLASSES.layout}`, block: "start" },
              viewType: VIEW_TYPE,
              placement: "as-is",
            }),
          );
          return { layout: await readLayout(rb), fit };
        },
        { reopen: reopenReport },
      );
      // The window took the display's size and the view the whole main area, so a layout that is
      // still not side by side is a fault, not a reason to skip. The one skip left is a screen
      // that is itself narrower than the breakpoint, and it says so.
      const verdict = decideWideLayout({
        gridWidth: wide.layout.gridWidth,
        breakpointPx: 48 * wide.layout.rootFontPx,
        workAreaWidth: wide.fit.workArea?.width ?? null,
        windowFilled: wide.fit.filled,
      });
      if (wide.layout.found && verdict.kind === "skip") {
        console.warn(`[07-UAT#16] skipped: ${verdict.reason}`);
        this.skip();
      }
      if (wide.layout.found && verdict.kind === "fail") {
        throw new Error(`${verdict.reason} (${describeFit(wide.fit)})`);
      }
      await browser.execute(restoreLayout, {
        ...original,
        leftCollapsed: false,
        rightCollapsed: false,
        rightWidth: NARROW_PANE_PX,
        centerInRight: true,
      });
      await pollUntil(async () => (await readLayout(rb)).mode === "stacked" || null, {
        timeoutMs: 15_000,
        intervalMs: 250,
        describe: "the layout to stack in a narrow pane",
      });
      labels.push(
        await captureLook(sb, {
          shotsDir: env.context.shotsDir,
          item: 16,
          label: "narrow-pane",
          subject: { selector: `.${RESEARCH_CLASSES.layout}`, block: "start" },
          viewType: VIEW_TYPE,
          placement: "window",
        }),
      );
      const narrow = await readLayout(rb);
      expect(checkLayouts({ wide: wide.layout, narrow })).toEqual([]);
    } finally {
      await browser.execute(restoreLayout, original);
    }
    recordLookPending({ runRoot: env.context.runRoot, item: 16, labels });
  });

  it("[07-UAT#17] Keyboard and focus through the reader", async () => {
    await openLongReport();
    const original = await rememberLayout(sb, VIEW_TYPE);
    try {
      // Full width, so the list and the reader are both in the tab order.
      await withEnlargedLayout(
        sb,
        VIEW_TYPE,
        async ({ fit }) => {
          await pollUntil(async () => (await readLayout(rb)).mode === "side" || null, {
            timeoutMs: 10_000,
            intervalMs: 250,
            describe: `the layout to measure side by side (${describeFit(fit)})`,
          });
          expect(await focusRunNow(rb)).toBe(true);
          const walk: ResearchFocus[] = [];
          const first = await focusNow();
          if (first !== null) walk.push(first);
          await tabUntil(
            (focus) => focus.inReader && focus.name === RESEARCH_TEXT.openRunNoteLabel,
            walk,
          );
          expect(
            checkTabOrder(walk, {
              sourcesCount: scenarioSources("long").length,
              skipRingOnFirst: true,
            }),
          ).toEqual([]);

          // A citation moves focus to its source, and Back to finding returns it.
          expect(await focusRunNow(rb)).toBe(true);
          const toCitation: ResearchFocus[] = [];
          const cite = await tabUntil((focus) => focus.cite !== null, toCitation);
          await browser.keys(Key.Enter);
          const source = await pollUntil(
            async () => {
              const found = await focusNow();
              return found?.tag === "h5" ? found : null;
            },
            { timeoutMs: 10_000, intervalMs: 250, describe: "focus to move to the cited source" },
          );
          const next = await tab();
          await browser.keys(Key.Enter);
          const returned = await focusNow();
          expect(checkCitationRoundTrip({ cite, source, next, returned })).toEqual([]);
        },
        { reopen: reopenReport },
      );

      // One column: Escape closes the reader and returns focus to the row it came from.
      await browser.execute(restoreLayout, {
        ...original,
        leftCollapsed: false,
        rightCollapsed: false,
        rightWidth: NARROW_PANE_PX,
        centerInRight: true,
      });
      await pollUntil(async () => (await readLayout(rb)).mode === "stacked" || null, {
        timeoutMs: 15_000,
        intervalMs: 250,
        describe: "the layout to stack in a narrow pane",
      });
      await openReport(rb, 0, { items: FINDINGS, sources: SOURCES });
      const inside = await browser.execute((readerSelector: string) => {
        const target = document.querySelector(`${readerSelector} button`) as HTMLElement | null;
        target?.focus();
        return document.activeElement === target && target !== null;
      }, READER);
      expect(inside).toBe(true);
      await browser.keys(Key.Escape);
      const closed = await pollUntil(
        async () => ((await readResearch(rb)).reader === null ? true : null),
        { timeoutMs: 10_000, intervalMs: 250, describe: "Escape to close the reader" },
      );
      expect(checkEscapeToRow({ readerClosed: closed, focus: await focusNow() })).toEqual([]);
    } finally {
      await browser.execute(restoreLayout, original);
    }
  });

  it("[07-UAT#18] Reduced motion", async function reducedMotion() {
    try {
      await setReducedMotion(obsidianPage, "auto");
      await openLongReport();
      const baseline = await browser.execute(sampleMotionInRenderer, MOTION_SELECTORS);
      if (baseline.rootMotion === "reduced") {
        // The macOS Reduce motion preference is already on: no full-motion baseline can be taken.
        this.skip();
      }

      await setReducedMotion(obsidianPage, "reduced");
      await openLongReport();
      await browser.execute(rendererInstallSpies);
      const citation = (await readResearch(rb)).reader?.findings[0]?.citations[0]?.cite;
      if (citation === undefined) throw new Error("The first finding cites no source.");
      expect(await browser.execute(rendererClickNth, `[data-cite="${citation}"]`, 0)).toBe(true);
      await pollUntil(
        async () => {
          const focus = await focusNow();
          return focus?.tag === "h5" ? focus : null;
        },
        { timeoutMs: 10_000, intervalMs: 250, describe: "focus to move to the cited source" },
      );
      const reduced = await browser.execute(sampleMotionInRenderer, MOTION_SELECTORS);
      const spies = await browser.execute(rendererReadSpies);
      const behaviours = await browser.execute(
        rendererReadScrollBehaviour,
        `li.${RESEARCH_CLASSES.source} h5`,
      );
      expect(
        checkMotion({
          baseline: baseline.samples,
          reduced: reduced.samples,
          reducedRoot: reduced.rootMotion,
          scrolls: spies.scrolls,
          scrollBehaviours: behaviours,
        }),
      ).toEqual([]);
    } finally {
      await setReducedMotion(obsidianPage, "auto");
    }
  });

  it("[07-UAT#19] Open note, Open snapshot, Open run note and Copy address", async () => {
    const runId = await ensureLongReport();
    await openResearch(rb);
    await openReport(rb, 0, { items: FINDINGS, sources: SOURCES });
    const report = vaultNotes().output.find((note) => scalarOf(note.text, "jobRunId") === runId);
    if (report === undefined) throw new Error("The long run left no report note.");
    const reportId = scalarOf(report.text, "id") ?? "";
    const first = (await readSourcesPage(env.research, reportId)).sources[0];
    if (first === undefined) throw new Error("The report has no source.");
    await browser.execute(rendererInstallSpies);

    // Copy address puts the canonical address on the clipboard; no address is a link.
    expect(await browser.execute(rendererClickInSource, "1", RESEARCH_TEXT.copyAddressLabel)).toBe(
      true,
    );
    await pollUntil(
      async () =>
        (await browser.execute(rendererReadSpies)).clipboard.at(-1) === first.canonicalUrl,
      { timeoutMs: 10_000, intervalMs: 100, describe: "the address on the clipboard" },
    );
    const copied = await readResearch(rb);
    expect(copied.status).toBe(RESEARCH_TEXT.addressCopied);
    expect(copied.reader?.activeElements).toBe(0);

    // Open note, Open snapshot and Open run note each open their note.
    await closeNotes(rb);
    expect(
      await browser.execute(
        rendererClickByText,
        `.${RESEARCH_CLASSES.readerActions} button`,
        RESEARCH_TEXT.openNoteLabel,
      ),
    ).toBe(true);
    await waitForNoteOpen(rb, report.path);
    await closeNotes(rb);
    expect(await browser.execute(rendererClickInSource, "1", RESEARCH_TEXT.openSnapshotLabel)).toBe(
      true,
    );
    await waitForNoteOpen(rb, first.snapshotPath);
    await closeNotes(rb);
    expect(
      await browser.execute(
        rendererClickByText,
        `.${RESEARCH_CLASSES.readerRun} button`,
        RESEARCH_TEXT.openRunNoteLabel,
      ),
    ).toBe(true);
    await waitForNoteOpen(rb, `automation-runs/${runId}.md`);
  });

  it("[07-UAT#20] The Overview is unchanged", async () => {
    await ensureLongReport();
    await browser.executeObsidian(
      rendererClick,
      `#${RESEARCH_CLASSES.tabPrefix}${RESEARCH_TEXT.overviewTabId}`,
      null,
    );
    const cards = await pollUntil(
      async () => {
        const found = await browser.execute(rendererReadCards, RESEARCH_CLASSES.card);
        return found.some((card) => card.title === RESEARCH_TEXT.todayTitle) ? found : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, describe: "the Overview cards" },
    );
    expect(checkOverviewCards(cards)).toEqual([]);
  });

  it("[07-UAT#23] The live report reads comfortably (the reading container's measure, leading and spacing)", async () => {
    // The automated part of the owner's reading-quality item: the container's computed styles
    // against the UI-SPEC article table, in the side pane and at full width. Whether it reads as
    // an article rather than a dashboard stays the owner's judgement.
    await openLongReport();
    expect(checkArticleFacts(await readArticle(rb), { findings: FINDINGS })).toEqual([]);
    await withEnlargedLayout(
      sb,
      VIEW_TYPE,
      async () => {
        expect(checkArticleFacts(await readArticle(rb), { findings: FINDINGS })).toEqual([]);
        // The same reader, the tab strip and every button and chip in it, measured in the real
        // window under BOTH Obsidian base themes: Obsidian's own control rules once left the
        // active tab label at 1.15:1 and the pills under 3:1 in the light theme (trial run
        // da14049b). Text needs 4.5:1 (3:1 large), a form edge 3:1.
        const readings = await readContrastInBothThemes(sb, ".ccc-command-center");
        for (const reading of readings) {
          console.log(
            `[07-UAT#23] ${reading.base} lowest:\n  ${lowestRatios(reading.measured).join("\n  ")}`,
          );
          expect(reading.problems.map((line) => `${reading.base}: ${line}`)).toEqual([]);
          const unmeasured = ["research", "open note", "cached", "source"].filter(
            (wanted) => !reading.texts.some((text) => text.toLowerCase().includes(wanted)),
          );
          expect(
            unmeasured.map((wanted) => `${reading.base}: "${wanted}" was not measured`),
          ).toEqual([]);
          expect(
            contrastFailures(reading.measured).map((line) => `${reading.base}: ${line}`),
          ).toEqual([]);
        }
      },
      { reopen: reopenReport },
    );
  });
});
