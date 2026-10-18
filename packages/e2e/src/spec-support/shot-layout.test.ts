import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyWindowBounds,
  bringSubjectIntoView,
  collapseSidebars,
  hideNotices,
  maximizeCommandCenter,
  moveCommandCenterToMain,
  moveCommandCenterToSidebar,
  readAvailableScreen,
  readShotLayout,
  readWindowFacts,
  recoverFocus,
  rememberFocus,
  restoreLayout,
  showNotices,
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

describe("readWindowFacts and applyWindowBounds", () => {
  function electron(maximized = false) {
    const win = {
      bounds: { x: 10, y: 20, width: 1024, height: 800 },
      maximized,
      unmaximized: 0,
      remaximized: 0,
      getBounds() {
        return win.bounds;
      },
      setBounds(next: { x: number; y: number; width: number; height: number }) {
        win.bounds = next;
      },
      isMaximized() {
        return win.maximized;
      },
      unmaximize() {
        win.unmaximized += 1;
        win.maximized = false;
      },
      maximize() {
        win.remaximized += 1;
        win.maximized = true;
      },
    };
    const workArea = { x: 0, y: 38, width: 1512, height: 944 };
    vi.stubGlobal("electron", {
      remote: {
        getCurrentWindow: () => win,
        screen: {
          getDisplayMatching: () => ({ workArea }),
          getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1, height: 1 } }),
        },
      },
    });
    vi.stubGlobal("screen", { availWidth: 1500, availHeight: 900 });
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 800);
    return { win, workArea };
  }

  it("reads the window's bounds and the work area of the display it is on from Electron", () => {
    const { workArea } = electron();
    expect(readWindowFacts()).toMatchObject({
      via: "electron",
      bounds: { x: 10, y: 20, width: 1024, height: 800 },
      workArea,
      maximized: false,
      availWidth: 1500,
      innerWidth: 1024,
    });
  });

  it("falls back to the page's own numbers when there is no window API", () => {
    vi.stubGlobal("screen", { availWidth: 1500, availHeight: 900 });
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("outerWidth", 1024);
    vi.stubGlobal("outerHeight", 830);
    const facts = readWindowFacts();
    expect(facts).toMatchObject({ via: "screen", bounds: null, workArea: null, outerHeight: 830 });
  });

  it("sets whole-pixel bounds, un-maximizing first, and says whether the API was there", () => {
    const { win } = electron(true);
    expect(applyWindowBounds({ x: 0.4, y: 37.6, width: 1511.5, height: 944 }, false)).toBe(true);
    expect(win.bounds).toEqual({ x: 0, y: 38, width: 1512, height: 944 });
    expect(win.unmaximized).toBe(1);
    expect(win.remaximized).toBe(0);
    applyWindowBounds({ x: 10, y: 20, width: 1024, height: 800 }, true);
    expect(win.remaximized).toBe(1);
    vi.unstubAllGlobals();
    expect(applyWindowBounds({ x: 0, y: 0, width: 10, height: 10 }, false)).toBe(false);
  });
});

