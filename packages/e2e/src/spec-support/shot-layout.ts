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

/**
 * Collapses the left sidebar and, when the command center is not in it, the right one too; when it
 * is in the right sidebar that sidebar is expanded and widened to the space the window has. Returns
 * what to put back.
 */
export function maximizeCommandCenter(viewType: string, targetWidth: number): ShotLayoutState {
  const app = (globalThis as { app?: { workspace?: WorkspaceLite } }).app;
  const workspace = app?.workspace;
  const left = workspace?.leftSplit;
  const right = workspace?.rightSplit;
  const leaves = workspace?.getLeavesOfType?.(viewType) ?? [];
  const centerInRight = leaves.some((leaf) => leaf.getRoot?.() === right);
  const state: ShotLayoutState = {
    leftCollapsed: left?.collapsed === true,
    rightCollapsed: right?.collapsed === true,
    rightWidth: right?.containerEl?.getBoundingClientRect?.().width ?? right?.size ?? null,
    centerInRight,
  };
  left?.collapse?.();
  if (centerInRight) {
    right?.expand?.();
    if (typeof right?.setSize === "function") right.setSize(targetWidth);
    else if (right !== undefined) {
      right.size = targetWidth;
      if (right.containerEl?.style !== undefined)
        right.containerEl.style.width = `${targetWidth}px`;
    }
  } else {
    right?.collapse?.();
  }
  workspace?.requestResize?.();
  workspace?.trigger?.("resize");
  return state;
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
