import { constants } from "node:fs";
import { link, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BUNDLE_MAX_BYTES } from "@ccc/domain/diagnostic-bundle.js";
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
 *   absolute, ends in `.json` and is not directory-shaped, and the text is within the bundle's
 *   size cap (the writer enforces it on its own; the view's check is not relied on).
 * - It never lands inside the open vault. Containment is first judged on the lexical path and on
 *   the real location (the parent folder's `realpath`), compared case-insensitively and
 *   Unicode-normalised, because APFS is both. Then it is judged by IDENTITY (FIX4B M1): the vault's
 *   `{dev, ino}` is compared with that of the parent folder and of every ancestor up to `/`, so a
 *   second spelling of the same folder that text cannot tell apart (the `/System/Volumes/Data`
 *   firmlink, a bind of any kind) is still the vault. Over-refusing a save is cheap, writing into a
 *   synced vault is not.
 * - The parent's identity is recorded before the file is created and checked again before the file
 *   lands and after it has (FIX4B m1). If the folder was swapped in between, or now sits inside
 *   the vault, the landed file is removed (only if it is still the very file this write made) and
 *   the save fails.
 * - The file is created under a temporary name in the same folder with `O_EXCL | O_NOFOLLOW` and
 *   mode 0600, set exactly with `fchmod`, flushed, then LANDED with `link(2)`, which fails rather
 *   than replace anything (FIX4B m9, D-12a): an existing file, a symlink (dangling or not) and a
 *   directory at the target all end as `exists`, and nothing is written through them. The
 *   temporary name is then unlinked.
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
  const dialogOptions = {
    title: "Save diagnostic bundle",
    buttonLabel: "Save bundle",
    defaultPath: options.defaultName,
    filters: [{ name: "JSON", extensions: ["json"] }],
    // No `showOverwriteConfirmation`: the save never replaces a file, it says one exists (D-12a).
    properties: ["createDirectory"],
  } as const;
  try {
    // The sheet belongs to the window that asked (FIX4B m8). A renderer that cannot name its
    // window, or throws when asked, gets the dialog without a parent.
    const parent = currentWindow();
    const result =
      parent === undefined
        ? await dialog.showSaveDialog(dialogOptions)
        : await dialog.showSaveDialog(parent, dialogOptions);
    const path = result.filePath;
    if (result.canceled || typeof path !== "string" || path === "") return { kind: "cancelled" };
    return { kind: "picked", path };
  } catch {
    return { kind: "failed" };
  }
}

/** This window, or `undefined` when the renderer does not expose it (or refuses to name it). */
function currentWindow(): unknown {
  try {
    return remote?.getCurrentWindow?.() ?? undefined;
  } catch {
    return undefined;
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

/** What the write needs from the file system, so a test can interleave a race (FIX4B m1). */
export interface ExportFileSystem {
  readonly realpath: (path: string) => Promise<string>;
  /** The `{dev, ino}` pair names a folder or file whatever path reached it. */
  readonly stat: (path: string) => Promise<Identity>;
  readonly open: (path: string, flags: number, mode: number) => Promise<ExportHandle>;
  /** `link(2)`: a new name for an existing file, failing with `EEXIST` rather than replacing. */
  readonly link: (existing: string, created: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The handle calls the write makes. */
export interface ExportHandle {
  readonly writeFile: (text: string, encoding: "utf8") => Promise<void>;
  readonly chmod: (mode: number) => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly stat: (options: { bigint: true }) => Promise<Identity>;
  readonly close: () => Promise<void>;
}

/** The real file system. */
export const nodeExportFileSystem: ExportFileSystem = {
  realpath: (path) => realpath(path),
  stat: (path) => stat(path, { bigint: true }),
  open: (path, flags, mode) => open(path, flags, mode),
  link: (existing, created) => link(existing, created),
  unlink: (path) => unlink(path),
};

const identityKey = (id: Identity): string => `${id.dev}:${id.ino}`;

/**
 * The identity of `dir` and whether it, or any ancestor up to `/`, is one of `vaultIds`. A folder
 * that cannot be examined throws: the caller fails closed.
 */
async function examineFolder(
  fs: ExportFileSystem,
  dir: string,
  vaultIds: ReadonlySet<string>,
): Promise<{ readonly id: string; readonly inside: boolean }> {
  let id: string | undefined;
  let inside = false;
  let current = dir;
  for (;;) {
    const here = identityKey(await fs.stat(current));
    id ??= here;
    if (vaultIds.has(here)) inside = true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { id, inside };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/** True when `text` is within the bundle's size cap, measured in utf-8 bytes as the verifier does. */
function withinSizeCap(text: string): boolean {
  return new TextEncoder().encode(text).length <= BUNDLE_MAX_BYTES;
}

/**
 * Writes `text` to `rawPath` as described above. The result never carries the path.
 * `vaultBasePath` of `null` means the vault's location is unknown, so containment cannot be shown:
 * nothing is written. Text over the size cap is `failed`, nothing written.
 */
export async function writeBundleFile(
  text: string,
  rawPath: string,
  vaultBasePath: string | null,
  fs: ExportFileSystem = nodeExportFileSystem,
): Promise<SaveOutcome> {
  if (!withinSizeCap(text)) return { kind: "failed" };
  if (!isAcceptablePath(rawPath)) return { kind: "invalid-path" };
  if (vaultBasePath === null || vaultBasePath === "") return { kind: "failed" };

  const target = resolve(rawPath);
  let realVault: string;
  let realParent: string;
  let vaultIds: ReadonlySet<string>;
  let parent: { readonly id: string; readonly inside: boolean };
  try {
    realVault = await fs.realpath(vaultBasePath);
    realParent = await fs.realpath(dirname(target));
    vaultIds = new Set([
      identityKey(await fs.stat(vaultBasePath)),
      identityKey(await fs.stat(realVault)),
    ]);
    parent = await examineFolder(fs, realParent, vaultIds);
  } catch {
    return { kind: "failed" };
  }
  const landing = join(realParent, basename(target));
  const vaults = [vaultBasePath, realVault];
  if (
    parent.inside ||
    [target, landing].some((where) => vaults.some((vault) => isInsideVault(where, vault)))
  ) {
    return { kind: "inside-vault" };
  }

  const temporary = join(realParent, `.ccc-diagnostics-${window.crypto.randomUUID()}.tmp`);
  let handle: ExportHandle | undefined;
  /** The identity of the file this write made, so cleanup only ever removes that very file. */
  let made: string | undefined;

  /** Removes `path` only when it is still the file this write made. Never throws. */
  const removeIfMine = async (path: string): Promise<void> => {
    try {
      if (made !== undefined && identityKey(await fs.stat(path)) === made) await fs.unlink(path);
    } catch {
      // Already gone, or not ours any more: nothing more to release.
    }
  };
  /** True when the folder the file lands in is still the one checked at the start. */
  const parentIsUnchanged = async (): Promise<boolean> => {
    try {
      const now = await examineFolder(fs, dirname(landing), vaultIds);
      return now.id === parent.id && !now.inside;
    } catch {
      return false;
    }
  };

  try {
    handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      MODE_PRIVATE,
    );
    made = identityKey(await handle.stat({ bigint: true }));
    await handle.writeFile(text, "utf8");
    // The umask can only remove bits, but a hostile one could remove the owner's: set it exactly.
    await handle.chmod(MODE_PRIVATE);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (!(await parentIsUnchanged())) {
      await removeIfMine(temporary);
      return { kind: "failed" };
    }
    try {
      await fs.link(temporary, landing);
    } catch (error) {
      await removeIfMine(temporary);
      return codeOf(error) === "EEXIST" ? { kind: "exists" } : { kind: "failed" };
    }
    if (!(await parentIsUnchanged())) {
      await removeIfMine(landing);
      await removeIfMine(temporary);
      return { kind: "failed" };
    }
    await removeIfMine(temporary);
    return { kind: "saved" };
  } catch {
    try {
      await handle?.close();
    } catch {
      // Already closed or never opened: nothing more to release.
    }
    await removeIfMine(temporary);
    return { kind: "failed" };
  }
}

/**
 * The whole Save gesture: the dialog, then the guarded write. `now` names the default file.
 * Nothing is written unless the owner picked a path, and text over the size cap never reaches the
 * dialog at all.
 */
export async function saveBundle(
  text: string,
  vaultBasePath: string | null,
  now: number,
  fs: ExportFileSystem = nodeExportFileSystem,
): Promise<SaveOutcome> {
  if (!withinSizeCap(text)) return { kind: "failed" };
  const pick = await pickSavePath({ defaultName: defaultBundleFileName(now) });
  if (pick.kind === "picked") return writeBundleFile(text, pick.path, vaultBasePath, fs);
  return { kind: pick.kind };
}
