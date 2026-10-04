import { remote } from "electron";

/**
 * The outcome of offering the native folder dialog (D-03, S4 step 1).
 *
 * `unavailable` is an expected outcome, not an error: whenever Electron's
 * `remote.dialog` surface is missing (a popout window, or any renderer that
 * does not expose it), the caller opens the typed-path form instead
 * (S4 step 2) — `pickFolder` never throws.
 */
export type FolderPick =
  | { readonly kind: "picked"; readonly path: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" };

export interface PickFolderOptions {
  readonly title: string;
  readonly buttonLabel: string;
}

/**
 * Opens Electron's native `openDirectory` dialog with the caller's title and
 * button label (so both S4's "Choose a project folder" / "Register folder"
 * and S5's "Choose a folder to scan" / "Add scan folder" reuse this one
 * function). Feature-detected: an environment without `showOpenDialog`
 * resolves `unavailable` rather than throwing.
 */
export async function pickFolder(options: PickFolderOptions): Promise<FolderPick> {
  const showOpenDialog = remote?.dialog?.showOpenDialog;
  if (typeof showOpenDialog !== "function") {
    return { kind: "unavailable" };
  }

  const result = await showOpenDialog({
    title: options.title,
    buttonLabel: options.buttonLabel,
    properties: ["openDirectory"],
  });

  const path = result.filePaths[0];
  if (result.canceled || path === undefined) {
    return { kind: "cancelled" };
  }
  return { kind: "picked", path };
}
