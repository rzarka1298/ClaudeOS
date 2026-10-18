import { assertShotInside, shotPath } from "../screenshots.js";
import {
  applyWindowBounds,
  bringSubjectIntoView,
  collapseSidebars,
  hideNotices,
  type MoveResult,
  maximizeCommandCenter,
  moveCommandCenterToMain,
  moveCommandCenterToSidebar,
  type RectLite,
  readShotLayout,
  readWindowFacts,
  recoverFocus,
  rememberFocus,
  restoreLayout,
  type ShotLayoutState,
  showNotices,
  type WindowFacts,
} from "./shot-layout.js";
import {
  describeFit,
  isWindowFilling,
  pickTargetRect,
  type WindowFit,
  type WindowRect,
} from "./window-fit.js";

/**
 * The look capture of the research items (plan 07-17, D-11, 07-UAT items 15 and 16): the same
 * enlarge, scroll, shoot and restore sequence the Phase 6 look items use (cross-cutting.e2e.ts),
 * for a subject on the Research destination. The images go to the run's private shots folder only
 * and are deleted after review (WORKFLOW visual check); a failure fails the item, never swallowed.
 *
 * Owner's standing instruction: "when you do the screenshots of obsidian make sure it is full
 * screen and the command center is as big as possible then take the screenshot". So before a
 * full-width shot the window takes the display's work area (Obsidian's own Electron window API,
 * then WebDriver, then maximize), the command center moves into the MAIN area with both sidebars
 * collapsed and the empty tab closed, and notices are dismissed; the side-pane shot keeps the
 * view in the right sidebar on purpose and only gets the bigger window. Everything is put back.
 */

/** The slice of the wdio browser a capture uses. */
export interface ShotBrowser {
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<Awaited<T>>;
  setWindowRect(x: number, y: number, width: number, height: number): Promise<unknown>;
  maximizeWindow(): Promise<unknown>;
  pause(ms: number): Promise<unknown>;
  saveScreenshot(path: string): Promise<unknown>;
}

/** Time the enlarged layout gets to repaint before a screenshot. */
export const SHOT_SETTLE_MS = 500;

/** How long the window gets to reach the work area, and how often it is asked. */
export const WINDOW_SETTLE_MS = 8_000;
export const WINDOW_POLL_MS = 250;

/**
 * Where the command center sits for a capture.
 * - `as-is`: untouched (the caller already set the layout up).
 * - `window`: the window takes the work area; the view stays where it is (the side-pane shot).
 * - `main`: the window takes the work area and the view moves to the main area, sidebars collapsed.
 */
export type Placement = "as-is" | "window" | "main";

export interface LookInput {
  /** The run's private shots folder; absent means the look cannot be recorded. */
  readonly shotsDir: string | undefined;
  readonly item: number;
  /** Lowercase letters, digits and hyphens. */
  readonly label: string;
  readonly subject: { readonly selector: string; readonly block: "center" | "start" };
  /** The command center's view type, for the layout change. */
  readonly viewType: string;
  /** Where the view sits for this shot. */
  readonly placement: Placement;
  /** Reopens what the view was showing after it is recreated (main placement only). */
  readonly reopen?: (() => Promise<void>) | undefined;
}

/** What `during` is told about the layout it runs in. */
export interface EnlargeContext {
  readonly fit: WindowFit;
  /** True when the command center is a main-area tab. */
  readonly inMainArea: boolean;
}

export interface EnlargeOptions {
  /** `main` (default) moves the view to the main area; `in-place` keeps it in its sidebar and widens that. */
  readonly place?: "main" | "in-place";
  /** Reopens what the view was showing after it is recreated, in the main area and back in the sidebar. */
  readonly reopen?: (() => Promise<void>) | undefined;
}

