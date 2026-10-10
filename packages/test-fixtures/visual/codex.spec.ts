import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * The Codex visual matrix (plan 05.1-27, UI-SPEC "Visual regression", ADR-0023):
 * the detailed Codex card states, rendered by the same isolated harness as
 * `widgets.spec.ts` (see `playwright.config.ts` for the determinism contract)
 * through the real registered widget, the real frame and the real launch
 * toolbar, from the synthetic `codex-visual-fixtures.json` only.
 *
 * Baselines are Linux-container artifacts only (D-22), written by the
 * orchestrator in the pinned container as one standalone commit and never by an
 * executing agent. On any other host the whole file skips, unless
 * `CCC_VISUAL_ALLOW_LOCAL=1` is set for a smoke run, and a smoke run passes
 * `--ignore-snapshots`: it proves the harness builds, loads from `file://`,
 * mounts each cell, passes every state assertion and reaches the screenshot
 * assertion without ever writing or comparing a macOS PNG.
 */
test.skip(
  process.platform !== "linux" && !process.env.CCC_VISUAL_ALLOW_LOCAL,
  "baselines are Linux-only (D-22) — run scripts/ci/visual-in-container.sh",
);

const HARNESS_PAGE = new URL("../harness/index.html", import.meta.url);

/** The annotation type that names a cell's baseline (see `widgets.spec.ts`). */
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

const PANES = ["narrow", "full"] as const;
type Pane = (typeof PANES)[number];

/**
 * Grows the viewport to the card's full height before the capture.
 *
 * The Codex card is `tall` and its sections stack (five of them, rows and a
 * token breakdown), so at the fixed 1024x768 viewport the lower sections sit
 * below the page and an element screenshot would capture them as blank
 * background (the same defect the Agent runs spec closed in 05 wave 4). In
 * Obsidian the same content simply scrolls; growing the page makes the baseline
 * show the whole card. Width is unchanged, so no container query or column
 * layout moves.
 */
async function fitViewportToCard(page: Page): Promise<void> {
  const current = page.viewportSize();
  if (current === null) throw new Error("codex visual cells need a fixed viewport");
  const needed = await page
    .locator(".ccc-card")
    .evaluate((card) => Math.ceil(card.getBoundingClientRect().bottom + window.scrollY) + 32);
  if (needed > current.height) {
    await page.setViewportSize({ width: current.width, height: needed });
  }
}

