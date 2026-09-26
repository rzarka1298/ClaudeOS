import { WIDGET_IDS } from "@ccc/plugin";
import { expect, type Page, test } from "@playwright/test";

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

/**
 * The annotation type that names a cell's baseline. `scripts/check-images.sh`
 * derives the EXACT set of baselines git may track from these annotations, via
 * `scripts/list-visual-baselines.mjs` and `playwright test --list`, never from
 * the snapshot directory (judge-r1 finding 1). A PNG no cell declares, or a
 * declared cell with no committed PNG, fails `ci:images`.
 */
const BASELINE_ANNOTATION = "baseline";

/**
 * Registers one screenshot cell. The snapshot name is declared once: it goes
 * into the listable annotation AND is the only name the body can hand to
 * `toHaveScreenshot`, so the listed set and the written set cannot drift.
 */
function cell(
  title: string,
  snapshot: `${string}.png`,
  body: (page: Page, snapshot: string) => Promise<void>,
): void {
  test(title, { annotation: { type: BASELINE_ANNOTATION, description: snapshot } }, ({ page }) =>
    body(page, snapshot),
  );
}

/** The harness page for one cell, as a `file://` URL with its query string. */
function harnessUrl(params: Readonly<Record<string, string>>): string {
  const url = new URL(HARNESS_PAGE);
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

/**
 * Every presentation a card can take (UI-SPEC per-state table). `stale` and
 * `disconnected` are presentations `resolveCardPresentation()` derives, not
 * widget states — the harness hands the real frame a state plus a connection
 * and lets the production resolver decide what is drawn.
 */
const PRESENTATIONS = [
  "loading",
  "empty",
  "ready",
  "stale",
  "disconnected",
  "error",
  "permission-required",
  "unavailable",
] as const;

// 8 registered widgets x 8 presentations. The ids come from the registry
// itself, never a hand-typed list, so a widget a later phase registers joins
// the matrix — and needs a baseline — automatically.
for (const widgetId of WIDGET_IDS) {
  for (const presentation of PRESENTATIONS) {
    cell(
      `${widgetId} — ${presentation}`,
      `${widgetId}-${presentation}.png`,
      async (page, snapshot) => {
        await page.goto(harnessUrl({ widget: widgetId, state: presentation, motion: "full" }));
        await expect(page.locator(".ccc-card")).toHaveScreenshot(snapshot);
      },
    );
  }
}

// The four motion cells (A11Y-03, D-19). Reduced motion is one `data-motion`
// attribute on the root that zeroes the motion tokens and switches the twinkle
// field off; these cells guard that single switch — for the atmosphere (the
// whole viewport-sized root) and for a card.
//
// Pixels alone cannot guard it (found in plan 03-10). Reduced motion removes
// MOTION, not static appearance, and `animations: "disabled"` finishes every
// transition and rewinds every infinite animation before the shot. So the two
// service-health cards are byte-identical, and the two backgrounds differ by a
// few twinkle pixels, far under `maxDiffPixelRatio`. Each cell therefore also
// asserts the switch itself through computed style, which differs by mode,
// before taking its screenshot.
const TWINKLE_ANIMATION = { full: "ccc-twinkle", reduced: "none" } as const;
// `.ccc-kpi-number` eases opacity and transform over --ccc-motion-slow (400ms);
// reduced motion sets `transition: none`.
const KPI_TRANSITION = { full: "0.4s, 0.4s", reduced: "0s" } as const;

for (const motion of ["full", "reduced"] as const) {
  cell(`background — ${motion}`, `background-${motion}.png`, async (page, snapshot) => {
    await page.goto(harnessUrl({ widget: "background", motion }));
    await expect(page.locator(".ccc-twinkle-point").first()).toHaveCSS(
      "animation-name",
      TWINKLE_ANIMATION[motion],
    );
    await expect(page.locator(".ccc-command-center")).toHaveScreenshot(snapshot);
  });

  cell(
    `service-health — ready — motion ${motion}`,
    `service-health-ready-motion-${motion}.png`,
    async (page, snapshot) => {
      await page.goto(harnessUrl({ widget: "service-health", state: "ready", motion }));
      await expect(page.locator(".ccc-card .ccc-kpi-number")).toHaveCSS(
        "transition-duration",
        KPI_TRANSITION[motion],
      );
      await expect(page.locator(".ccc-card")).toHaveScreenshot(snapshot);
    },
  );
}
