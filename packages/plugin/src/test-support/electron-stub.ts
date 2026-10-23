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

/** A stand-in for Electron's `BrowserWindow`: opaque, only its identity matters. */
export interface StubWindow {
  readonly stubWindow: true;
}

/**
 * Electron's `showSaveDialog` takes the options alone, or the parent window and then the options
 * (FIX4B m8). A test double receives whichever the caller used.
 */
export type SaveDialogArgs =
  | [options: SaveDialogOptions]
  | [window: StubWindow, options: SaveDialogOptions];

/** The options out of either call shape. */
export function saveDialogOptionsOf(...args: SaveDialogArgs): SaveDialogOptions {
  return args.length === 2 ? args[1] : args[0];
}

/** The parent window out of either call shape, or `undefined` when the call named none. */
export function saveDialogWindowOf(...args: SaveDialogArgs): StubWindow | undefined {
  return args.length === 2 ? args[0] : undefined;
}

export const remote: {
  dialog: {
    showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>;
    showSaveDialog: (...args: SaveDialogArgs) => Promise<SaveDialogResult>;
  };
  /** Replaceable like the dialog; absent by default, as in a window that does not expose it. */
  getCurrentWindow?: (() => StubWindow) | undefined;
} = {
  dialog: {
    showOpenDialog: (_options: OpenDialogOptions): Promise<OpenDialogResult> =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: (..._args: SaveDialogArgs): Promise<SaveDialogResult> =>
      Promise.resolve({ canceled: true }),
  },
};
