import { assertShotInside, shotPath } from "../screenshots.js";
import {
  bringSubjectIntoView,
  maximizeCommandCenter,
  readAvailableScreen,
  recoverFocus,
  rememberFocus,
  restoreLayout,
  type ShotLayoutState,
} from "./shot-layout.js";

/**
 * The look capture of the research items (plan 07-17, D-11, 07-UAT items 15 and 16): the same
 * enlarge, scroll, shoot and restore sequence the Phase 6 look items use (cross-cutting.e2e.ts),
 * for a subject on the Research destination. The images go to the run's private shots folder only
 * and are deleted after review (WORKFLOW visual check); a failure fails the item, never swallowed.
 */

/** The slice of the wdio browser a capture uses. */
export interface ShotBrowser {
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
  setWindowRect(x: number, y: number, width: number, height: number): Promise<unknown>;
  maximizeWindow(): Promise<unknown>;
  pause(ms: number): Promise<unknown>;
  saveScreenshot(path: string): Promise<unknown>;
}

/** Time the enlarged layout gets to repaint before a screenshot. */
export const SHOT_SETTLE_MS = 500;

export interface LookInput {
  /** The run's private shots folder; absent means the look cannot be recorded. */
  readonly shotsDir: string | undefined;
  readonly item: number;
  /** Lowercase letters, digits and hyphens. */
  readonly label: string;
  readonly subject: { readonly selector: string; readonly block: "center" | "start" };
  /** The command center's view type, for the layout change. */
  readonly viewType: string;
  /** True to take the display's usable size and the widest command center; false for the pane as it is. */
  readonly enlarge: boolean;
}

type LayoutResult = ReturnType<typeof maximizeCommandCenter>;

/**
 * Takes the display's usable size and the widest command center, runs `during`, and puts the
 * layout and the focus back whatever `during` did. Throws before running it when the enlarged
 * layout would be clipped or focus moved.
 */
export async function withEnlargedLayout<T>(
  browser: ShotBrowser,
  viewType: string,
  during: () => Promise<T>,
): Promise<T> {
  const screen = await browser.execute(readAvailableScreen);
  if (screen.width > 0 && screen.height > 0) {
    try {
      await browser.setWindowRect(0, 0, screen.width, screen.height);
    } catch {
      await browser.maximizeWindow().catch(() => undefined);
    }
  }
  await browser.execute(rememberFocus);
  const layout: LayoutResult = await browser.execute(maximizeCommandCenter, viewType);
  try {
    if (!layout.fits) {
      throw new Error(
        `The command center would be clipped for the screenshot (right edge ${layout.rightEdge} of ${layout.innerWidth}).`,
      );
    }
    await browser.pause(SHOT_SETTLE_MS);
    if (!(await browser.execute(recoverFocus))) {
      throw new Error("Focus moved when the layout was enlarged for the screenshot.");
    }
    return await during();
  } finally {
    await browser.execute(restoreLayout, layout);
    await browser.execute(recoverFocus);
  }
}

/** The sidebars as they are now, to put back later with `restoreLayout`. */
export async function rememberLayout(
  browser: ShotBrowser,
  viewType: string,
): Promise<ShotLayoutState> {
  const { leftCollapsed, rightCollapsed, rightWidth, centerInRight } = await browser.execute(
    maximizeCommandCenter,
    viewType,
  );
  const state: ShotLayoutState = { leftCollapsed, rightCollapsed, rightWidth, centerInRight };
  await browser.execute(restoreLayout, state);
  return state;
}

/** Takes one look image; returns its label. */
export async function captureLook(browser: ShotBrowser, input: LookInput): Promise<string> {
  const dir = input.shotsDir;
  if (dir === undefined) throw new Error("No shots folder: a look item cannot record images.");
  const path = shotPath(dir, input.item, input.label);
  assertShotInside(dir, path);
  const shoot = async (): Promise<void> => {
    const seen = await browser.execute(
      bringSubjectIntoView,
      input.subject.selector,
      input.subject.block,
    );
    if (!seen.found || !seen.inView) {
      throw new Error(
        `The subject of the screenshot (${input.subject.selector}) is not on screen.`,
      );
    }
    await browser.saveScreenshot(path);
  };
  if (input.enlarge) await withEnlargedLayout(browser, input.viewType, shoot);
  else await shoot();
  return input.label;
}
