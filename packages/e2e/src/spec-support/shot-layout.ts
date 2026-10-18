/**
 * Layout for the look screenshots (owner request after run 17): the sandboxed Obsidian window is
 * made as big as the display allows and the command center as wide as the workspace allows, then
 * restored, so a screenshot shows the controls at a readable size. Only the sandboxed window is
 * touched (the runner's own Obsidian, never the owner's). The renderer functions are serialised by
 * wdio: no named inner functions or const-bound arrows in them (keepNames helper, Wave 2 HIGH-1).
 */

export interface SidedockLite {
  collapsed?: boolean;
  size?: number;
  collapse?: () => void;
  expand?: () => void;
  setSize?: (size: number) => void;
  containerEl?: { style?: { width?: string }; getBoundingClientRect?: () => { width: number } };
}

export interface WorkspaceLite {
  leftSplit?: SidedockLite;
  rightSplit?: SidedockLite;
  getLeavesOfType?: (type: string) => Array<{
    getRoot?: () => unknown;
  }>;
  trigger?: (name: string) => void;
  requestResize?: () => void;
}

export interface ShotLayoutState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightWidth: number | null;
  /** The command center sits in the right sidebar, so that one is widened rather than collapsed. */
  centerInRight: boolean;
}

/** The display's usable size, read in the renderer. */
export function readAvailableScreen(): { width: number; height: number } {
  const screen = (globalThis as { screen?: { availWidth?: number; availHeight?: number } }).screen;
  return { width: screen?.availWidth ?? 0, height: screen?.availHeight ?? 0 };
}

/** What the enlarged layout measured, so a spec can refuse a shot that would be clipped. */
export interface ShotLayoutResult extends ShotLayoutState {
  innerWidth: number;
  rightEdge: number | null;
  /** The right sidebar's right edge is inside the window (or the command center is not in it). */
  fits: boolean;
}

/**
 * Collapses the left sidebar and, when the command center is not in it, the right one too; when it
 * is in the right sidebar that sidebar is expanded and widened to what the window's inner width
 * leaves after the ribbon, then narrowed until its right edge is inside the window (a width taken
 * from the display clipped the view in run 18). Returns what to put back and what was measured.
 */
export function maximizeCommandCenter(viewType: string): ShotLayoutResult {
  const g = globalThis as {
    app?: { workspace?: WorkspaceLite };
    innerWidth?: number;
    document?: {
      querySelector?: (
        selector: string,
      ) => { getBoundingClientRect?: () => { width: number } } | null;
    };
  };
  const workspace = g.app?.workspace;
  const left = workspace?.leftSplit;
  const right = workspace?.rightSplit;
  const leaves = workspace?.getLeavesOfType?.(viewType) ?? [];
  const centerInRight = leaves.some((leaf) => leaf.getRoot?.() === right);
  const innerWidth = g.innerWidth ?? 0;
  const state: ShotLayoutState = {
    leftCollapsed: left?.collapsed === true,
    rightCollapsed: right?.collapsed === true,
    rightWidth: right?.containerEl?.getBoundingClientRect?.().width ?? right?.size ?? null,
    centerInRight,
  };
  left?.collapse?.();
  let rightEdge: number | null = null;
  if (centerInRight && right !== undefined) {
    right.expand?.();
    const ribbon = g.document?.querySelector?.(".workspace-ribbon.mod-left");
    let target = Math.max(300, innerWidth - (ribbon?.getBoundingClientRect?.().width ?? 0) - 4);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (typeof right.setSize === "function") right.setSize(target);
      else {
        right.size = target;
        if (right.containerEl?.style !== undefined) right.containerEl.style.width = `${target}px`;
      }
      workspace?.requestResize?.();
      const box = right.containerEl?.getBoundingClientRect?.() as
        | { width: number; right?: number }
        | undefined;
      rightEdge = box?.right ?? null;
      if (rightEdge === null || rightEdge <= innerWidth) break;
      target = Math.max(300, target - (rightEdge - innerWidth) - 2);
    }
  } else {
    right?.collapse?.();
  }
  workspace?.requestResize?.();
  workspace?.trigger?.("resize");
  return {
    ...state,
    innerWidth,
    rightEdge,
    fits: rightEdge === null || rightEdge <= innerWidth,
  };
}

/** What a shot is of, after the layout change: scrolled into view and checked to be on screen. */
export interface SubjectCheck {
  found: boolean;
  inView: boolean;
}

