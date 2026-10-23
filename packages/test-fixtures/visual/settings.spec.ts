import { expect, type Page, test } from "@playwright/test";

/**
 * The Phase 8 visual matrix (UI-SPEC "Visual regression and fixtures", plan 08-21): the nine
 * Settings sections, the Diagnostics states and the diagnostic bundle, and the five-card Overview
 * slice in its eight states. Rendered by the same isolated harness as the other pixel specs from the
 * synthetic `settings-fixtures.json`, `diagnostics-fixtures.json` and `overview-fixtures.json` only
 * (see `playwright.config.ts` for the determinism contract): the REAL `SettingsDestination` and the
 * REAL `Overview` from `@ccc/plugin` against the production stylesheet.
 *
 * Baselines are Linux-container artifacts only (D-22). On any other host the whole file skips,
 * unless `CCC_VISUAL_ALLOW_LOCAL=1` is set for a smoke run; a smoke run passes `--ignore-snapshots`,
 * so it never writes or compares a macOS PNG.
 */
test.skip(
  process.platform !== "linux" && !process.env.CCC_VISUAL_ALLOW_LOCAL,
  "baselines are Linux-only (D-22) - run scripts/ci/visual-in-container.sh",
);

const HARNESS_PAGE = new URL("../harness/index.html", import.meta.url);

/** Mirrors `research.spec.ts`'s annotation-driven baseline listing
 * (`scripts/list-visual-baselines.mjs`), so the declared set and the written set can never drift. */
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

interface PixelCell {
  readonly view: "settings" | "diagnostics" | "overview";
  readonly caseId: string;
  readonly width: "full" | "narrow";
  readonly motion: "full" | "reduced";
}

const SETTINGS_SECTIONS = [
  "projects",
  "launchers",
  "integrations",
  "approvals-tasks",
  "paths",
  "visual",
  "security",
  "schedules",
  "diagnostics",
] as const;

/** The sections the UI-SPEC also asks for at the narrow pane. */
const NARROW_SECTIONS: ReadonlySet<string> = new Set(["security", "integrations", "diagnostics"]);

const OVERVIEW_STATES = [
  "ready",
  "nextopen",
  "failure",
  "empty",
  "partial-stale",
  "disconnected",
  "loading",
  "error",
] as const;

