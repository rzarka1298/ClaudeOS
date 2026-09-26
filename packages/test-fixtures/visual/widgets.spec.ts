import { expect, test } from "@playwright/test";

/**
 * The widget visual matrix (UI-08, A11Y-03), rendered by the isolated harness
 * in `../harness/` (see `playwright.config.ts` for the determinism contract).
 *
 * Baselines are Linux-container artifacts only (D-22). On any other host the
 * whole file skips, unless `CCC_VISUAL_ALLOW_LOCAL=1` is set for a smoke run —
 * and a smoke run passes `--ignore-snapshots`, so it proves the harness builds,
 * loads from `file://`, mounts the card and reaches the screenshot assertion
 * without ever writing or comparing a macOS PNG.
 */
test.skip(
  process.platform !== "linux" && !process.env.CCC_VISUAL_ALLOW_LOCAL,
  "baselines are Linux-only (D-22) — run scripts/ci/visual-in-container.sh",
);

const HARNESS_PAGE = new URL("../harness/index.html", import.meta.url);

/** The harness page for one cell, as a `file://` URL with its query string. */
function harnessUrl(params: Readonly<Record<string, string>>): string {
  const url = new URL(HARNESS_PAGE);
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

test("service-health — ready", async ({ page }) => {
  await page.goto(harnessUrl({ widget: "service-health", state: "ready", motion: "full" }));
  await expect(page.locator(".ccc-card")).toHaveScreenshot("service-health-ready.png");
});
