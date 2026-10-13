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
