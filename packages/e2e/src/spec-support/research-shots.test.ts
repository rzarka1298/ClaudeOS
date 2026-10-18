import { describe, expect, it } from "vitest";
import {
  captureLook,
  fitWindowToWorkArea,
  rememberLayout,
  type ShotBrowser,
  withEnlargedLayout,
  withMaximizedWindow,
} from "./research-shots.js";
import type { RectLite, WindowFacts } from "./shot-layout.js";

/**
 * The look capture of the research items (plan 07-17, D-11, 07-UAT items 15 and 16) and the
 * full-size layout the owner asked for after the Phase 7 trial (run da14049b): the window takes the
 * display's work area, the command center sits in the main area with both sidebars collapsed,
 * notices are dismissed, and everything is put back. A fake browser stands in for wdio and records
 * the order of what it was asked to do.
 */

const WORK_AREA: RectLite = { x: 0, y: 38, width: 1512, height: 944 };
const SMALL_WINDOW: RectLite = { x: 100, y: 100, width: 1024, height: 800 };

interface Over {
  /** The window API sizes the window (default true). */
  electron?: boolean;
  /** The window stays at its small size whatever it is asked (default false). */
  stuck?: boolean;
  fits?: boolean;
  found?: boolean;
  inView?: boolean;
  focusKept?: boolean;
  moveOk?: boolean;
}

function fake(over: Over = {}) {
  const calls: string[] = [];
  const saved: string[] = [];
  const bounds: RectLite[] = [];
  let window: RectLite = { ...SMALL_WINDOW };
  const facts = (): WindowFacts => ({
    via: over.electron === false ? "screen" : "electron",
    bounds: over.electron === false ? null : { ...window },
    workArea: over.electron === false ? null : WORK_AREA,
    maximized: false,
    availWidth: WORK_AREA.width,
    availHeight: WORK_AREA.height,
    innerWidth: window.width,
    innerHeight: window.height,
    screenX: window.x,
    screenY: window.y,
    outerWidth: window.width,
    outerHeight: window.height,
  });
  const browser: ShotBrowser = {
    async execute(fn: (...args: never[]) => unknown, ...args: unknown[]) {
      const name = (fn as { name?: string }).name ?? "";
      calls.push(`execute:${name}`);
      switch (name) {
        case "readWindowFacts":
          return facts() as never;
        case "applyWindowBounds": {
          const rect = args[0] as RectLite;
          bounds.push(rect);
          if (over.stuck !== true) window = { ...rect };
          return true as never;
        }
        case "readShotLayout":
          return {
            leftCollapsed: false,
            rightCollapsed: false,
            rightWidth: 300,
            centerInRight: true,
          } as never;
        case "moveCommandCenterToMain":
          return (
            over.moveOk === false
              ? {
                  ok: false,
                  moved: false,
                  closedEmpty: 0,
                  reason: "The command center is not open.",
                }
              : { ok: true, moved: true, closedEmpty: 1, reason: "Moved to the main area." }
          ) as never;
        case "maximizeCommandCenter":
          return {
            leftCollapsed: false,
            rightCollapsed: false,
            rightWidth: 300,
            centerInRight: true,
            innerWidth: window.width,
            rightEdge: over.fits === false ? window.width + 100 : window.width - 10,
            fits: over.fits !== false,
          } as never;
        case "bringSubjectIntoView":
          return { found: over.found !== false, inView: over.inView !== false } as never;
        case "recoverFocus":
          return (over.focusKept !== false) as never;
        case "hideNotices":
          return 2 as never;
        default:
          return true as never;
      }
    },
    async setWindowRect(x: number, y: number, width: number, height: number) {
      calls.push("setWindowRect");
      bounds.push({ x, y, width, height });
      if (over.stuck !== true) window = { x, y, width, height };
      return {};
    },
    async maximizeWindow() {
      calls.push("maximizeWindow");
      return {};
    },
    async pause() {
      calls.push("pause");
    },
    async saveScreenshot(path: string) {
      calls.push("saveScreenshot");
      saved.push(path);
    },
  };
  return { browser, calls, saved, bounds, windowNow: () => window };
}

const SUBJECT = { selector: "article.ccc-report-reader", block: "start" } as const;
const BASE = {
  shotsDir: "/tmp/ccc-uat-shots-0123abcd",
  item: 15,
  label: "full-width",
  subject: SUBJECT,
  viewType: "v",
} as const;

/** The calls that matter, in order, with the pauses and reads left out. */
function sequence(calls: readonly string[], keep: readonly string[]): string[] {
  return calls.filter((call) => keep.includes(call));
}

