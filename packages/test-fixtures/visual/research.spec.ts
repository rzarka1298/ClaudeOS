import { expect, type Page, test } from "@playwright/test";

/**
 * The Research visual matrix (Phase 7 UI-SPEC "Visual regression and
 * fixtures", plan 07-16). Rendered by the same isolated harness as
 * `widgets.spec.ts` and `tasks.spec.ts` from the synthetic
 * `harness/research-fixtures.json` only (see `playwright.config.ts` for the
 * determinism contract): the REAL Research destination from `@ccc/plugin`
 * against the production stylesheet, with a fixture-backed `ResearchApi`.
 *
 * Baselines are Linux-container artifacts only (D-22). On any other host the
 * whole file skips, unless `CCC_VISUAL_ALLOW_LOCAL=1` is set for a smoke run;
 * a smoke run passes `--ignore-snapshots`, so it never writes or compares a
 * macOS PNG.
 */
test.skip(
  process.platform !== "linux" && !process.env.CCC_VISUAL_ALLOW_LOCAL,
  "baselines are Linux-only (D-22) - run scripts/ci/visual-in-container.sh",
);

const HARNESS_PAGE = new URL("../harness/index.html", import.meta.url);

/** Mirrors `tasks.spec.ts`'s annotation-driven baseline listing
 * (`scripts/list-visual-baselines.mjs`), so the declared set and the written
 * set can never drift. */
const BASELINE_ANNOTATION = "baseline";

function cell(
  title: string,
  snapshot: `${string}.png`,
  body: (page: Page, snapshot: string) => Promise<void>,
): void {
  test(title, { annotation: { type: BASELINE_ANNOTATION, description: snapshot } }, ({ page }) =>
    body(page, snapshot),
  );
}

function harnessUrl(params: Readonly<Record<string, string>>): string {
  const url = new URL(HARNESS_PAGE);
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

interface ResearchCell {
  readonly researchCase: string;
  readonly width: "full" | "narrow";
  readonly motion: "full" | "reduced";
}

/** One entry per committed baseline: `<case>-<width>[-reduced]`. */
const CELLS: readonly ResearchCell[] = [
  { researchCase: "research-report-full", width: "full", motion: "full" },
  { researchCase: "research-report-full", width: "narrow", motion: "full" },
  { researchCase: "research-report-partial", width: "full", motion: "full" },
  { researchCase: "research-report-partial", width: "narrow", motion: "full" },
  { researchCase: "research-report-long", width: "full", motion: "full" },
  { researchCase: "research-report-stale", width: "full", motion: "full" },
  { researchCase: "research-running", width: "full", motion: "full" },
  { researchCase: "research-running", width: "narrow", motion: "full" },
  { researchCase: "research-unconfigured", width: "full", motion: "full" },
  { researchCase: "research-empty", width: "full", motion: "full" },
  { researchCase: "research-empty", width: "narrow", motion: "full" },
  { researchCase: "research-loading", width: "full", motion: "full" },
  { researchCase: "research-error", width: "full", motion: "full" },
  { researchCase: "research-disconnected", width: "full", motion: "full" },
  { researchCase: "research-unreadable-row", width: "full", motion: "full" },
];

/**
 * Grows the viewport to the content's full height before the capture (see
 * `tasks.spec.ts`): the production scroller is as tall as the viewport.
 */
async function fitViewportToContent(page: Page): Promise<void> {
  const current = page.viewportSize();
  if (current === null) throw new Error("research visual cells need a fixed viewport");
  const content = page.locator(".ccc-content");
  if ((await content.count()) === 0) return;
  const needed = await content.evaluate((node) =>
    Math.ceil(node.getBoundingClientRect().top + node.scrollHeight),
  );
  if (needed > current.height) {
    await page.setViewportSize({ width: current.width, height: needed });
  }
}

/** Focus moves can scroll the content pane before the capture; the baseline shows the page from its top. */
async function resetScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("*")) {
      if (node.scrollTop !== 0) node.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
}

// ---------------------------------------------------------------------------
// State assertions. A pixel baseline shows how a state LOOKS; these prove the
// facts the baseline cannot name (the measure, the leading, the one-column
// layout, inert hostile text, no motion), and they run before the screenshot so
// a hollow or wrong cell can never be baselined (T-07-43).
// ---------------------------------------------------------------------------