describe("moving the command center to the main area and back", () => {
  interface Leaf {
    id: string;
    root: unknown;
    type: string;
    detached: boolean;
    state: unknown;
    getRoot: () => unknown;
    getViewState: () => { type: string; state: unknown };
    setViewState: (state: { type: string; state?: unknown }) => Promise<void>;
    detach: () => void;
  }

  function workspace(initial: Array<{ id: string; type: string; root: "main" | "right" }>) {
    const rootSplit = { name: "main" };
    const rightSplit = {
      name: "right",
      collapsed: false,
      collapse() {
        this.collapsed = true;
      },
      expand() {
        this.collapsed = false;
      },
    };
    const leftSplit = {
      name: "left",
      collapsed: false,
      collapse() {
        this.collapsed = true;
      },
      expand() {
        this.collapsed = false;
      },
    };
    const leaves: Leaf[] = [];
    const make = (id: string, type: string, root: unknown): Leaf => {
      const leaf: Leaf = {
        id,
        root,
        type,
        detached: false,
        state: {},
        getRoot: () => leaf.root,
        getViewState: () => ({ type: leaf.type, state: leaf.state }),
        async setViewState(next) {
          leaf.type = next.type;
          leaf.state = next.state ?? {};
        },
        detach() {
          leaf.detached = true;
        },
      };
      leaves.push(leaf);
      return leaf;
    };
    for (const entry of initial)
      make(entry.id, entry.type, entry.root === "main" ? rootSplit : rightSplit);
    let counter = 0;
    const ws = {
      rootSplit,
      leftSplit,
      rightSplit,
      active: undefined as unknown,
      resizes: 0,
      getLeavesOfType: (type: string) => leaves.filter((l) => l.type === type && !l.detached),
      getLeaf: () => {
        counter += 1;
        return make(`new-${counter}`, "empty", rootSplit);
      },
      getRightLeaf: () => {
        counter += 1;
        return make(`side-${counter}`, "empty", rightSplit);
      },
      setActiveLeaf: (leaf: unknown) => {
        ws.active = leaf;
      },
      requestResize: () => {
        ws.resizes += 1;
      },
      trigger: () => undefined,
    };
    vi.stubGlobal("app", { workspace: ws });
    return { ws, leaves };
  }

  it("opens the view in a new main tab with its state, closes the empty tabs and the sidebar copy", async () => {
    const { ws, leaves } = workspace([
      { id: "empty", type: "empty", root: "main" },
      { id: "ccc", type: "ccc-view", root: "right" },
    ]);
    const sidebar = leaves.find((l) => l.id === "ccc") as Leaf;
    sidebar.state = { destination: "research" };
    const result = await moveCommandCenterToMain("ccc-view");
    expect(result).toMatchObject({ ok: true, moved: true, closedEmpty: 1 });
    const inMain = ws.getLeavesOfType("ccc-view");
    expect(inMain).toHaveLength(1);
    expect(inMain[0]?.getRoot()).toBe(ws.rootSplit);
    expect(inMain[0]?.getViewState().state).toEqual({ destination: "research" });
    expect(sidebar.detached).toBe(true);
    expect(leaves.find((l) => l.id === "empty")?.detached).toBe(true);
    expect(ws.active).toBe(inMain[0]);
  });

  it("does nothing when the view is already a main tab, and refuses when it is not open", async () => {
    workspace([{ id: "ccc", type: "ccc-view", root: "main" }]);
    expect(await moveCommandCenterToMain("ccc-view")).toMatchObject({ ok: true, moved: false });
    workspace([]);
    expect(await moveCommandCenterToMain("ccc-view")).toMatchObject({ ok: false, moved: false });
  });

  it("puts the view back in the right sidebar and the empty tab back in the main area", async () => {
    const { ws, leaves } = workspace([
      { id: "empty", type: "empty", root: "main" },
      { id: "ccc", type: "ccc-view", root: "right" },
    ]);
    const moved = await moveCommandCenterToMain("ccc-view");
    expect(await moveCommandCenterToSidebar("ccc-view", moved.closedEmpty)).toBe(true);
    const back = ws.getLeavesOfType("ccc-view");
    expect(back).toHaveLength(1);
    expect(back[0]?.getRoot()).toBe(ws.rightSplit);
    const empties = ws.getLeavesOfType("empty").filter((l) => l.getRoot() === ws.rootSplit);
    expect(empties).toHaveLength(1);
    void leaves;
  });

  it("collapses both sidebars and reads the layout without changing it", () => {
    const { ws } = workspace([{ id: "ccc", type: "ccc-view", root: "right" }]);
    expect(readShotLayout("ccc-view")).toEqual({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: null,
      centerInRight: true,
    });
    expect(ws.leftSplit.collapsed).toBe(false);
    expect(collapseSidebars()).toBe(true);
    expect(ws.leftSplit.collapsed).toBe(true);
    expect(ws.rightSplit.collapsed).toBe(true);
    restoreLayout({
      leftCollapsed: false,
      rightCollapsed: false,
      rightWidth: null,
      centerInRight: true,
    });
    expect(ws.leftSplit.collapsed).toBe(false);
    expect(ws.rightSplit.collapsed).toBe(false);
  });
});

describe("hideNotices and showNotices", () => {
  function page(noticeCount: number) {
    const clicked: number[] = [];
    const styles: Array<{
      attrs: Record<string, string>;
      textContent: string | null;
      removed: boolean;
      remove(): void;
    }> = [];
    const document = {
      head: { appendChild: (node: unknown) => styles.push(node as (typeof styles)[number]) },
      createElement: () => {
        const node = {
          attrs: {} as Record<string, string>,
          textContent: null as string | null,
          removed: false,
          setAttribute(name: string, value: string) {
            node.attrs[name] = value;
          },
          remove() {
            node.removed = true;
          },
        };
        return node;
      },
      querySelectorAll: (selector: string) =>
        selector === ".notice-container .notice"
          ? Array.from({ length: noticeCount }, (_, index) => ({
              click: () => clicked.push(index),
            }))
          : [],
      querySelector: (selector: string) =>
        selector === "style[data-ccc-shot-notices]"
          ? (styles.find((style) => !style.removed) ?? null)
          : null,
    };
    vi.stubGlobal("document", document);
    return { clicked, styles };
  }

  it("clicks every notice shut and hides the container until the capture is over", () => {
    const { clicked, styles } = page(2);
    expect(hideNotices()).toBe(2);
    expect(clicked).toEqual([0, 1]);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain(".notice-container");
    expect(styles[0]?.textContent).toContain("display: none");
    // A second call adds no second style.
    hideNotices();
    expect(styles).toHaveLength(1);
    expect(showNotices()).toBe(true);
    expect(styles[0]?.removed).toBe(true);
    expect(showNotices()).toBe(false);
  });

  it("is safe when no notice is showing", () => {
    page(0);
    expect(hideNotices()).toBe(0);
  });
});
