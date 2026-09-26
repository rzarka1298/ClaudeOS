import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Visual regression for the widget component library (UI-08, D-21, D-22).
 *
 * WHAT IS SCREENSHOTTED. `packages/test-fixtures/harness/` — a static page
 * built by esbuild that renders the real `WidgetFrame` and registry
 * definitions from the synthetic `widget-fixtures.json`. Playwright loads it
 * from `file://`, so there is no web server, no port and no network. What the
 * harness may import is pinned by `packages/test-fixtures/src/harness-purity.test.ts`
 * (PRIV-04 layer 1), which is why a committed baseline can contain nothing
 * personal.
 *
 * WHERE BASELINES COME FROM. Linux only (D-22). Font rasterisation differs
 * between macOS and Linux Chromium, so a macOS-generated PNG would fail on CI
 * forever and "fixing" it by raising the threshold is exactly research
 * Pitfall 5. Three things enforce this:
 *   - `snapshotPathTemplate` puts `{platform}` in every baseline name, so a
 *     macOS file (`*-darwin.png`) can never be mistaken for the Linux one;
 *   - `widgets.spec.ts` skips on a non-Linux host unless
 *     `CCC_VISUAL_ALLOW_LOCAL=1` is set, and that override is meant for
 *     `--ignore-snapshots` smoke runs only;
 *   - on CI `updateSnapshots` is `"none"`, so a missing baseline FAILS rather
 *     than being silently written. Baselines are generated in the pinned
 *     `mcr.microsoft.com/playwright:v1.63.0-noble` container (plan 03-10).
 *
 * WHAT MAKES A RUN DETERMINISTIC.
 *   - `animations: "disabled"` finishes CSS animations/transitions (the twinkle
 *     field) and `caret: "hide"` hides the text caret — both Playwright
 *     defaults, pinned here so a future default change cannot move baselines;
 *   - `stylePath` injects the harness's frozen font stack on every screenshot;
 *   - the harness uses the fixture's own frozen `now` for relative times, and
 *     `timezoneId`/`locale` below pin the one absolute time the Source panel
 *     prints (`toLocaleString` would otherwise follow the host's zone);
 *   - one fixed viewport and `deviceScaleFactor: 1`.
 *
 * `maxDiffPixelRatio: 0.01` absorbs sub-pixel anti-aliasing noise between two
 * runs of the SAME container. Raising it more than once is the Pitfall 5
 * warning sign and must be a reviewed decision, not a CI fix.
 */

const HARNESS_FONTS = fileURLToPath(
  new URL("./packages/test-fixtures/harness/harness-fonts.css", import.meta.url),
);

export default defineConfig({
  testDir: "packages/test-fixtures/visual",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    timezoneId: "UTC",
    locale: "en-US",
  },
  projects: [
    {
      name: "chromium",
      // The device preset carries its own 1280x720 viewport; restate ours
      // after the spread so the project cannot silently override it.
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
      },
    },
  ],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
      stylePath: HARNESS_FONTS,
    },
  },
  snapshotPathTemplate: "{testDir}/{testFileName}-snapshots/{arg}-{projectName}-{platform}{ext}",
  updateSnapshots: process.env.CI ? "none" : "missing",
});