/**
 * Scrolls the subject into view and says whether it is on screen. `:focus` names the focused
 * element. `block` is `center` for a control and `start` for a pane taller than the window.
 */
export function bringSubjectIntoView(selector: string, block: "center" | "start"): SubjectCheck {
  const d = (globalThis as { document?: { querySelector?: (s: string) => unknown } }).document;
  const element = (
    selector === ":focus"
      ? (d as { activeElement?: unknown } | undefined)?.activeElement
      : d?.querySelector?.(selector)
  ) as
    | {
        scrollIntoView?: (options: { block: string; inline: string }) => void;
        getBoundingClientRect?: () => { top: number; bottom: number; left: number; right: number };
      }
    | null
    | undefined;
  if (element === null || element === undefined) return { found: false, inView: false };
  element.scrollIntoView?.({ block, inline: "nearest" });
  const rect = element.getBoundingClientRect?.();
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  if (rect === undefined) return { found: true, inView: false };
  const width = g.innerWidth ?? 0;
  const height = g.innerHeight ?? 0;
  const inView =
    block === "start"
      ? rect.top >= 0 && rect.top < height && rect.left >= 0 && rect.left < width
      : rect.top >= 0 && rect.bottom <= height && rect.left >= 0 && rect.right <= width;
  return { found: true, inView };
}

/** Puts the sidebars back as {@link maximizeCommandCenter} found them. */
export function restoreLayout(state: ShotLayoutState): boolean {
  const app = (globalThis as { app?: { workspace?: WorkspaceLite } }).app;
  const workspace = app?.workspace;
  const left = workspace?.leftSplit;
  const right = workspace?.rightSplit;
  if (!state.leftCollapsed) left?.expand?.();
  if (state.rightCollapsed) right?.collapse?.();
  else {
    right?.expand?.();
    if (state.rightWidth !== null) {
      if (typeof right?.setSize === "function") right.setSize(state.rightWidth);
      else if (right !== undefined) {
        right.size = state.rightWidth;
        if (right.containerEl?.style !== undefined) {
          right.containerEl.style.width = `${state.rightWidth}px`;
        }
      }
    }
  }
  workspace?.requestResize?.();
  workspace?.trigger?.("resize");
  return true;
}

/** Identifies the focused element so it can be put back after the layout change. */
export function rememberFocus(): boolean {
  const w = globalThis as { __cccShotFocus?: unknown; document?: { activeElement?: unknown } };
  w.__cccShotFocus = w.document?.activeElement ?? null;
  return w.__cccShotFocus !== null;
}

/** Puts focus back on the remembered element if the layout change moved it; true when unchanged or restored. */
export function recoverFocus(): boolean {
  const w = globalThis as {
    __cccShotFocus?: { focus?: () => void; isConnected?: boolean } | null;
    document?: { activeElement?: unknown };
  };
  const remembered = w.__cccShotFocus;
  if (remembered === null || remembered === undefined) return true;
  if (w.document?.activeElement !== remembered && remembered.isConnected !== false) {
    remembered.focus?.();
  }
  return w.document?.activeElement === remembered;
}

// ---------------------------------------------------------------------------
// Window size, the main-leaf placement and the notices (Phase 7 live-UAT trial, run da14049b).
// The trial's "full-width" shots were a 640 px right pane beside an empty tab in a 1024 px window:
// Obsidian will not widen a sidebar past a share of the window, so no sidebar width can be full
// width. The command center goes into the MAIN area, both sidebars collapse, the empty tab closes,
// and the window takes the display's work area; everything is put back afterwards.
// ---------------------------------------------------------------------------

