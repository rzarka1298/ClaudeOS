import { describe, expect, it } from "vitest";
import {
  canFitSideBySide,
  decideWideLayout,
  describeFit,
  FILL_TOLERANCE_PX,
  isWindowFilling,
  pickTargetRect,
  RIBBON_ALLOWANCE_PX,
} from "./window-fit.js";

/**
 * The decisions behind the full-size look shots (Phase 7 live-UAT trial, run da14049b): the trial
 * window stayed 1024 x 800 on a 1512 x 982 display, item 16 skipped and item 17 timed out.
 */

const WORK = { width: 1512, height: 944 };

describe("isWindowFilling", () => {
  it("accepts a window at the work area and one a few pixels short", () => {
    expect(isWindowFilling({ width: 1512, height: 944 }, WORK)).toBe(true);
    expect(isWindowFilling({ width: 1512 - FILL_TOLERANCE_PX, height: 900 }, WORK)).toBe(true);
  });

  it("rejects the trial's 1024 x 800 window on that display, and either axis alone", () => {
    expect(isWindowFilling({ width: 1024, height: 800 }, WORK)).toBe(false);
    expect(isWindowFilling({ width: 1512, height: 800 }, WORK)).toBe(false);
    expect(isWindowFilling({ width: 1024, height: 944 }, WORK)).toBe(false);
  });

  it("never counts an unknown work area as filled", () => {
    expect(isWindowFilling({ width: 1024, height: 800 }, { width: 0, height: 0 })).toBe(false);
  });
});

describe("canFitSideBySide", () => {
  it("is true when the work area less the ribbon reaches the breakpoint, and not a pixel earlier", () => {
    expect(canFitSideBySide(768 + RIBBON_ALLOWANCE_PX, 768)).toBe(true);
    expect(canFitSideBySide(768 + RIBBON_ALLOWANCE_PX - 1, 768)).toBe(false);
    expect(canFitSideBySide(1512, 768)).toBe(true);
  });
});

describe("decideWideLayout", () => {
  const base = { breakpointPx: 768, workAreaWidth: 1512, windowFilled: true };

  it("is wide when the grid reaches the breakpoint", () => {
    expect(decideWideLayout({ ...base, gridWidth: 1400 })).toEqual({ kind: "wide" });
    expect(decideWideLayout({ ...base, gridWidth: 768 })).toEqual({ kind: "wide" });
  });

  it("fails, not skips, a narrow grid on a display that could show it", () => {
    const verdict = decideWideLayout({ ...base, gridWidth: 640 });
    expect(verdict.kind).toBe("fail");
    expect(verdict).toMatchObject({
      reason: expect.stringMatching(/640 px.*768 px.*1512 px display/),
    });
  });

  it("says when the window never took the display's size", () => {
    const verdict = decideWideLayout({ ...base, gridWidth: 640, windowFilled: false });
    expect(verdict).toMatchObject({
      kind: "fail",
      reason: expect.stringMatching(/did not reach the size of a 1512 px display/),
    });
  });

  it("skips only when the screen itself is narrower than the breakpoint, and names the screen", () => {
    const verdict = decideWideLayout({
      gridWidth: 700,
      breakpointPx: 768,
      workAreaWidth: 800,
      windowFilled: true,
    });
    expect(verdict.kind).toBe("skip");
    expect(verdict).toMatchObject({ reason: expect.stringMatching(/800 CSS px.*768 px/) });
  });

  it("fails rather than skips when the display's size is unknown", () => {
    expect(
      decideWideLayout({
        gridWidth: 640,
        breakpointPx: 768,
        workAreaWidth: null,
        windowFilled: false,
      }).kind,
    ).toBe("fail");
  });
});

describe("pickTargetRect", () => {
  const none = { workArea: null, availWidth: 0, availHeight: 0 };

  it("prefers the Electron work area", () => {
    const workArea = { x: 0, y: 38, width: 1512, height: 944 };
    expect(pickTargetRect({ ...none, workArea, availWidth: 1000, availHeight: 700 })).toEqual(
      workArea,
    );
  });

  it("falls back to the page's screen numbers, then to leaving the window alone", () => {
    expect(pickTargetRect({ ...none, availWidth: 1600, availHeight: 900 })).toEqual({
      x: 0,
      y: 0,
      width: 1600,
      height: 900,
    });
    expect(pickTargetRect(none)).toBeNull();
    expect(pickTargetRect({ ...none, workArea: { x: 0, y: 0, width: 0, height: 0 } })).toBeNull();
  });
});

describe("describeFit", () => {
  it("states the window, the work area, the method and whether it filled", () => {
    expect(
      describeFit({
        method: "electron",
        workArea: { x: 0, y: 0, width: 1512, height: 944 },
        innerWidth: 1024,
        innerHeight: 800,
        filled: false,
      }),
    ).toBe("window 1024 x 800 (work area 1512 x 944, sized by electron, NOT filled)");
    expect(
      describeFit({
        method: "unchanged",
        workArea: null,
        innerWidth: 900,
        innerHeight: 700,
        filled: false,
      }),
    ).toContain("unknown work area");
  });
});
