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

for (const { researchCase, width, motion } of CELLS) {
  const suffix = motion === "reduced" ? "-reduced" : "";
  const label = motion === "reduced" ? `${width} - reduced` : width;
  cell(
    `research - ${researchCase} - ${label}`,
    `${researchCase}-${width}${suffix}.png`,
    async (page, snapshotName) => {
      await page.goto(harnessUrl({ view: "research", case: researchCase, width, motion }));
      await page.locator("html[data-harness-ready=true]").waitFor({ state: "attached" });
      await fitViewportToContent(page);
      await resetScroll(page);
      await expect(page.locator("[data-harness-width]")).toHaveScreenshot(snapshotName);
    },
  );
}
