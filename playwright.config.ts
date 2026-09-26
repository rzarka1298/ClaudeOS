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
 * Pitfall 5. Enforced in depth (plan 03-10 closed the 03-09 review's MAJOR):
 *   - `snapshotPathTemplate` puts `{platform}` in every baseline name, so a
 *     macOS file (`*-darwin.png`) can never be mistaken for the Linux one;
 *   - `widgets.spec.ts` skips on a non-Linux host unless
 *     `CCC_VISUAL_ALLOW_LOCAL=1` is set, and that override is meant for
 *     `--ignore-snapshots` smoke runs only;
 *   - `updateSnapshots` is `"none"` EVERYWHERE, so a missing baseline FAILS
 *     rather than being silently written — on CI, on a Mac, and on a plain
 *     comparison run inside the container alike;
 *   - `--update-snapshots` is refused at config load unless the process
 *     looks like the pinned `mcr.microsoft.com/playwright:v1.63.0-noble` image
 *     as launched by `scripts/ci/visual-in-container.sh` (see
 *     `IN_PINNED_CONTAINER`). This prevents ACCIDENTAL baseline writes outside
 *     the container — a plain `-u` on a Mac, or on a Linux host that has not
 *     been set up to look like the image. It is a guard against mistakes, not a
 *     security boundary: a Linux host that deliberately sets the same
 *     environment can still write one, which is why review of every baseline
 *     commit and `ci:images` remain layers of their own;
 *   - `.gitignore` admits only `*-chromium-linux.png` into the snapshot
 *     directory, and `scripts/check-images.sh` (`ci:images`) fails on any
 *     other tracked image.
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

/**
 * True when the process looks like the pinned Playwright image as
 * `visual-in-container.sh` launches it: a Linux process, with the marker that
 * script passes to `docker run`, and with the browser path the official image
 * bakes in. Requiring all three means a Linux laptop that exported the marker
 * by accident is still refused. Every signal here is environment the caller
 * controls, so this prevents accidental writes; it cannot stop a host that
 * sets all three on purpose.
 */
const IN_PINNED_CONTAINER =
  process.platform === "linux" &&
  process.env.CCC_VISUAL_CONTAINER === "1" &&
  process.env.PLAYWRIGHT_BROWSERS_PATH === "/ms-playwright";

/** `-u`, `-u=changed`, `--update-snapshots`, `--update-snapshots=all`, … */
const WANTS_BASELINE_WRITE = process.argv.some(
  (arg) => arg === "-u" || arg.startsWith("-u=") || arg.startsWith("--update-snapshots"),
);

if (WANTS_BASELINE_WRITE && !IN_PINNED_CONTAINER) {
  throw new Error(
    "Visual baselines are written only inside the pinned Linux container (D-22). " +
      "Run: sh scripts/ci/visual-in-container.sh --update-snapshots",
  );
}

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
  // Never write implicitly. The only way a baseline is written is an explicit
  // `--update-snapshots` inside the pinned container (guard above).
  updateSnapshots: "none",
});