/** A rectangle in CSS (device-independent) px. */
export interface RectLite {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the renderer can say about its window and display. */
export interface WindowFacts {
  /** `electron` when the window API answered; `screen` when only the page's own `screen` did. */
  via: "electron" | "screen";
  bounds: RectLite | null;
  workArea: RectLite | null;
  maximized: boolean;
  availWidth: number;
  availHeight: number;
  innerWidth: number;
  innerHeight: number;
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
}

/** The slice of Electron's window and screen objects the sizing touches. */
interface ElectronWindowLite {
  getBounds?: () => RectLite;
  setBounds?: (bounds: RectLite) => void;
  isMaximized?: () => boolean;
  unmaximize?: () => void;
  maximize?: () => void;
}

interface ElectronRemoteLite {
  getCurrentWindow?: () => ElectronWindowLite | undefined;
  screen?: {
    getDisplayMatching?: (bounds: RectLite) => { workArea?: RectLite } | undefined;
    getPrimaryDisplay?: () => { workArea?: RectLite } | undefined;
  };
}

/**
 * The window's bounds and the work area of the display it is on, from Obsidian's own Electron
 * remote (the same `window.electron.remote` wdio-obsidian-service itself uses to size the window),
 * with the page's `screen` and `window` numbers as the fallback.
 */
export function readWindowFacts(): WindowFacts {
  const g = globalThis as {
    electron?: { remote?: ElectronRemoteLite };
    screen?: { availWidth?: number; availHeight?: number };
    innerWidth?: number;
    innerHeight?: number;
    screenX?: number;
    screenY?: number;
    outerWidth?: number;
    outerHeight?: number;
  };
  const remote = g.electron?.remote;
  const win = remote?.getCurrentWindow?.();
  const bounds = win?.getBounds?.() ?? null;
  const display =
    bounds === null
      ? remote?.screen?.getPrimaryDisplay?.()
      : (remote?.screen?.getDisplayMatching?.(bounds) ?? remote?.screen?.getPrimaryDisplay?.());
  return {
    via: bounds === null ? "screen" : "electron",
    bounds,
    workArea: display?.workArea ?? null,
    maximized: win?.isMaximized?.() === true,
    availWidth: g.screen?.availWidth ?? 0,
    availHeight: g.screen?.availHeight ?? 0,
    innerWidth: g.innerWidth ?? 0,
    innerHeight: g.innerHeight ?? 0,
    screenX: g.screenX ?? 0,
    screenY: g.screenY ?? 0,
    outerWidth: g.outerWidth ?? 0,
    outerHeight: g.outerHeight ?? 0,
  };
}

/**
 * Gives the window these bounds through Electron's window API; true when the API was there. A
 * maximized window is un-maximized first (setBounds does not apply to one), and `maximized` puts
 * it back to maximized afterwards (the restore path).
 */
export function applyWindowBounds(bounds: RectLite, maximized: boolean): boolean {
  const g = globalThis as { electron?: { remote?: ElectronRemoteLite } };
  const win = g.electron?.remote?.getCurrentWindow?.();
  if (win?.setBounds === undefined) return false;
  if (win.isMaximized?.() === true) win.unmaximize?.();
  win.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
  if (maximized) win.maximize?.();
  return true;
}

/** The slice of the workspace the main-leaf placement uses. */
export interface MoveWorkspaceLite {
  rootSplit?: unknown;
  leftSplit?: SidedockLite;
  rightSplit?: SidedockLite;
  getLeavesOfType?: (type: string) => Array<{
    getRoot?: () => unknown;
    getViewState?: () => { type: string; state?: unknown };
    setViewState?: (state: unknown) => Promise<void>;
    detach?: () => void;
  }>;
  getLeaf?: (kind?: string | boolean) => {
    setViewState?: (state: unknown) => Promise<void>;
  };
  getRightLeaf?: (split: boolean) => {
    setViewState?: (state: unknown) => Promise<void>;
  } | null;
  setActiveLeaf?: (leaf: unknown, options?: { focus?: boolean }) => void;
  requestResize?: () => void;
  trigger?: (name: string) => void;
}

/** What {@link moveCommandCenterToMain} did, so {@link moveCommandCenterToSidebar} can undo it. */
export interface MoveResult {
  ok: boolean;
  /** False when the command center was already in the main area. */
  moved: boolean;
  /** How many empty "New tab" leaves were closed in the main area. */
  closedEmpty: number;
  reason: string;
}

/**
 * Opens a second command center view in the main area, closes the empty tabs there and closes the
 * sidebar one, so the view is a main-area tab. The new view starts fresh; the caller reopens what
 * it was showing.
 */
export async function moveCommandCenterToMain(viewType: string): Promise<MoveResult> {
  const workspace = (globalThis as { app?: { workspace?: MoveWorkspaceLite } }).app?.workspace;
  const existing = workspace?.getLeavesOfType?.(viewType)?.[0];
  if (workspace === undefined || existing === undefined) {
    return { ok: false, moved: false, closedEmpty: 0, reason: "The command center is not open." };
  }
  if (existing.getRoot?.() === workspace.rootSplit) {
    return { ok: true, moved: false, closedEmpty: 0, reason: "Already in the main area." };
  }
  const target = workspace.getLeaf?.("tab");
  if (target?.setViewState === undefined) {
    return { ok: false, moved: false, closedEmpty: 0, reason: "No main-area leaf to open it in." };
  }
  const viewState = existing.getViewState?.() ?? { type: viewType };
  await target.setViewState({ ...viewState, active: true });
  workspace.setActiveLeaf?.(target, { focus: true });
  let closedEmpty = 0;
  for (const leaf of workspace.getLeavesOfType?.("empty") ?? []) {
    if (leaf.getRoot?.() === workspace.rootSplit) {
      leaf.detach?.();
      closedEmpty += 1;
    }
  }
  existing.detach?.();
  workspace.requestResize?.();
  return { ok: true, moved: true, closedEmpty, reason: "Moved to the main area." };
}

/**
 * Puts the command center back in the right sidebar and the empty tabs back in the main area, as
 * {@link moveCommandCenterToMain} found them. The sidebar view is new; the caller reopens it.
 */
export async function moveCommandCenterToSidebar(
  viewType: string,
  closedEmpty: number,
): Promise<boolean> {
  const workspace = (globalThis as { app?: { workspace?: MoveWorkspaceLite } }).app?.workspace;
  const inMain = workspace?.getLeavesOfType?.(viewType)?.[0];
  const side = workspace?.getRightLeaf?.(false);
  if (workspace === undefined || inMain === undefined || side?.setViewState === undefined) {
    return false;
  }
  await side.setViewState({ type: viewType, active: true });
  inMain.detach?.();
  let present = 0;
  for (const leaf of workspace.getLeavesOfType?.("empty") ?? []) {
    if (leaf.getRoot?.() === workspace.rootSplit) present += 1;
  }
  for (let made = present; made < closedEmpty; made += 1) {
    const leaf = workspace.getLeaf?.("tab");
    await leaf?.setViewState?.({ type: "empty" });
  }
  workspace.requestResize?.();
  return true;
}

/** Collapses both sidebars (the layout the shots are taken in); {@link restoreLayout} undoes it. */
export function collapseSidebars(): boolean {
  const workspace = (globalThis as { app?: { workspace?: WorkspaceLite } }).app?.workspace;
  workspace?.leftSplit?.collapse?.();
  workspace?.rightSplit?.collapse?.();
  workspace?.requestResize?.();
  workspace?.trigger?.("resize");
  return workspace !== undefined;
}

/** The sidebars and the command center's place as they are now, without changing anything. */
export function readShotLayout(viewType: string): ShotLayoutState {
  const workspace = (globalThis as { app?: { workspace?: WorkspaceLite } }).app?.workspace;
  const left = workspace?.leftSplit;
  const right = workspace?.rightSplit;
  const leaves = workspace?.getLeavesOfType?.(viewType) ?? [];
  return {
    leftCollapsed: left?.collapsed === true,
    rightCollapsed: right?.collapsed === true,
    rightWidth: right?.containerEl?.getBoundingClientRect?.().width ?? right?.size ?? null,
    centerInRight: leaves.some((leaf) => leaf.getRoot?.() === right),
  };
}

/**
 * Dismisses every Obsidian notice (a click closes one) and hides the notice container for as long
 * as {@link showNotices} has not run, so a toast that arrives mid-capture cannot cover the header
 * (run da14049b: two toasts over item 15's side pane). Returns how many notices were showing.
 */
export function hideNotices(): number {
  const d = (
    globalThis as {
      document?: {
        querySelectorAll?: (selector: string) => ArrayLike<{ click?: () => void }>;
        querySelector?: (selector: string) => unknown;
        createElement?: (tag: string) => {
          setAttribute: (name: string, value: string) => void;
          textContent: string | null;
        };
        head?: { appendChild: (node: unknown) => void };
      };
    }
  ).document;
  const showing = Array.from(d?.querySelectorAll?.(".notice-container .notice") ?? []);
  for (const notice of showing) notice.click?.();
  if (d?.querySelector?.("style[data-ccc-shot-notices]") === null) {
    const style = d.createElement?.("style");
    if (style !== undefined) {
      style.setAttribute("data-ccc-shot-notices", "true");
      style.textContent = ".notice-container { display: none; }";
      d.head?.appendChild(style);
    }
  }
  return showing.length;
}

/** Lets notices show again after a capture. */
export function showNotices(): boolean {
  const d = (
    globalThis as {
      document?: { querySelector?: (selector: string) => { remove?: () => void } | null };
    }
  ).document;
  const style = d?.querySelector?.("style[data-ccc-shot-notices]");
  style?.remove?.();
  return style !== null && style !== undefined;
}