function toWindowRect(rect: RectLite | null): WindowRect | null {
  return rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Where the window was, to put it back: Electron's bounds when it answered, else the page's own numbers. */
function originalRect(before: WindowFacts): RectLite | null {
  if (before.bounds !== null) return before.bounds;
  if (before.outerWidth > 0 && before.outerHeight > 0) {
    return {
      x: before.screenX,
      y: before.screenY,
      width: before.outerWidth,
      height: before.outerHeight,
    };
  }
  return null;
}

/**
 * Gives the window the display's work area and waits for it to take it. Obsidian's own Electron
 * window API goes first (setBounds, the way wdio-obsidian-service sizes it); WebDriver's
 * setWindowRect and then maximize are the fallbacks. Returns what happened and how to undo it.
 * It never throws for a window that stayed small: `fit.filled` says so and the caller decides
 * (a skip only when the display itself is too small, a failure otherwise).
 */
export async function fitWindowToWorkArea(
  browser: ShotBrowser,
): Promise<{ fit: WindowFit; restore: () => Promise<void> }> {
  const before = await browser.execute(readWindowFacts);
  const target = pickTargetRect(before);
  const original = originalRect(before);
  let method: WindowFit["method"] = "unchanged";
  const settle = async (): Promise<WindowFacts> => {
    let facts = await browser.execute(readWindowFacts);
    for (let waited = 0; waited < WINDOW_SETTLE_MS; waited += WINDOW_POLL_MS) {
      if (
        target === null ||
        isWindowFilling({ width: facts.innerWidth, height: facts.innerHeight }, target)
      ) {
        break;
      }
      await browser.pause(WINDOW_POLL_MS);
      facts = await browser.execute(readWindowFacts);
    }
    return facts;
  };
  let after = before;
  if (target !== null) {
    if (before.via === "electron") {
      const applied = await browser.execute(applyWindowBounds, target, false).catch(() => false);
      if (applied) method = "electron";
    }
    if (method === "unchanged") {
      try {
        await browser.setWindowRect(target.x, target.y, target.width, target.height);
        method = "webdriver";
      } catch {
        method = "unchanged";
      }
    }
    after = await settle();
    if (!isWindowFilling({ width: after.innerWidth, height: after.innerHeight }, target)) {
      if (
        (await browser.maximizeWindow().then(
          () => true,
          () => false,
        )) === true
      ) {
        method = "maximize";
        after = await settle();
      }
    }
  }
  const filled =
    target !== null &&
    isWindowFilling({ width: after.innerWidth, height: after.innerHeight }, target);
  const fit: WindowFit = {
    method,
    workArea: toWindowRect(target),
    innerWidth: after.innerWidth,
    innerHeight: after.innerHeight,
    filled,
  };
  const restore = async (): Promise<void> => {
    if (method === "unchanged" || original === null) return;
    if (method === "electron") {
      await browser.execute(applyWindowBounds, original, before.maximized).catch(() => false);
    } else {
      await browser
        .setWindowRect(original.x, original.y, original.width, original.height)
        .catch(() => undefined);
    }
  };
  return { fit, restore };
}

/**
 * Runs `during` with the window at the display's work area, the command center where `place`
 * says, both sidebars collapsed and notices dismissed; then puts the layout, the view and the
 * window back whatever `during` did. Throws before running it when the in-place layout would be
 * clipped, focus moved, or the command center could not be moved.
 */
export async function withEnlargedLayout<T>(
  browser: ShotBrowser,
  viewType: string,
  during: (context: EnlargeContext) => Promise<T>,
  options: EnlargeOptions = {},
): Promise<T> {
  const place = options.place ?? "main";
  const { fit, restore: restoreWindow } = await fitWindowToWorkArea(browser);
  const layoutBefore = await browser.execute(readShotLayout, viewType);
  let moved: MoveResult | null = null;
  try {
    if (place === "main") {
      moved = await browser.execute(moveCommandCenterToMain, viewType);
      if (!moved.ok)
        throw new Error(`Cannot place the command center for the screenshot: ${moved.reason}`);
      await browser.execute(collapseSidebars);
      await options.reopen?.();
    } else {
      await browser.execute(rememberFocus);
      const layout = await browser.execute(maximizeCommandCenter, viewType);
      if (!layout.fits) {
        throw new Error(
          `The command center would be clipped for the screenshot (right edge ${layout.rightEdge} of ${layout.innerWidth}; ${describeFit(fit)}).`,
        );
      }
    }
    await browser.pause(SHOT_SETTLE_MS);
    if (place === "in-place" && !(await browser.execute(recoverFocus))) {
      throw new Error("Focus moved when the layout was enlarged for the screenshot.");
    }
    await browser.execute(hideNotices);
    return await during({ fit, inMainArea: moved?.moved === true });
  } finally {
    await browser.execute(showNotices).catch(() => false);
    try {
      if (moved?.moved === true) {
        await browser.execute(moveCommandCenterToSidebar, viewType, moved.closedEmpty);
      }
      await browser.execute(restoreLayout, layoutBefore);
      if (moved?.moved === true) await options.reopen?.();
      if (place === "in-place") await browser.execute(recoverFocus);
    } finally {
      await restoreWindow();
    }
  }
}

/**
 * Runs `during` with the window at the display's work area and the view where it is (the
 * side-pane shot), notices dismissed; the window goes back afterwards.
 */
export async function withMaximizedWindow<T>(
  browser: ShotBrowser,
  during: (context: EnlargeContext) => Promise<T>,
): Promise<T> {
  const { fit, restore } = await fitWindowToWorkArea(browser);
  try {
    await browser.pause(SHOT_SETTLE_MS);
    await browser.execute(hideNotices);
    return await during({ fit, inMainArea: false });
  } finally {
    await browser.execute(showNotices).catch(() => false);
    await restore();
  }
}

/** The sidebars as they are now, to put back later with `restoreLayout`. */
export async function rememberLayout(
  browser: ShotBrowser,
  viewType: string,
): Promise<ShotLayoutState> {
  return browser.execute(readShotLayout, viewType);
}

/** Takes one look image; returns its label. */
export async function captureLook(browser: ShotBrowser, input: LookInput): Promise<string> {
  const dir = input.shotsDir;
  if (dir === undefined) throw new Error("No shots folder: a look item cannot record images.");
  const path = shotPath(dir, input.item, input.label);
  assertShotInside(dir, path);
  const shoot = async (context?: EnlargeContext): Promise<void> => {
    // Notices are dismissed before every capture, in a layout the caller set up as well.
    await browser.execute(hideNotices);
    try {
      const seen = await browser.execute(
        bringSubjectIntoView,
        input.subject.selector,
        input.subject.block,
      );
      if (!seen.found || !seen.inView) {
        const fit = context === undefined ? "" : ` ${describeFit(context.fit)}`;
        throw new Error(
          `The subject of the screenshot (${input.subject.selector}) is not on screen.${fit}`,
        );
      }
      await browser.saveScreenshot(path);
    } finally {
      if (input.placement === "as-is") await browser.execute(showNotices).catch(() => false);
    }
  };
  if (input.placement === "main") {
    await withEnlargedLayout(browser, input.viewType, shoot, { reopen: input.reopen });
  } else if (input.placement === "window") {
    await withMaximizedWindow(browser, shoot);
  } else {
    await shoot();
  }
  return input.label;
}
