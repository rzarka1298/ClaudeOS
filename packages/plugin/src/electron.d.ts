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

  export interface RemoteDialog {
    showOpenDialog?: ((options: OpenDialogOptions) => Promise<OpenDialogResult>) | undefined;
  }

  export interface Remote {
    readonly dialog?: RemoteDialog | undefined;
  }

  export const remote: Remote | undefined;
}
