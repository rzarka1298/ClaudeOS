import { expect, type Page, test } from "@playwright/test";

/**
 * The Agent runs destination's visual matrix (UI-SPEC S3 "Visual regression",
 * plan 05-13 Task 3). Rendered by the same isolated harness as `widgets.spec.ts`
 * (see `playwright.config.ts` for the determinism contract) — this is a
 * separate spec file because it screenshots a DESTINATION, not a card, and
 * carries its own four fixed cells rather than a per-widget/per-presentation
 * matrix.
 *
 * Baselines are Linux-container artifacts only (D-22). On any other host the
 * whole file skips, unless `CCC_VISUAL_ALLOW_LOCAL=1` is set for a smoke run —
 * and a smoke run passes `--ignore-snapshots`, so it proves the harness builds,
 * loads from `file://`, mounts the destination and reaches the screenshot
 * assertion without ever writing or comparing a macOS PNG.
 */
test.skip(
  process.platform !== "linux" && !process.env.CCC_VISUAL_ALLOW_LOCAL,
  "baselines are Linux-only (D-22) — run scripts/ci/visual-in-container.sh",
);

const HARNESS_PAGE = new URL("../harness/index.html", import.meta.url);

/** Mirrors `widgets.spec.ts`'s own annotation-driven baseline listing
 * (`scripts/list-visual-baselines.mjs`), so the declared set and the
 * written set can never drift. */
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

/**
 * The four fixed cells (UI-SPEC "Visual regression" S3): a selected waiting
 * Run and a selected stale Run at full width (master/detail); the narrow
 * stacked detail; the disconnected state. Each name matches the harness's
 * own `case` query parameter and the committed baseline filename.
 */
const CASES = [
  { agentRunsCase: "selected-waiting", snapshot: "agent-runs-selected-waiting.png" },
  { agentRunsCase: "selected-stale", snapshot: "agent-runs-selected-stale.png" },
  { agentRunsCase: "narrow-detail", snapshot: "agent-runs-narrow-detail.png" },
  { agentRunsCase: "disconnected", snapshot: "agent-runs-disconnected.png" },
] as const;

/**
 * Grows the viewport to the destination's full height before the capture.
 *
 * The destination lives in the production `.ccc-content` scroller, which is
 * exactly as tall as the command-center root — here, the viewport. At the
 * fixed 1024x768 viewport everything below 768px (the detail pane's field
 * list, the usage section) was scrolled out of view and screenshotted as
 * blank background (05 wave 4 review, "detail list clipped at the 768px
 * capture"). In Obsidian the same content simply scrolls; growing the page
 * instead makes the baseline show the whole destination. Width is unchanged,
 * so no container query or column layout moves.
 */
async function fitViewportToContent(page: Page): Promise<void> {
  const current = page.viewportSize();
  if (current === null) throw new Error("agent-runs visual cells need a fixed viewport");
  const needed = await page
    .locator(".ccc-content")
    .evaluate((content) => Math.ceil(content.getBoundingClientRect().top + content.scrollHeight));
  if (needed > current.height) {
    await page.setViewportSize({ width: current.width, height: needed });
  }
}

for (const { agentRunsCase, snapshot } of CASES) {
  cell(`agent-runs — ${agentRunsCase}`, snapshot, async (page, snapshotName) => {
    await page.goto(harnessUrl({ view: "agent-runs", case: agentRunsCase, motion: "full" }));
    await fitViewportToContent(page);
    await expect(page.locator(".ccc-agent-runs")).toHaveScreenshot(snapshotName);
  });
}
