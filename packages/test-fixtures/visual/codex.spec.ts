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

for (const pane of PANES) {
  cell(
    `codex — ready-mixed — ${pane}`,
    `codex-ready-mixed--${pane}.png`,
    async (page, snapshot) => {
      const card = await openCodex(page, "ready-mixed", pane);
      await expect(card.locator("h4")).toHaveText([...SECTION_HEADINGS]);
      await expect(
        card.locator("[data-codex-section='recent-sessions'] .ccc-list-row"),
      ).toHaveCount(5);
      await expect(card).toHaveScreenshot(snapshot);
    },
  );
}