/** One entry per committed baseline: `<case>-<width>[-reduced]`. */
const CELLS: readonly PixelCell[] = [
  // `settings-<section>` x9: each section populated, full; narrow for three of them.
  ...SETTINGS_SECTIONS.flatMap((section): PixelCell[] => [
    { view: "settings", caseId: `settings-${section}`, width: "full", motion: "full" },
    ...(NARROW_SECTIONS.has(section)
      ? [
          {
            view: "settings",
            caseId: `settings-${section}`,
            width: "narrow",
            motion: "full",
          } satisfies PixelCell,
        ]
      : []),
  ]),
  // Diagnostics states.
  { view: "diagnostics", caseId: "diagnostics-fresh", width: "full", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-fresh", width: "narrow", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-mixed", width: "full", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-disconnected", width: "full", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-loading", width: "full", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-error", width: "full", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-stale", width: "full", motion: "full" },
  // The diagnostic bundle.
  { view: "diagnostics", caseId: "diagnostics-bundle", width: "full", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-bundle", width: "narrow", motion: "full" },
  { view: "diagnostics", caseId: "diagnostics-bundle-refused", width: "full", motion: "full" },
  {
    view: "diagnostics",
    caseId: "diagnostics-bundle-service-away",
    width: "full",
    motion: "full",
  },
  // The five slice cards together, eight states.
  ...OVERVIEW_STATES.map(
    (state): PixelCell => ({
      view: "overview",
      caseId: `overview-slice-${state}`,
      width: "full",
      motion: "full",
    }),
  ),
  // Reduced-motion parity (UI-SPEC: `diagnostics-mixed` at `data-motion="reduced"`).
  { view: "diagnostics", caseId: "diagnostics-mixed", width: "full", motion: "reduced" },
];

/**
 * Grows the viewport to the content's full height before the capture (see `research.spec.ts`): the
 * production scroller is as tall as the viewport, so a long page would otherwise be cut off.
 */
async function fitViewportToContent(page: Page): Promise<void> {
  const current = page.viewportSize();
  if (current === null) throw new Error("settings visual cells need a fixed viewport");
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
// State assertions. A pixel baseline shows how a state LOOKS; these prove the facts the baseline
// cannot name (no sideways scroll at the narrow pane, no motion), and they run before the
// screenshot so a hollow or wrong cell can never be baselined.
// ---------------------------------------------------------------------------

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

/** Under data-motion="reduced" nothing animates and no scroll is smooth (A11Y-03, UI-SPEC Motion). */
async function expectNoMotion(page: Page): Promise<void> {
  await expect(page.locator(".ccc-command-center")).toHaveAttribute("data-motion", "reduced");
  const facts = await page.evaluate(() => {
    const root = document.querySelector(".ccc-settings");
    const running = document.getAnimations().filter((animation) => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      return (
        animation.playState === "running" && target !== null && (root?.contains(target) ?? false)
      );
    }).length;
    let smooth = 0;
    let animated = 0;
    let transitioning = 0;
    for (const node of root?.querySelectorAll("*") ?? []) {
      const style = getComputedStyle(node);
      if (style.scrollBehavior === "smooth") smooth += 1;
      if (style.animationName !== "none" && Number.parseFloat(style.animationDuration) > 0) {
        animated += 1;
      }
      // Every transition duration in the destination, in seconds: reduced motion zeroes them all.
      for (const part of style.transitionDuration.split(",")) {
        if (Number.parseFloat(part) > 0) transitioning += 1;
      }
    }
    return {
      running,
      smooth,
      animated,
      transitioning,
      rootSmooth: getComputedStyle(document.documentElement).scrollBehavior,
    };
  });
  expect(facts.running).toBe(0);
  expect(facts.animated).toBe(0);
  expect(facts.smooth).toBe(0);
  expect(facts.transitioning).toBe(0);
  expect(facts.rootSmooth).not.toBe("smooth");
  await expectMotionTokensCollapse(page);
}

/**
 * Makes the reduced-motion cell non-vacuous (the Phase 7 wave-5 lesson). A populated Diagnostics
 * page holds nothing that animates, so its reduced baseline is byte-identical to the full-motion one
 * and "nothing animates" would stay true if the reduced-motion rule were deleted. A nav item and a
 * skeleton line carry transitions on the motion tokens: each is read under reduced motion (must be
 * 0) and again with the same shell switched to full motion (must be positive), then reduced motion
 * is restored before the screenshot.
 */
async function expectMotionTokensCollapse(page: Page): Promise<void> {
  const probe = await page.evaluate(() => {
    const root = document.querySelector(".ccc-settings");
    const shell = document.querySelector(".ccc-command-center");
    const nav = document.querySelector(".ccc-settings-nav-item");
    if (root === null || shell === null || nav === null) return null;
    const line = document.createElement("div");
    line.className = "ccc-skeleton-line";
    root.appendChild(line);
    const longestMs = (element: Element): number => {
      let longest = 0;
      for (const part of getComputedStyle(element).transitionDuration.split(",")) {
        const text = part.trim();
        const seconds = text.endsWith("ms")
          ? Number.parseFloat(text) / 1000
          : Number.parseFloat(text);
        if (Number.isFinite(seconds)) longest = Math.max(longest, seconds * 1000);
      }
      return longest;
    };
    const reduced = { nav: longestMs(nav), line: longestMs(line) };
    shell.setAttribute("data-motion", "full");
    const full = { nav: longestMs(nav), line: longestMs(line) };
    shell.setAttribute("data-motion", "reduced");
    line.remove();
    return { reduced, full };
  });
  expect(probe).not.toBeNull();
  // The same elements at full motion have a transition, so the zero under reduced motion is the
  // rule at work and not an element that never moved.
  expect(probe?.full.nav ?? 0).toBeGreaterThan(0);
  expect(probe?.full.line ?? 0).toBeGreaterThan(0);
  expect(probe?.reduced.nav ?? -1).toBe(0);
  expect(probe?.reduced.line ?? -1).toBe(0);
}

/** The bundle cell shows the preview and the refusal cell shows none. */
async function expectBundlePreview(page: Page): Promise<void> {
  await expect(page.locator("pre.ccc-bundle-preview")).toHaveCount(1);
  await expect(page.locator("pre.ccc-bundle-preview")).toContainText("bundleVersion");
}

async function expectRefusalWithoutPreview(page: Page): Promise<void> {
  await expect(page.getByText("Bundle not offered")).toBeVisible();
  await expect(page.locator(".ccc-bundle-preview")).toHaveCount(0);
}

/** The Overview shows exactly the five slice cards. */
async function expectFiveCards(page: Page): Promise<void> {
  await expect(page.locator(".ccc-card")).toHaveCount(5);
}

/** Per-cell assertions, run before the screenshot. */
const ASSERTIONS: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  "settings-security-narrow": expectNoHorizontalScroll,
  "settings-integrations-narrow": expectNoHorizontalScroll,
  "settings-diagnostics-narrow": expectNoHorizontalScroll,
  "diagnostics-fresh-narrow": expectNoHorizontalScroll,
  "diagnostics-bundle-full": expectBundlePreview,
  "diagnostics-bundle-narrow": async (page) => {
    await expectBundlePreview(page);
    await expectNoHorizontalScroll(page);
  },
  "diagnostics-bundle-refused-full": expectRefusalWithoutPreview,
  "diagnostics-bundle-service-away-full": expectBundlePreview,
  "diagnostics-mixed-full-reduced": expectNoMotion,
  ...Object.fromEntries(
    OVERVIEW_STATES.map((state) => [`overview-slice-${state}-full`, expectFiveCards]),
  ),
};

for (const { view, caseId, width, motion } of CELLS) {
  const suffix = motion === "reduced" ? "-reduced" : "";
  const label = motion === "reduced" ? `${width} - reduced` : width;
  cell(
    `${view} - ${caseId} - ${label}`,
    `${caseId}-${width}${suffix}.png`,
    async (page, snapshotName) => {
      // The pages are tall and the amd64 container is emulated on a loaded Mac: allow the capture
      // time, never a looser pixel comparison.
      test.setTimeout(90_000);
      await page.goto(harnessUrl({ view, case: caseId, width, motion }));
      await page.locator("html[data-harness-ready=true]").waitFor({ state: "attached" });
      // A harness error is a typo in the spec, never a state worth a baseline.
      await expect(page.locator(".ccc-harness-error")).toHaveCount(0);
      await fitViewportToContent(page);
      await resetScroll(page);
      await ASSERTIONS[`${caseId}-${width}${suffix}`]?.(page);
      await expect(page.locator("[data-harness-width]")).toHaveScreenshot(snapshotName, {
        timeout: 45_000,
      });
    },
  );
}