describe("fitWindowToWorkArea", () => {
  it("gives the window the display's work area through Electron's window API and puts the old bounds back", async () => {
    const { browser, bounds, windowNow, calls } = fake();
    const { fit, restore } = await fitWindowToWorkArea(browser);
    expect(fit).toMatchObject({ method: "electron", filled: true, innerWidth: 1512 });
    expect(fit.workArea).toEqual(WORK_AREA);
    expect(bounds).toEqual([WORK_AREA]);
    expect(calls).not.toContain("setWindowRect");
    await restore();
    expect(bounds.at(-1)).toEqual(SMALL_WINDOW);
    expect(windowNow()).toEqual(SMALL_WINDOW);
  });

  it("falls back to WebDriver's window rect when the page has no Electron window API", async () => {
    const { browser, bounds } = fake({ electron: false });
    const { fit, restore } = await fitWindowToWorkArea(browser);
    expect(fit.method).toBe("webdriver");
    expect(fit.filled).toBe(true);
    // The page's own screen numbers were the target, and the outer size the way back.
    expect(bounds).toEqual([{ x: 0, y: 0, width: 1512, height: 944 }]);
    await restore();
    expect(bounds.at(-1)).toEqual(SMALL_WINDOW);
  });

  it("tries maximize, then reports a window that stayed small instead of pretending", async () => {
    const { browser, calls } = fake({ stuck: true });
    const { fit } = await fitWindowToWorkArea(browser);
    expect(calls).toContain("maximizeWindow");
    expect(fit.filled).toBe(false);
    expect(fit.innerWidth).toBe(1024);
  });
});

describe("captureLook", () => {
  it("sizes the window, moves the view to the main area, dismisses notices, saves the png and puts it all back", async () => {
    const { browser, calls, saved } = fake();
    const label = await captureLook(browser, {
      ...BASE,
      placement: "main",
      reopen: async () => {
        calls.push("reopen");
      },
    });
    expect(label).toBe("full-width");
    expect(saved).toEqual(["/tmp/ccc-uat-shots-0123abcd/15-full-width.png"]);
    expect(
      sequence(calls, [
        "execute:applyWindowBounds",
        "execute:moveCommandCenterToMain",
        "execute:collapseSidebars",
        "reopen",
        "execute:hideNotices",
        "saveScreenshot",
        "execute:showNotices",
        "execute:moveCommandCenterToSidebar",
        "execute:restoreLayout",
      ]),
    ).toEqual([
      "execute:applyWindowBounds",
      "execute:moveCommandCenterToMain",
      "execute:collapseSidebars",
      "reopen",
      "execute:hideNotices",
      "execute:hideNotices",
      "saveScreenshot",
      "execute:showNotices",
      "execute:moveCommandCenterToSidebar",
      "execute:restoreLayout",
      "reopen",
      // the window's own restore comes last
      "execute:applyWindowBounds",
    ]);
  });

  it("shoots the side pane in a window at the display's size without moving the view", async () => {
    const { browser, calls, saved, windowNow } = fake();
    await captureLook(browser, { ...BASE, label: "side-pane", placement: "window" });
    expect(saved).toEqual(["/tmp/ccc-uat-shots-0123abcd/15-side-pane.png"]);
    expect(calls).not.toContain("execute:moveCommandCenterToMain");
    expect(calls).not.toContain("execute:maximizeCommandCenter");
    expect(calls).toContain("execute:applyWindowBounds");
    expect(calls).toContain("execute:hideNotices");
    expect(windowNow()).toEqual(SMALL_WINDOW);
  });

  it("shoots a layout the caller set up as it is, still dismissing notices", async () => {
    const { browser, calls } = fake();
    await captureLook(browser, { ...BASE, placement: "as-is" });
    expect(calls).not.toContain("execute:applyWindowBounds");
    expect(calls).not.toContain("execute:moveCommandCenterToMain");
    expect(
      sequence(calls, ["execute:hideNotices", "saveScreenshot", "execute:showNotices"]),
    ).toEqual(["execute:hideNotices", "saveScreenshot", "execute:showNotices"]);
  });

  it("refuses without a shots folder, a bad label and a missing subject, restoring everything", async () => {
    const base = { ...BASE, placement: "main" } as const;
    await expect(captureLook(fake().browser, { ...base, shotsDir: undefined })).rejects.toThrow(
      /No shots folder/,
    );
    await expect(
      captureLook(fake().browser, { ...base, shotsDir: "/tmp/s", label: "Bad Label" }),
    ).rejects.toThrow(/label/);
    const missing = fake({ found: false });
    await expect(captureLook(missing.browser, { ...base, shotsDir: "/tmp/s" })).rejects.toThrow(
      /not on screen.*window 1512 x 944/,
    );
    expect(missing.saved).toEqual([]);
    expect(missing.calls).toContain("execute:moveCommandCenterToSidebar");
    expect(missing.calls).toContain("execute:restoreLayout");
    expect(missing.windowNow()).toEqual(SMALL_WINDOW);
  });
});

