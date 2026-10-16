import { describe, expect, it } from "vitest";
import { captureLook, type ShotBrowser } from "./research-shots.js";

/**
 * The look capture of the research items (plan 07-17, D-11, 07-UAT items 15 and 16): the same
 * enlarge, scroll, shoot and restore sequence as the Phase 6 look items, over a fake browser.
 */

function fake(
  over: { fits?: boolean; found?: boolean; inView?: boolean; focusKept?: boolean } = {},
) {
  const calls: string[] = [];
  const saved: string[] = [];
  let step = 0;
  const browser: ShotBrowser = {
    async execute(fn: (...args: never[]) => unknown, ...args: unknown[]) {
      step += 1;
      const name = (fn as { name?: string }).name ?? "";
      calls.push(`execute:${name}`);
      void step;
      void args;
      switch (name) {
        case "readAvailableScreen":
          return { width: 1600, height: 900 } as never;
        case "maximizeCommandCenter":
          return {
            leftCollapsed: false,
            rightCollapsed: false,
            rightWidth: 300,
            centerInRight: true,
            innerWidth: 1600,
            rightEdge: over.fits === false ? 1700 : 1590,
            fits: over.fits !== false,
          } as never;
        case "bringSubjectIntoView":
          return { found: over.found !== false, inView: over.inView !== false } as never;
        case "recoverFocus":
          return (over.focusKept !== false) as never;
        default:
          return true as never;
      }
    },
    async setWindowRect() {
      calls.push("setWindowRect");
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
  return { browser, calls, saved };
}

const SUBJECT = { selector: "article.ccc-report-reader", block: "start" } as const;

describe("captureLook", () => {
  it("enlarges the command center, scrolls the subject into view, saves the png and restores the layout", async () => {
    const { browser, calls, saved } = fake();
    const label = await captureLook(browser, {
      shotsDir: "/tmp/ccc-uat-shots-0123abcd",
      item: 15,
      label: "full-width",
      subject: SUBJECT,
      viewType: "claude-command-center-view",
      enlarge: true,
    });
    expect(label).toBe("full-width");
    expect(saved).toEqual(["/tmp/ccc-uat-shots-0123abcd/15-full-width.png"]);
    const order = calls.filter((call) =>
      ["saveScreenshot", "execute:restoreLayout", "execute:maximizeCommandCenter"].includes(call),
    );
    expect(order).toEqual([
      "execute:maximizeCommandCenter",
      "saveScreenshot",
      "execute:restoreLayout",
    ]);
    expect(calls).toContain("setWindowRect");
  });

  it("shoots a side-pane subject without touching the layout", async () => {
    const { browser, calls, saved } = fake();
    await captureLook(browser, {
      shotsDir: "/tmp/ccc-uat-shots-0123abcd",
      item: 15,
      label: "side-pane",
      subject: SUBJECT,
      viewType: "claude-command-center-view",
      enlarge: false,
    });
    expect(saved).toEqual(["/tmp/ccc-uat-shots-0123abcd/15-side-pane.png"]);
    expect(calls).not.toContain("execute:maximizeCommandCenter");
    expect(calls).not.toContain("execute:restoreLayout");
  });

  it("refuses without a shots folder, a bad label, a clipped layout, a missing subject and moved focus", async () => {
    const base = {
      item: 15,
      label: "full-width",
      subject: SUBJECT,
      viewType: "v",
      enlarge: true,
    } as const;
    await expect(captureLook(fake().browser, { ...base, shotsDir: undefined })).rejects.toThrow(
      /No shots folder/,
    );
    await expect(
      captureLook(fake().browser, { ...base, shotsDir: "/tmp/s", label: "Bad Label" }),
    ).rejects.toThrow(/label/);
    const clipped = fake({ fits: false });
    await expect(captureLook(clipped.browser, { ...base, shotsDir: "/tmp/s" })).rejects.toThrow(
      /clipped/,
    );
    expect(clipped.saved).toEqual([]);
    expect(clipped.calls).toContain("execute:restoreLayout");
    const missing = fake({ found: false });
    await expect(captureLook(missing.browser, { ...base, shotsDir: "/tmp/s" })).rejects.toThrow(
      /not on screen/,
    );
    expect(missing.calls).toContain("execute:restoreLayout");
    const moved = fake({ focusKept: false });
    await expect(captureLook(moved.browser, { ...base, shotsDir: "/tmp/s" })).rejects.toThrow(
      /Focus moved/,
    );
  });
});
