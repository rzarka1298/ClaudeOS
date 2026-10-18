/**
 * The pure decisions behind the full-size look screenshots (Phase 7 live-UAT trial, run da14049b).
 *
 * The owner's standing instruction: "when you do the screenshots of obsidian make sure it is full
 * screen and the command center is as big as possible then take the screenshot". In the trial the
 * sandboxed window stayed at about 1024 x 800 CSS px on a display of about 1512 x 982, so the
 * "full-width" shots were a 640 px pane beside an empty tab, the side-by-side layout never
 * measured (item 16 skipped, item 17 timed out). These functions say, from numbers the renderer
 * reports, whether the window reached the display's work area and whether a layout that did not
 * go side by side is the display's limit (a skip, said out loud) or a layout fault (a failure).
 * No DOM, no wdio: they are unit-tested.
 */

export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How far the window's inner size may fall short of the work area and still count as filling it,
 * in CSS px. Obsidian draws its own title row inside the window, and the window manager may keep a
 * few pixels for a border or a shadow; a window short of the work area by more than this did not
 * take the size it was given.
 */
export const FILL_TOLERANCE_PX = 64;

/**
 * The room to the left of the command center the layout cannot give back: the ribbon, in CSS px
 * (it is 44 wide; the rest is slack for the view's own padding).
 */
export const RIBBON_ALLOWANCE_PX = 56;

/** True when the window's inner size is within {@link FILL_TOLERANCE_PX} of the work area. */
export function isWindowFilling(
  inner: { readonly width: number; readonly height: number },
  workArea: { readonly width: number; readonly height: number },
  tolerance: number = FILL_TOLERANCE_PX,
): boolean {
  return (
    workArea.width > 0 &&
    workArea.height > 0 &&
    inner.width >= workArea.width - tolerance &&
    inner.height >= workArea.height - tolerance
  );
}

/**
 * True when the display could show a command center this wide at all: its work area, less the
 * ribbon, reaches the breakpoint. Below it no window size could make the layout go side by side.
 */
export function canFitSideBySide(workAreaWidth: number, breakpointPx: number): boolean {
  return workAreaWidth - RIBBON_ALLOWANCE_PX >= breakpointPx;
}

export type WideLayoutVerdict =
  | { readonly kind: "wide" }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

/**
 * What to do with a measured full-width layout.
 *
 * - `wide`: the grid is at least the breakpoint wide.
 * - `skip`: it is not, and the display's own work area is too narrow for it to be; the only case
 *   an item may skip, and the reason names the screen so the skip is never silent.
 * - `fail`: it is not wide although the display is big enough, or the window never took the work
 *   area's size: the layout (or the window sizing) is at fault and the item fails.
 */
export function decideWideLayout(input: {
  readonly gridWidth: number;
  readonly breakpointPx: number;
  readonly workAreaWidth: number | null;
  readonly windowFilled: boolean;
}): WideLayoutVerdict {
  if (input.gridWidth >= input.breakpointPx) return { kind: "wide" };
  const known = input.workAreaWidth;
  if (known !== null && known > 0 && !canFitSideBySide(known, input.breakpointPx)) {
    return {
      kind: "skip",
      reason: `The display's usable width is ${Math.round(known)} CSS px, narrower than the ${Math.round(
        input.breakpointPx,
      )} px the side-by-side layout needs plus the ribbon, so it cannot be shown on this screen.`,
    };
  }
  const size = known === null ? "an unknown display" : `a ${Math.round(known)} px display`;
  return {
    kind: "fail",
    reason: input.windowFilled
      ? `The command center measured ${Math.round(input.gridWidth)} px, under the ${Math.round(
          input.breakpointPx,
        )} px breakpoint, in a window that fills ${size}.`
      : `The window did not reach the size of ${size}, and the command center measured ${Math.round(
          input.gridWidth,
        )} px, under the ${Math.round(input.breakpointPx)} px breakpoint.`,
  };
}

/** What the window sizing did, for the failure messages and the item notes. */
export interface WindowFit {
  /** How the window was sized: the Electron window API, WebDriver, or not at all. */
  readonly method: "electron" | "webdriver" | "maximize" | "unchanged";
  readonly workArea: WindowRect | null;
  readonly innerWidth: number;
  readonly innerHeight: number;
  /** True when the inner size reached the work area (within the tolerance). */
  readonly filled: boolean;
}

/** One line for a thrown error or a log. */
export function describeFit(fit: WindowFit): string {
  const area =
    fit.workArea === null
      ? "unknown work area"
      : `work area ${Math.round(fit.workArea.width)} x ${Math.round(fit.workArea.height)}`;
  return `window ${Math.round(fit.innerWidth)} x ${Math.round(fit.innerHeight)} (${area}, sized by ${fit.method}, ${
    fit.filled ? "filled" : "NOT filled"
  })`;
}

/**
 * The rectangle to give the window: the work area when it is known, else what the renderer's own
 * `screen` object reports as available, else null (leave the window alone).
 */
export function pickTargetRect(facts: {
  readonly workArea: WindowRect | null;
  readonly availWidth: number;
  readonly availHeight: number;
}): WindowRect | null {
  if (facts.workArea !== null && facts.workArea.width > 0 && facts.workArea.height > 0) {
    return facts.workArea;
  }
  if (facts.availWidth > 0 && facts.availHeight > 0) {
    return { x: 0, y: 0, width: facts.availWidth, height: facts.availHeight };
  }
  return null;
}
