/**
 * In-renderer window focus control for spike S1 (Codex finding 3). A focused Obsidian suppresses
 * native approval notifications, so the probe must unfocus the window first. Only the Electron
 * window of the app under test is touched (blur, then minimize); no other application is made
 * frontmost and no OS-level tool is used. Whether it worked is reported as evidence, never assumed.
 */
import { browser } from "@wdio/globals";

export interface BlurOutcome {
  /** electron-remote-blur, electron-remote-minimize, remote-unavailable, or error. */
  method: string;
  /** document.hasFocus() after the attempt. */
  hasFocusAfter: boolean;
}

interface WindowLike {
  blur(): void;
  minimize(): void;
  restore(): void;
  focus(): void;
}

type ElectronLike = { remote?: { getCurrentWindow(): WindowLike } };

async function act(action: "blur" | "minimize" | "restore"): Promise<string> {
  return browser.executeObsidian(({ require }, which) => {
    try {
      const electron = require("electron") as ElectronLike;
      const win = electron.remote?.getCurrentWindow();
      if (!win) return "remote-unavailable";
      if (which === "blur") win.blur();
      else if (which === "minimize") win.minimize();
      else {
        win.restore();
        win.focus();
      }
      return which;
    } catch {
      return "error";
    }
  }, action);
}

const hasFocus = (): Promise<boolean> => browser.executeObsidian(() => document.hasFocus());

/** Blurs the window, then minimizes it if it still reports focus. */
export async function unfocusWindow(): Promise<BlurOutcome> {
  let method = await act("blur");
  await browser.pause(400);
  if (method === "blur" && !(await hasFocus())) {
    return { method: "electron-remote-blur", hasFocusAfter: false };
  }
  if (method === "blur") {
    method = await act("minimize");
    await browser.pause(400);
    if (method === "minimize") {
      const after = await hasFocus();
      return { method: "electron-remote-minimize", hasFocusAfter: after };
    }
  }
  return {
    method: method === "remote-unavailable" ? "remote-unavailable" : "error",
    hasFocusAfter: await hasFocus(),
  };
}

/** Best effort: puts the window back so later spikes (S2) start from a focused window. */
export async function refocusWindow(): Promise<void> {
  try {
    await act("restore");
    await browser.pause(300);
  } catch {
    // The window may already be focused or the remote module unavailable; S2 records its own focus.
  }
}