/** The article measure and prose leading of the open report (RSRCH-10, D-24). */
async function expectArticleMeasure(page: Page): Promise<void> {
  const facts = await page.evaluate(() => {
    const reader = document.querySelector<HTMLElement>(".ccc-report-reader");
    const finding = document.querySelector<HTMLElement>(".ccc-report-text");
    const cell = document.querySelector<HTMLElement>(".ccc-research-reader-cell");
    if (reader === null || finding === null || cell === null) return null;
    // Computed lengths resolve to pixels, so `68ch` is compared through a probe
    // that is styled with the very same unit inside the very same element.
    const measureProbe = document.createElement("div");
    measureProbe.style.position = "absolute";
    measureProbe.style.visibility = "hidden";
    measureProbe.style.width = "68ch";
    reader.appendChild(measureProbe);
    const measure = measureProbe.getBoundingClientRect().width;
    measureProbe.remove();
    const leadingProbe = document.createElement("div");
    leadingProbe.style.position = "absolute";
    leadingProbe.style.visibility = "hidden";
    leadingProbe.style.fontSize = getComputedStyle(finding).fontSize;
    leadingProbe.style.lineHeight = "var(--ccc-leading-prose)";
    finding.appendChild(leadingProbe);
    const tokenLeading = Number.parseFloat(getComputedStyle(leadingProbe).lineHeight);
    leadingProbe.remove();
    return {
      maxWidth: Number.parseFloat(getComputedStyle(reader).maxWidth),
      measure,
      readerWidth: reader.getBoundingClientRect().width,
      cellWidth: cell.getBoundingClientRect().width,
      findingLeading: Number.parseFloat(getComputedStyle(finding).lineHeight),
      tokenLeading,
    };
  });
  expect(facts).not.toBeNull();
  if (facts === null) return;
  // The column's max-width is 68ch, and the full pane is wide enough for it to bind.
  expect(Math.abs(facts.maxWidth - facts.measure)).toBeLessThan(0.5);
  expect(facts.cellWidth).toBeGreaterThan(facts.measure);
  expect(Math.abs(facts.readerWidth - facts.measure)).toBeLessThan(1);
  // Finding line-height equals the prose leading token.
  expect(facts.tokenLeading).toBeGreaterThan(0);
  expect(Math.abs(facts.findingLeading - facts.tokenLeading)).toBeLessThan(0.5);
}

/** At the narrow pane the open report replaces the list and nothing scrolls sideways. */
async function expectNarrowReader(page: Page): Promise<void> {
  const reader = page.locator(".ccc-report-reader");
  await expect(reader).toHaveCount(1);
  await expect(page.locator(".ccc-research-list-cell")).toBeHidden();
  await expect(page.getByRole("button", { name: "Back to reports" })).toBeVisible();
  await expectNoHorizontalScroll(page);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>("[data-harness-width]");
    return {
      documentScroll: document.documentElement.scrollWidth,
      documentClient: document.documentElement.clientWidth,
      boxScroll: box?.scrollWidth ?? -1,
      boxClient: box?.clientWidth ?? -2,
    };
  });
  expect(widths.documentScroll).toBe(widths.documentClient);
  expect(widths.boxScroll).toBe(widths.boxClient);
}

/** Per-cell assertions, run before the screenshot. */
const ASSERTIONS: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  "research-report-long-full": expectArticleMeasure,
  "research-report-full-narrow": expectNarrowReader,
  "research-report-partial-narrow": expectNarrowReader,
  "research-running-narrow": expectNoHorizontalScroll,
  "research-empty-narrow": expectNoHorizontalScroll,
};

for (const { researchCase, width, motion } of CELLS) {
  const suffix = motion === "reduced" ? "-reduced" : "";
  const label = motion === "reduced" ? `${width} - reduced` : width;
  cell(
    `research - ${researchCase} - ${label}`,
    `${researchCase}-${width}${suffix}.png`,
    async (page, snapshotName) => {
      // The long and narrow cells are several thousand pixels tall and the amd64 container is
      // emulated on a loaded Mac: allow the capture time, never a looser pixel comparison.
      test.setTimeout(90_000);
      await page.goto(harnessUrl({ view: "research", case: researchCase, width, motion }));
      await page.locator("html[data-harness-ready=true]").waitFor({ state: "attached" });
      await fitViewportToContent(page);
      await resetScroll(page);
      await ASSERTIONS[`${researchCase}-${width}${suffix}`]?.(page);
      await expect(page.locator("[data-harness-width]")).toHaveScreenshot(snapshotName, {
        timeout: 45_000,
      });
    },
  );
}