describe("withEnlargedLayout", () => {
  it("runs the body in the main area between moving and restoring, and restores when the body throws", async () => {
    const { browser, calls, windowNow } = fake();
    const seen: unknown[] = [];
    const result = await withEnlargedLayout(
      browser,
      "v",
      async (context) => {
        calls.push("body");
        seen.push(context.inMainArea, context.fit.filled);
        return 42;
      },
      { reopen: async () => void calls.push("reopen") },
    );
    expect(result).toBe(42);
    expect(seen).toEqual([true, true]);
    expect(
      sequence(calls, [
        "execute:moveCommandCenterToMain",
        "body",
        "execute:moveCommandCenterToSidebar",
        "execute:restoreLayout",
      ]),
    ).toEqual([
      "execute:moveCommandCenterToMain",
      "body",
      "execute:moveCommandCenterToSidebar",
      "execute:restoreLayout",
    ]);
    expect(windowNow()).toEqual(SMALL_WINDOW);
    const failing = fake();
    await expect(
      withEnlargedLayout(failing.browser, "v", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(failing.calls).toContain("execute:moveCommandCenterToSidebar");
    expect(failing.calls).toContain("execute:showNotices");
    expect(failing.windowNow()).toEqual(SMALL_WINDOW);
  });

  it("does not run the body when the command center cannot be moved, and still puts the window back", async () => {
    const { browser, calls, windowNow } = fake({ moveOk: false });
    let ran = false;
    await expect(
      withEnlargedLayout(browser, "v", async () => {
        ran = true;
      }),
    ).rejects.toThrow(/not open/);
    expect(ran).toBe(false);
    expect(calls).not.toContain("execute:moveCommandCenterToSidebar");
    expect(windowNow()).toEqual(SMALL_WINDOW);
  });

  it("keeps the old in-place widening when asked, and refuses a clipped layout or moved focus", async () => {
    const inPlace = fake();
    await withEnlargedLayout(inPlace.browser, "v", async () => undefined, { place: "in-place" });
    expect(inPlace.calls).toContain("execute:maximizeCommandCenter");
    expect(inPlace.calls).not.toContain("execute:moveCommandCenterToMain");
    const clipped = fake({ fits: false });
    let ran = false;
    await expect(
      withEnlargedLayout(
        clipped.browser,
        "v",
        async () => {
          ran = true;
        },
        { place: "in-place" },
      ),
    ).rejects.toThrow(/clipped/);
    expect(ran).toBe(false);
    expect(clipped.calls).toContain("execute:restoreLayout");
    const moved = fake({ focusKept: false });
    await expect(
      withEnlargedLayout(moved.browser, "v", async () => undefined, { place: "in-place" }),
    ).rejects.toThrow(/Focus moved/);
  });

  it("tells the body how the window was sized, so a window that stayed small is visible to it", async () => {
    const { browser } = fake({ stuck: true });
    const fit = await withEnlargedLayout(browser, "v", async (context) => context.fit);
    expect(fit.filled).toBe(false);
    expect(fit.workArea).toEqual(WORK_AREA);
  });
});

describe("withMaximizedWindow", () => {
  it("sizes the window and dismisses notices around the body, then puts the window back", async () => {
    const { browser, calls, windowNow } = fake();
    await withMaximizedWindow(browser, async () => {
      calls.push("body");
    });
    expect(sequence(calls, ["execute:hideNotices", "body", "execute:showNotices"])).toEqual([
      "execute:hideNotices",
      "body",
      "execute:showNotices",
    ]);
    expect(windowNow()).toEqual(SMALL_WINDOW);
  });
});

describe("rememberLayout", () => {
  it("reads the layout without changing it", async () => {
    const { browser, calls } = fake();
    const state = await rememberLayout(browser, "v");
    expect(state).toEqual({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: 300,
      centerInRight: true,
    });
    expect(calls).toEqual(["execute:readShotLayout"]);
  });
});
