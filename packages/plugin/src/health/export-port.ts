/**
 * The seam between the diagnostic bundle block and the one file that can write (plan 08-16, D-12).
 *
 * The block (a view) must not import `electron` or `node:fs`: the visual-regression harness
 * bundles the Settings views for a plain browser page with no externals, and the Phase 4 rule is
 * that Electron sits behind a seam (`pickFolder`). This holder is that seam, in the style of
 * `research/api.ts` and `health/api.ts`: pure types plus one replaceable value. `health/wiring.ts`
 * (reached only from `main.ts`) configures it with the real functions from `export.ts` and
 * releases it through the host registry; unconfigured, it answers that no save dialog exists, so a
 * view rendered anywhere else offers Copy only and can never write a file.
 */

/** What a save came to. None of the outcomes carries a path, a message or an error text. */
export type SaveOutcome =
  | { readonly kind: "saved" }
  | { readonly kind: "cancelled" }
  /** There is no save dialog in this window. */
  | { readonly kind: "unavailable" }
  /** The chosen location is inside the open vault (or cannot be shown not to be). */
  | { readonly kind: "inside-vault" }
  /** The chosen path is not an absolute `.json` file path. */
  | { readonly kind: "invalid-path" }
  | { readonly kind: "failed" };

export interface BundleExportPort {
  /** True when the window has a save dialog. Never throws. */
  readonly saveDialogAvailable: () => boolean;
  /**
   * Opens the dialog and writes `text` to the path the owner picks. `vaultBasePath` is the open
   * vault's folder (the write refuses to land inside it); `now` names the default file.
   */
  readonly save: (text: string, vaultBasePath: string | null, now: number) => Promise<SaveOutcome>;
}

const UNAVAILABLE_PORT: BundleExportPort = {
  saveDialogAvailable: () => false,
  save: () => Promise.resolve({ kind: "unavailable" }),
};

let current: BundleExportPort = UNAVAILABLE_PORT;

/** Installs the port, or with `null` goes back to the unavailable default. */
export function configureBundleExport(port: BundleExportPort | null): void {
  current = port ?? UNAVAILABLE_PORT;
}

/** The configured port (never `null`). */
export function bundleExport(): BundleExportPort {
  return current;
}
