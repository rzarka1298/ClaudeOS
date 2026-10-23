/**
 * The runtime stand-in for the `electron` module under Vitest (plan 04-05
 * SC-5), wired up by `packages/plugin/vitest.config.ts`'s `resolve.alias`
 * beside the `obsidian` stub above it.
 *
 * `esbuild.config.mjs` externalises `electron` from the plugin bundle for
 * the same reason it externalises `obsidian`: Obsidian's own Electron
 * process provides the real module at runtime, so there is nothing for a
 * bundler — or a test runner — to load. Any module that reaches for
 * `electron.remote.dialog` (the folder-picker seam, `projects/folder-picker.ts`)
 * therefore needs a double to execute under Vitest at all.
 *
 * `showOpenDialog` is a plain, replaceable function rather than a `vi.fn()`
 * built in here: a test that wants to assert call arguments reassigns it
 * directly (`remote.dialog.showOpenDialog = vi.fn(...)`), and every other
 * test gets the same safe default — cancelled, no paths — with no risk of
 * one test's mock state leaking into the next.
 */
export interface OpenDialogResult {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface OpenDialogOptions {
  readonly properties?: readonly string[];
  readonly title?: string;
}

/**
 * The save dialog double (plan 08-16): replaceable like `showOpenDialog`, and cancelled by
 * default so a test that does not set it up can never write a file.
 */
export interface SaveDialogOptions {
  readonly title?: string;
  readonly buttonLabel?: string;
  readonly defaultPath?: string;
  readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
  readonly properties?: readonly string[];
}

export interface SaveDialogResult {
  readonly canceled: boolean;
  readonly filePath?: string | undefined;
}

export const remote: {
  dialog: {
    showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>;
    showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>;
  };
} = {
  dialog: {
    showOpenDialog: (_options: OpenDialogOptions): Promise<OpenDialogResult> =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: (_options: SaveDialogOptions): Promise<SaveDialogResult> =>
      Promise.resolve({ canceled: true }),
  },
};
