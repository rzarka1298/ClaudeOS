import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bringSubjectIntoView,
  maximizeCommandCenter,
  readAvailableScreen,
  recoverFocus,
  rememberFocus,
  restoreLayout,
} from "./shot-layout.js";

function dock(collapsed: boolean, width: number, offset = 0) {
  const dockState = {
    collapsed,
    width,
    collapse() {
      dockState.collapsed = true;
    },
    expand() {
      dockState.collapsed = false;
    },
    setSize(size: number) {
      dockState.width = size;
    },
    containerEl: {
      getBoundingClientRect: () => ({
        width: dockState.width,
        right: offset + dockState.width,
      }),
    },
  };
  return dockState;
}

function install(
  centerRight: boolean,
  leftCollapsed = false,
  rightCollapsed = false,
  rightOffset = 0,
) {
  const left = dock(leftCollapsed, 200);
  const right = dock(rightCollapsed, 350, rightOffset);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector.includes("ribbon") ? { getBoundingClientRect: () => ({ width: 40 }) } : null,
  });
  const resizes: string[] = [];
  vi.stubGlobal("app", {
    workspace: {
      leftSplit: left,
      rightSplit: right,
      getLeavesOfType: () => [{ getRoot: () => (centerRight ? right : {}) }],
      requestResize: () => resizes.push("request"),
      trigger: (name: string) => resizes.push(name),
    },
  });
  return { left, right, resizes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shot layout", () => {
  it("reads the display's available size", () => {
    vi.stubGlobal("screen", { availWidth: 1800, availHeight: 1000 });
    expect(readAvailableScreen()).toEqual({ width: 1800, height: 1000 });
  });

  it("collapses the left sidebar and widens the right one that holds the command center, then restores both", () => {
    const { left, right, resizes } = install(true);
    const state = maximizeCommandCenter("ccc-view");
    expect(left.collapsed).toBe(true);
    expect(right.collapsed).toBe(false);
    expect(right.width).toBe(956);
    expect(state).toMatchObject({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: 350,
      centerInRight: true,
      innerWidth: 1000,
      fits: true,
    });
    expect(resizes).toContain("resize");
    restoreLayout(state);
    expect(left.collapsed).toBe(false);
    expect(right.width).toBe(350);
  });

  it("narrows the right sidebar until its right edge is inside the window", () => {
    const { right } = install(true, false, false, 120);
    const state = maximizeCommandCenter("ccc-view");
    expect(state.fits).toBe(true);
    expect(state.rightEdge).toBeLessThanOrEqual(1000);
    expect(right.width).toBeLessThan(956);
  });

  it("reports a layout that cannot fit instead of hiding it", () => {
    install(true, false, false, 5000);
    expect(maximizeCommandCenter("ccc-view").fits).toBe(false);
  });

  it("collapses the right sidebar when the command center is elsewhere, and restores a collapsed one as collapsed", () => {
    const { left, right } = install(false, true, true);
    const state = maximizeCommandCenter("ccc-view");
    expect(right.collapsed).toBe(true);
    expect(state.leftCollapsed).toBe(true);
    restoreLayout(state);
    expect(left.collapsed).toBe(true);
    expect(right.collapsed).toBe(true);
  });

  it("puts focus back on the remembered element when the layout change moved it", () => {
    const element = { focus: vi.fn(), isConnected: true };
    const doc = { activeElement: element as unknown };
    vi.stubGlobal("document", doc);
    expect(rememberFocus()).toBe(true);
    doc.activeElement = null;
    element.focus.mockImplementation(() => {
      doc.activeElement = element;
    });
    expect(recoverFocus()).toBe(true);
    expect(element.focus).toHaveBeenCalledTimes(1);
  });
});

describe("bringSubjectIntoView", () => {
  it("scrolls the element in and says whether it is on screen", () => {
    const scrolled: string[] = [];
    const element = {
      scrollIntoView: (options: { block: string }) => scrolled.push(options.block),
      getBoundingClientRect: () => ({ top: 100, bottom: 200, left: 10, right: 300 }),
    };
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("document", { querySelector: () => element, activeElement: element });
    expect(bringSubjectIntoView(".x", "center")).toEqual({ found: true, inView: true });
    expect(bringSubjectIntoView(":focus", "start")).toEqual({ found: true, inView: true });
    expect(scrolled).toEqual(["center", "start"]);
  });

  it("flags a subject outside the window, and a missing one", () => {
    const element = {
      scrollIntoView: () => undefined,
      getBoundingClientRect: () => ({ top: 100, bottom: 200, left: 10, right: 1300 }),
    };
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("document", { querySelector: () => element });
    expect(bringSubjectIntoView(".x", "center").inView).toBe(false);
    vi.stubGlobal("document", { querySelector: () => null });
    expect(bringSubjectIntoView(".x", "center")).toEqual({ found: false, inView: false });
  });
});
