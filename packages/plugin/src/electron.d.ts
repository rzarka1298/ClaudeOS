/**
 * Ambient types for the one Electron surface this plugin touches:
 * `remote.dialog.showOpenDialog` (D-03, T-04-32).
 *
 * `electron` ships no bundled declarations reachable from a plugin package,
 * and `remote` itself is not an Obsidian-documented API (04-RESEARCH.md
 * "Reliability of Findings": MEDIUM stability) — so, exactly like
 * `js-yaml.d.ts`'s rationale, only the two calls `folder-picker.ts` makes are
 * declared here. A narrower declaration cannot drift into calls this
 * repository never makes, and `esbuild.config.mjs` externalises `electron`
 * from the bundle for the same reason it externalises `obsidian`: Obsidian's
 * own Electron process supplies the real module at runtime, so there is
 * nothing for a bundler — or `tsc` — to load from an actual `electron`
 * package here.
 *
 * `remote`, `dialog` and `showOpenDialog` are all typed as possibly absent:
 * a popout window's Electron surface is undocumented, so `folder-picker.ts`'s
 * `typeof … !== "function"` feature detection (D-03's typed-path fallback)
 * is a real narrowing against this type, not a formality against a type that
 * always resolves.
 */
declare module "electron" {
  export interface OpenDialogResult {
    readonly canceled: boolean;
    readonly filePaths: readonly string[];
  }

  export interface OpenDialogOptions {
    readonly title?: string;
    readonly buttonLabel?: string;
    readonly properties: readonly ("openDirectory" | "createDirectory")[];
  }

  /**
   * The save dialog (plan 08-16, D-12): only what `health/export.ts` asks for. `defaultPath` is
   * always a bare file name, never a directory. The save never replaces a file (FIX4B m9, D-12a),
   * so `showOverwriteConfirmation` is not requested.
   */
  export interface SaveDialogOptions {
    readonly title?: string;
    readonly buttonLabel?: string;
    readonly defaultPath?: string;
    readonly filters?: readonly {
      readonly name: string;
      readonly extensions: readonly string[];
    }[];
    readonly properties?: readonly ("createDirectory" | "showOverwriteConfirmation")[];
  }

  export interface SaveDialogResult {
    readonly canceled: boolean;
    readonly filePath?: string | undefined;
  }

  export interface RemoteDialog {
    showOpenDialog?: ((options: OpenDialogOptions) => Promise<OpenDialogResult>) | undefined;
    /**
     * Optional like `showOpenDialog`: a popout window's Electron surface is undocumented
     * (08-UI-SPEC S4, owner UAT item 35), so `health/export.ts` feature-detects it and falls
     * back to Copy only.
     */
    showSaveDialog?:
      | {
          (options: SaveDialogOptions): Promise<SaveDialogResult>;
          /** With the parent window, so the dialog is a sheet on the window that asked (FIX4B m8). */
          (window: unknown, options: SaveDialogOptions): Promise<SaveDialogResult>;
        }
      | undefined;
  }

  export interface Remote {
    readonly dialog?: RemoteDialog | undefined;
    /** The window this renderer lives in. Optional: a popout window may not expose it. */
    readonly getCurrentWindow?: (() => unknown) | undefined;
  }

  export const remote: Remote | undefined;
}
