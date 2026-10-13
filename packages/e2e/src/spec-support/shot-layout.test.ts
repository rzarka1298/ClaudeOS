import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maximizeCommandCenter,
  readAvailableScreen,
  recoverFocus,
  rememberFocus,
  restoreLayout,
} from "./shot-layout.js";

function dock(collapsed: boolean, width: number) {
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
      getBoundingClientRect: () => ({ width: dockState.width }),
    },
  };
  return dockState;
}

function install(centerRight: boolean, leftCollapsed = false, rightCollapsed = false) {
  const left = dock(leftCollapsed, 200);
  const right = dock(rightCollapsed, 350);
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
    const state = maximizeCommandCenter("ccc-view", 1500);
    expect(left.collapsed).toBe(true);
    expect(right.collapsed).toBe(false);
    expect(right.width).toBe(1500);
    expect(state).toEqual({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: 350,
      centerInRight: true,
    });
    expect(resizes).toContain("resize");
    restoreLayout(state);
    expect(left.collapsed).toBe(false);
    expect(right.width).toBe(350);
  });

  it("collapses the right sidebar when the command center is elsewhere, and restores a collapsed one as collapsed", () => {
    const { left, right } = install(false, true, true);
    const state = maximizeCommandCenter("ccc-view", 1500);
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
