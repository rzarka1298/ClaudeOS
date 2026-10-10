import { expect, type Page, test } from "@playwright/test";

/**
 * The Tasks visual matrix (Phase 6 UI-SPEC "Visual regression and
 * fixtures", plan 06-26). Rendered by the same isolated harness as
 * `widgets.spec.ts` from synthetic fixtures only (see `playwright.config.ts`
 * for the determinism contract). Cells are the Tasks destination and the
 * per-project tasks panel.
 *
 * Baselines are Linux-container artifacts only (D-22). On any other host the
 * whole file skips, unless `CCC_VISUAL_ALLOW_LOCAL=1` is set for a smoke run —
 * and a smoke run passes `--ignore-snapshots`, so it never writes or compares a
 * macOS PNG.
 */
test.skip(
  process.platform !== "linux" && !process.env.CCC_VISUAL_ALLOW_LOCAL,
  "baselines are Linux-only (D-22) — run scripts/ci/visual-in-container.sh",
);

const HARNESS_PAGE = new URL("../harness/index.html", import.meta.url);

/** Mirrors `widgets.spec.ts`'s annotation-driven baseline listing
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

interface TasksCell {
  readonly view: "tasks" | "projects";
  readonly tasksCase: string;
  readonly width: "full" | "narrow";
  readonly motion: "full" | "reduced";
}

/** One entry per committed baseline: `<case>-<width>[-reduced]`. */
const CELLS: readonly TasksCell[] = [
  { view: "tasks", tasksCase: "tasks-today", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-today", width: "narrow", motion: "full" },
  { view: "tasks", tasksCase: "tasks-overdue-blocked", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-proposed", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-proposed", width: "narrow", motion: "full" },
  { view: "tasks", tasksCase: "tasks-create-form-error", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-create-form-error", width: "narrow", motion: "full" },
  { view: "tasks", tasksCase: "tasks-detail-conflict", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-attention", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-attention", width: "narrow", motion: "full" },
  { view: "tasks", tasksCase: "tasks-empty", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-none", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-loading", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-stale", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-error", width: "full", motion: "full" },
  { view: "tasks", tasksCase: "tasks-disconnected", width: "full", motion: "full" },
  { view: "projects", tasksCase: "project-tasks", width: "full", motion: "full" },
  { view: "projects", tasksCase: "project-tasks", width: "narrow", motion: "full" },
  { view: "tasks", tasksCase: "tasks-today", width: "full", motion: "reduced" },
];

/**
 * Grows the viewport to the content's full height before the capture (see
 * `agent-runs.spec.ts`): the production scroller is as tall as the viewport.
 *
 */
async function fitViewportToContent(page: Page): Promise<void> {
  const current = page.viewportSize();
  if (current === null) throw new Error("tasks visual cells need a fixed viewport");
  const content = page.locator(".ccc-content");
  if ((await content.count()) === 0) return;
  const needed = await content.evaluate((node) =>
    Math.ceil(node.getBoundingClientRect().top + node.scrollHeight),
  );
  if (needed > current.height) {
    await page.setViewportSize({ width: current.width, height: needed });
  }
}

/**
 * Focus moves (a pane heading takes focus) can scroll the content pane before
 * the capture; the baseline must show the page from its top.
 */
async function resetScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("*")) {
      if (node.scrollTop !== 0) node.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
}

for (const { view, tasksCase, width, motion } of CELLS) {
  const suffix = motion === "reduced" ? "-reduced" : "";
  const label = motion === "reduced" ? `${width} — reduced` : width;
  cell(
    `tasks — ${tasksCase} — ${label}`,
    `${tasksCase}-${width}${suffix}.png`,
    async (page, snapshotName) => {
      await page.goto(harnessUrl({ view, case: tasksCase, width, motion }));
      await page.locator("html[data-harness-ready=true]").waitFor({ state: "attached" });
      await fitViewportToContent(page);
      await resetScroll(page);
      await expect(page.locator("[data-harness-width]")).toHaveScreenshot(snapshotName);
    },
  );
}
