import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { remote } from "electron";
import type { SaveOutcome } from "./export-port.js";

/**
 * The only plugin file in Phase 8 that writes a file (plan 08-16, D-12, T-08-41, T-08-42):
 * the typed save dialog and the write behind it. The plugin is desktop-only (ADR 0001), so Node's
 * file system is allowed here; nothing in this file names a network primitive.
 *
 * The write is the high-risk half of the privacy boundary, so every step is defensive:
 *
 * - It goes only to a path the owner picked in the native save dialog, and only if that path is
 *   absolute, ends in `.json` and is not directory-shaped.
 * - It never lands inside the open vault. Containment is judged on the lexical path AND on the
 *   real location (the parent folder's `realpath`, so a symlinked folder, a symlinked vault base
 *   and the `/var` -> `/private/var` link are all seen through), compared case-insensitively and
 *   Unicode-normalised, because APFS is both. An unfamiliar spelling that only a case-sensitive
 *   volume would tell apart is refused too: over-refusing a save is cheap, writing into a synced
 *   vault is not.
 * - The file is created under a temporary name in the same folder with `O_EXCL | O_NOFOLLOW` and
 *   mode 0600, flushed, then renamed over the target. `rename` replaces a symlink at the target
 *   rather than following it, so a link can never redirect the bytes elsewhere, and a failure
 *   leaves either the old file or none, never half of the new one.
 * - Nothing it returns or throws carries the path, the temporary name or an error message.
 */

/** What the save dialog came to. */
export type SavePick =
  | { readonly kind: "picked"; readonly path: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" };

export interface PickSavePathOptions {
  /** A bare file name, never a directory. */
  readonly defaultName: string;
}

/** The longest path accepted; anything longer is not a path the owner typed in a dialog. */
const MAX_PATH_LENGTH = 1024;
const MODE_PRIVATE = 0o600;

/** `claude-command-center-diagnostics-YYYY-MM-DD.json`, the date in UTC. */
export function defaultBundleFileName(now: number): string {
  return `claude-command-center-diagnostics-${new Date(now).toISOString().slice(0, 10)}.json`;
}

/** True when this window has a save dialog. Feature-detected like `pickFolder`; never throws. */
export function saveDialogAvailable(): boolean {
  return typeof remote?.dialog?.showSaveDialog === "function";
}

/**
 * Opens Electron's native save dialog. `unavailable` is an expected outcome (a popout window may
 * not expose it), `failed` is a dialog that threw: neither throws out of here.
 */
export async function pickSavePath(options: PickSavePathOptions): Promise<SavePick> {
  const dialog = remote?.dialog;
  if (typeof dialog?.showSaveDialog !== "function") return { kind: "unavailable" };
  try {
    const result = await dialog.showSaveDialog({
      title: "Save diagnostic bundle",
      buttonLabel: "Save bundle",
      defaultPath: options.defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    const path = result.filePath;
    if (result.canceled || typeof path !== "string" || path === "") return { kind: "cancelled" };
    return { kind: "picked", path };
  } catch {
    return { kind: "failed" };
  }
}

/** A path as the file system compares it on APFS: no trailing slash, normalised, case-folded. */
function fold(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.normalize("NFD").toLowerCase();
}

/** True when `target` is the vault folder or anything under it, compared as APFS compares. */
export function isInsideVault(target: string, vault: string): boolean {
  const folded = fold(target);
  const root = fold(vault);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return folded === root || folded.startsWith(prefix);
}

/** An absolute, `.json`, file-shaped path of sane length with no NUL. */
function isAcceptablePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    !path.includes("\0") &&
    isAbsolute(path) &&
    !path.endsWith("/") &&
    /\.json$/i.test(path)
  );
}

/**
 * Writes `text` to `rawPath` as described above. The result never carries the path.
 * `vaultBasePath` of `null` means the vault's location is unknown, so containment cannot be shown:
 * nothing is written.
 */
export async function writeBundleFile(
  text: string,
  rawPath: string,
  vaultBasePath: string | null,
): Promise<SaveOutcome> {
  if (!isAcceptablePath(rawPath)) return { kind: "invalid-path" };
  if (vaultBasePath === null || vaultBasePath === "") return { kind: "failed" };

  const target = resolve(rawPath);
  let realVault: string;
  let realParent: string;
  try {
    realVault = await realpath(vaultBasePath);
    realParent = await realpath(dirname(target));
  } catch {
    return { kind: "failed" };
  }
  const landing = join(realParent, basename(target));
  const vaults = [vaultBasePath, realVault];
  if ([target, landing].some((where) => vaults.some((vault) => isInsideVault(where, vault)))) {
    return { kind: "inside-vault" };
  }

  const temporary = join(realParent, `.ccc-diagnostics-${window.crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      MODE_PRIVATE,
    );
    await handle.writeFile(text, "utf8");
    // The umask can only remove bits, but a hostile one could remove the owner's: set it exactly.
    await handle.chmod(MODE_PRIVATE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, landing);
    return { kind: "saved" };
  } catch {
    try {
      await handle?.close();
    } catch {
      // Already closed or never opened: nothing more to release.
    }
    try {
      await unlink(temporary);
    } catch {
      // The temporary file was never created, or the rename already consumed it.
    }
    return { kind: "failed" };
  }
}

/**
 * The whole Save gesture: the dialog, then the guarded write. `now` names the default file.
 * Nothing is written unless the owner picked a path.
 */
export async function saveBundle(
  text: string,
  vaultBasePath: string | null,
  now: number,
): Promise<SaveOutcome> {
  const pick = await pickSavePath({ defaultName: defaultBundleFileName(now) });
  if (pick.kind === "picked") return writeBundleFile(text, pick.path, vaultBasePath);
  return { kind: pick.kind };
}

/** Copy through the clipboard port. A refused write is `failed`, never a throw. */
export async function copyBundle(
  text: string,
  copyText: (text: string) => Promise<void>,
): Promise<"copied" | "failed"> {
  try {
    await copyText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
