import { expect, type Page, test } from "@playwright/test";

/**
 * The Approvals visual matrix (Phase 6 UI-SPEC "Visual regression and
 * fixtures", plan 06-26). Rendered by the same isolated harness as
 * `widgets.spec.ts` from synthetic fixtures only (see `playwright.config.ts`
 * for the determinism contract). Cells are the Approvals section of the Agent
 * runs destination and the shell tab strip with its count chip.
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

interface ApprovalsCell {
  readonly approvalsCase: string;
  readonly width: "full" | "narrow";
  readonly motion: "full" | "reduced";
}

/** One entry per committed baseline: `<case>-<width>[-reduced]`. */
const CELLS: readonly ApprovalsCell[] = [
  { approvalsCase: "approvals-pending-destructive", width: "full", motion: "full" },
  { approvalsCase: "approvals-pending-destructive", width: "narrow", motion: "full" },
  { approvalsCase: "approvals-pending-requester", width: "full", motion: "full" },
  { approvalsCase: "approvals-pending-requester", width: "narrow", motion: "full" },
  { approvalsCase: "approvals-pending-test", width: "full", motion: "full" },
  { approvalsCase: "approvals-executing", width: "full", motion: "full" },
  { approvalsCase: "approvals-executed", width: "full", motion: "full" },
  { approvalsCase: "approvals-failed", width: "full", motion: "full" },
  { approvalsCase: "approvals-unknown", width: "full", motion: "full" },
  { approvalsCase: "approvals-expired", width: "full", motion: "full" },
  { approvalsCase: "approvals-expired", width: "narrow", motion: "full" },
  { approvalsCase: "approvals-hash-mismatch", width: "full", motion: "full" },
  { approvalsCase: "approvals-too-large", width: "full", motion: "full" },
  { approvalsCase: "approvals-empty", width: "full", motion: "full" },
  { approvalsCase: "approvals-loading", width: "full", motion: "full" },
  { approvalsCase: "approvals-error", width: "full", motion: "full" },
  { approvalsCase: "approvals-stale", width: "full", motion: "full" },
  { approvalsCase: "approvals-disconnected", width: "full", motion: "full" },
  { approvalsCase: "approvals-pending-destructive", width: "full", motion: "reduced" },
  { approvalsCase: "shell-nav-count", width: "full", motion: "full" },
  { approvalsCase: "shell-nav-count", width: "narrow", motion: "full" },
];

/**
 * Grows the viewport to the content's full height before the capture (see
 * `agent-runs.spec.ts`): the production scroller is as tall as the viewport.
 * The shell tab strip case has no scroller and is left alone.
 */
async function fitViewportToContent(page: Page): Promise<void> {
  const current = page.viewportSize();
  if (current === null) throw new Error("approvals visual cells need a fixed viewport");
  const content = page.locator(".ccc-content");
  if ((await content.count()) === 0) return;
  const needed = await content.evaluate((node) =>
    Math.ceil(node.getBoundingClientRect().top + node.scrollHeight),
  );
  if (needed > current.height) {
    await page.setViewportSize({ width: current.width, height: needed });
  }
}

for (const { approvalsCase, width, motion } of CELLS) {
  const suffix = motion === "reduced" ? "-reduced" : "";
  const label = motion === "reduced" ? `${width} — reduced` : width;
  cell(
    `approvals — ${approvalsCase} — ${label}`,
    `${approvalsCase}-${width}${suffix}.png`,
    async (page, snapshotName) => {
      await page.goto(harnessUrl({ view: "agent-runs", case: approvalsCase, width, motion }));
      await page.locator("html[data-harness-ready=true]").waitFor({ state: "attached" });
      await fitViewportToContent(page);
      await expect(page.locator("[data-harness-width]")).toHaveScreenshot(snapshotName);
    },
  );
}