/** Opens one Codex card cell and returns the card, mounted and fully in view. */
async function openCodex(
  page: Page,
  caseId: string,
  pane: Pane,
  motion: "full" | "reduced" = "full",
): Promise<Locator> {
  await page.goto(harnessUrl({ view: "codex", case: caseId, pane, motion }));
  const card = page.locator(".ccc-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator("h3")).toHaveText("Codex sessions and usage");
  await fitViewportToCard(page);
  return card;
}

/** The five section headings, in the fixed UI-SPEC order. */
const SECTION_HEADINGS = [
  "Headroom",
  "Plan usage",
  "Current run",
  "Recent sessions",
  "Token activity",
] as const;

// ---------------------------------------------------------------------------
// State assertions. A pixel baseline shows how a state LOOKS; these prove what
// each state must show or HIDE (UI-SPEC non-negotiables 3 and 5, floors 5, 7,
// 10, 13), and they run before the screenshot so a hollow cell can never be
// baselined (T-05.1-40).
// ---------------------------------------------------------------------------

/** One of the five `ccc-usage-section` blocks, found by its heading. */
function section(card: Locator, heading: (typeof SECTION_HEADINGS)[number]): Locator {
  return card.locator("section.ccc-usage-section").filter({
    has: card.page().getByRole("heading", { level: 4, name: heading, exact: true }),
  });
}

/** The Codex headroom cell (the strip holds Claude first, Codex second). */
const codexCell = (card: Locator): Locator => card.locator(".ccc-headroom-cell").nth(1);

/** A section that must show no meter, no reserve tick and no reserve legend. */
async function expectNoBar(scope: Locator): Promise<void> {
  await expect(scope.locator("meter")).toHaveCount(0);
  await expect(scope.locator(".ccc-reserve-tick")).toHaveCount(0);
  await expect(scope.locator(".ccc-reserve-meter-wrap")).toHaveCount(0);
}

/** Nothing in the card may be wider than the card (no horizontal scroll). */
async function expectNoHorizontalOverflow(card: Locator): Promise<void> {
  const overflow = await card.evaluate((element) => {
    const widest = (node: Element): number => node.scrollWidth - node.clientWidth;
    return {
      card: widest(element),
      body: widest(element.querySelector(".ccc-card-body") ?? element),
    };
  });
  expect(overflow.card).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
}

/** The shared content of the ready-mixed card, at either width. */
async function expectReadyMixed(card: Locator): Promise<void> {
  await expect(card).toHaveAttribute("data-presentation", "ready");
  await expect(card.locator("h4")).toHaveText([...SECTION_HEADINGS]);
  await expect(codexCell(card)).toContainText("Has headroom");
  await expect(section(card, "Plan usage")).toContainText("41% used · resets Sep 29, 4:40 PM");
  await expect(section(card, "Plan usage").locator("meter")).toHaveCount(1);
  await expect(section(card, "Plan usage").locator(".ccc-reserve-tick")).toHaveCount(1);
  await expect(section(card, "Current run")).toContainText("Refactor the parser");
  const recent = section(card, "Recent sessions");
  await expect(recent.locator(".ccc-list-row")).toHaveCount(5);
  await expect(recent).toContainText("Paused by usage limit");
  await expect(recent).toContainText("resumes after Sep 22, 4:40 PM");
  await expect(recent).toContainText("Unknown — ended without reporting");
  await expect(recent).toContainText("Failed");
  await expect(recent).toContainText("Completed");
  await expect(section(card, "Token activity")).toContainText("1.3M tokens");
  // The accessible name of every row action is unique inside the card (floor 10).
  const names = await card
    .locator(".ccc-row-action")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
  expect(new Set(names).size).toBe(names.length);
}

/** Cases that have a state-specific assertion, keyed by case id. */
const CASE_ASSERTIONS: Readonly<Record<string, (card: Locator, page: Page) => Promise<void>>> = {
  "ready-mixed": async (card) => {
    await expectReadyMixed(card);
    // At full motion the row pills ease colour over the fast token (120ms); the
    // meter and the tick never transition at any motion mode (UI-SPEC Motion).
    await expect(card.locator(".ccc-row-action").first()).toHaveCSS("transition-duration", "0.12s");
    await expect(card.locator(".ccc-reserve-meter")).toHaveCSS("transition-duration", "0s");
    await expect(card.locator(".ccc-reserve-tick")).toHaveCSS("transition-duration", "0s");
  },
  "ready-over-reserve": async (card) => {
    const plan = section(card, "Plan usage");
    await expect(plan).toContainText("▲ At or over the 80% reserve line");
    await expect(plan.locator(".ccc-reserve-tick")).toHaveCount(1);
    await expect(plan).toContainText("80% reserve line");
    await expect(codexCell(card)).toContainText("Held back");
    await expect(codexCell(card)).toContainText("At or over the 80% reserve line.");
    await expect(codexCell(card)).toContainText("2 runs paused by the usage limit.");
    await expect(section(card, "Current run")).toContainText("No Codex run in progress.");
    await expect(section(card, "Recent sessions")).toContainText("2 more sessions aren't shown.");
  },
  "ready-fallback-source": async (card) => {
    await expect(section(card, "Plan usage")).toContainText(
      "From the newest Codex session log, not a live read.",
    );
    await expect(section(card, "Plan usage").locator("meter")).toHaveCount(1);
    await expect(codexCell(card)).toContainText("Held back");
    await expect(codexCell(card)).toContainText("No live usage read yet.");
  },
  "ready-analysis-off": async (card) => {
    const sessions = card.getByRole("button", {
      name: "Turn on transcript analysis for Codex session titles",
    });
    const tokens = card.getByRole("button", {
      name: "Turn on transcript analysis for token activity",
    });
    await expect(sessions).toHaveCount(1);
    await expect(tokens).toHaveCount(1);
    await expect(section(card, "Recent sessions")).toContainText(
      "Session titles and previews stay hidden until transcript analysis is on.",
    );
    await expect(section(card, "Token activity")).toContainText("Transcript analysis is off");
    // No title is shown: every primary line uses the thread-id fallback name.
    await expect(card.locator(".ccc-list-primary").first()).toContainText("Session ");
  },
  "ready-partial-sessions": async (card) => {
    const recent = section(card, "Recent sessions");
    await expect(recent).toContainText("Codex sessions unavailable");
    await expect(recent).toContainText("The Codex data format changed in Codex 0.160.0");
    await expect(recent.locator(".ccc-list-row")).toHaveCount(0);
    // Plan usage is independent of the sessions section and keeps rendering.
    await expect(section(card, "Plan usage").locator("meter")).toHaveCount(1);
    await expect(card.locator(".ccc-card-footer")).toContainText("Partial");
  },
  "ready-partial-tokens": async (card) => {
    const week = card.getByRole("button", { name: "Last 7 days" });
    await week.click();
    await expect(week).toHaveAttribute("aria-pressed", "true");
    const tokens = section(card, "Token activity");
    await expect(tokens).toContainText("6.4M tokens");
    await expect(tokens).toContainText("Transcript analysis was off for part of this range.");
    await expect(tokens).toContainText("Codex session logs only go back to Sep 18");
    await expect(tokens.locator("[data-badge='partial']")).toHaveCount(1);
    await expect(card.locator(".ccc-card-footer")).toContainText("Partial");
  },
  "usage-unavailable": async (card) => {
    const plan = section(card, "Plan usage");
    await expect(plan).toContainText("Codex usage unavailable");
    await expect(plan).toContainText("Codex didn't answer the usage read.");
    // Unavailable is never zero: no digit, no percent sign, no bar, no tick.
    expect(await plan.innerText()).not.toMatch(/\d|%/);
    await expectNoBar(plan);
    await expect(codexCell(card)).toContainText("Held back");
    await expect(codexCell(card)).toContainText("Usage is unavailable.");
    expect(await codexCell(card).innerText()).not.toMatch(/\d|%/);
    await expect(card.locator(".ccc-card-footer")).toContainText("Partial");
  },
  "usage-outdated": async (card) => {
    const plan = section(card, "Plan usage");
    await expect(plan).toContainText("64% used before the Sep 22, 11:00 AM reset · outdated");
    await expectNoBar(plan);
    await expect(plan.locator(".ccc-reserve-legend")).toHaveCount(0);
    expect(await plan.innerText()).not.toMatch(/reserve line/);
    await expect(codexCell(card)).toContainText("Held back");
    await expect(codexCell(card)).toContainText("Usage is unavailable.");
  },
  empty: async (card) => {
    await expect(card).toHaveAttribute("data-presentation", "empty");
    await expect(card.locator("meter")).toHaveCount(0);
    await expect(card.locator(".ccc-reserve-tick")).toHaveCount(0);
    await expect(section(card, "Headroom")).toContainText("Headroom unavailable");
    await expect(section(card, "Plan usage")).toContainText("Codex usage unavailable");
    await expect(section(card, "Recent sessions")).toContainText("No Codex sessions yet");
    await expect(section(card, "Token activity")).toContainText("Transcript analysis is off");
  },
  loading: async (card) => {
    await expect(card).toHaveAttribute("data-presentation", "loading");
    await expect(card).toHaveAttribute("aria-busy", "true");
    await expect(card.locator(".ccc-visually-hidden").filter({ hasText: "Loading" })).toHaveText(
      "Loading Codex sessions and usage",
    );
    await expect(card.locator(".ccc-skeleton-line")).toHaveCount(3);
    await expect(card.locator("meter")).toHaveCount(0);
    expect(await card.innerText()).not.toMatch(/%/);
  },
  stale: async (card) => {
    await expect(card).toHaveAttribute("data-presentation", "stale");
    await expect(card.locator(".ccc-card-footer")).toContainText("Stale");
    await expect(codexCell(card)).toContainText("Held back");
    await expect(codexCell(card)).toContainText("Usage is unavailable.");
  },
  error: async (card) => {
    await expect(card).toHaveAttribute("data-presentation", "error");
    await expect(card).toContainText("Couldn't load Codex sessions and usage.");
    await expect(card).toContainText("Check the service in Settings → Diagnostics, then refresh.");
    await expect(card.locator("meter")).toHaveCount(0);
  },
  disconnected: async (card) => {
    await expect(card).toHaveAttribute("data-presentation", "disconnected");
    await expect(card.locator(".ccc-card-body")).toHaveAttribute("data-dimmed", "true");
    await expect(card).toContainText("Service disconnected");
    // No descriptor can be emitted: every action pill is aria-disabled (RR-05).
    const enabled = await card
      .locator(".ccc-row-action, .ccc-quick-action, .ccc-connect-button")
      .evaluateAll(
        (buttons) => buttons.filter((b) => b.getAttribute("aria-disabled") !== "true").length,
      );
    expect(enabled).toBe(0);
  },
  "setup-not-installed": async (card) => {
    await expect(card).toHaveAttribute("data-presentation", "permission-required");
    await expect(card).toContainText("Codex isn't set up");
    await expect(card.getByRole("button", { name: "Set up Codex" })).toBeEnabled();
    await expect(card.locator(".ccc-error-glyph")).toHaveCount(0);
    await expect(card.locator("meter")).toHaveCount(0);
  },
  "unavailable-format-changed": async (card) => {
    await expect(card).toHaveAttribute("data-presentation", "unavailable");
    await expect(card).toContainText("Codex tracking paused");
    await expect(card).toContainText(
      "The Codex data on this Mac is in a format this build doesn't recognise, so it's hidden rather than shown wrong.",
    );
    await expect(card.locator("meter")).toHaveCount(0);
  },
  "long-text": async (card) => {
    // The primary line clamps to two lines; the full text stays in the DOM and the title.
    const primary = card.locator(".ccc-list-primary").first();
    await expect(primary).toHaveCSS("-webkit-line-clamp", "2");
    const title = await primary.getAttribute("title");
    expect(title).toContain("Alpha-Bravo-Charlie-Delta-Echo-Foxtrot-Golf-Hotel-India-Juliet");
    expect(title?.length).toBeGreaterThan(90);
    expect(await primary.textContent()).toBe(title);
    await expect(section(card, "Plan usage")).toContainText(
      "Limit: Weekly-plan-limit-example-tier-012345678",
    );
    await expectNoHorizontalOverflow(card);
  },
};

const CARD_CASES = [
  "ready-mixed",
  "ready-over-reserve",
  "ready-fallback-source",
  "ready-analysis-off",
  "ready-partial-sessions",
  "ready-partial-tokens",
  "usage-unavailable",
  "usage-outdated",
  "empty",
  "loading",
  "stale",
  "error",
  "disconnected",
  "setup-not-installed",
  "unavailable-format-changed",
  "long-text",
] as const;

for (const caseId of CARD_CASES) {
  for (const pane of PANES) {
    cell(`codex — ${caseId} — ${pane}`, `codex-${caseId}--${pane}.png`, async (page, snapshot) => {
      const card = await openCodex(page, caseId, pane);
      await CASE_ASSERTIONS[caseId]?.(card, page);
      if (pane === "narrow") await expectNoHorizontalOverflow(card);
      await expect(card).toHaveScreenshot(snapshot);
    });
  }
}

// The reduced-motion cells (UI-SPEC accessibility floor 13). Nothing animates in
// this phase, so `data-motion="reduced"` must leave the card unchanged; pixels
// alone cannot prove that (`animations: "disabled"` finishes every transition
// before the shot), so each cell asserts through computed style that the meter
// fill, the reserve tick and the row action pills report no transition.
for (const pane of PANES) {
  cell(
    `codex — ready-mixed — ${pane} — reduced`,
    `codex-ready-mixed-reduced--${pane}.png`,
    async (page, snapshot) => {
      const card = await openCodex(page, "ready-mixed", pane, "reduced");
      await expectReadyMixed(card);
      await expect(card.locator(".ccc-reserve-meter")).toHaveCSS("transition-duration", "0s");
      await expect(card.locator(".ccc-reserve-tick")).toHaveCSS("transition-duration", "0s");
      await expect(card.locator(".ccc-row-action").first()).toHaveCSS("transition-duration", "0s");
      // The range pills ease two properties, so the computed list repeats the zero.
      await expect(card.locator(".ccc-range-pill").first()).toHaveCSS(
        "transition-duration",
        /^0s(, 0s)*$/,
      );
      await expect(card).toHaveScreenshot(snapshot);
    },
  );
}

// The 200 percent zoom cell (UI-SPEC accessibility floor 3): the root font size
// doubles while the pane keeps its pixel width, which is what browser zoom does
// to an Obsidian pane, so the card must wrap its text and clip nothing.
cell("codex — zoom-200 — narrow", "codex-zoom-200--narrow.png", async (page, snapshot) => {
  const card = await openCodex(page, "ready-mixed", "narrow");
  await page.evaluate(() => {
    const pane = document.querySelector("[data-pane]");
    if (!(pane instanceof HTMLElement)) throw new Error("the harness pane is missing");
    pane.style.width = `${pane.getBoundingClientRect().width}px`;
    document.documentElement.style.fontSize = "200%";
  });
  await expect(page.locator("html")).toHaveCSS("font-size", "32px");
  await fitViewportToCard(page);
  await expectReadyMixed(card);
  await expectNoHorizontalOverflow(card);
  await expect(card).toHaveScreenshot(snapshot);
});
