import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import { isStrictlyInside, realResolve } from "./plugin-data.js";
import { REPO_ROOT } from "./repo-paths.js";

/**
 * Screenshot folder, purge and guarded region capture (05.2-04, D-12, E2E-05, PRIV-04, T-05.2-14).
 *
 * Rules, enforced by construction and pinned by screenshots.test.ts:
 * - Page screenshots are taken by the specs with the wdio page screenshot call (it captures only
 *   the Obsidian page, never other windows) and saved through `shotPath` into a mode-0700 folder
 *   OUTSIDE the repository (`createShotsDir`).
 * - The macOS screen-capture tool is used only by `captureRegion`, only for the notification
 *   banner in the notification look spec, and only for a small validated top-right rectangle: a
 *   full-screen capture can include the owner's other windows and mail or chat banners.
 * - Deletion discipline: Claude views an image once, records a verdict, then the folder is
 *   deleted (`deleteShotsDir`); stale folders from earlier runs are purged at start
 *   (`purgeStaleShotDirs`). Images are never committed, quoted or attached; the report carries
 *   counts only (PRIV-04).
 * - Spike S4 (banner region capture with another app frontmost) was NOT run: the region capture
 *   stays auto+look-pending or owner until it is proven.
 */

export const SHOTS_PREFIX = "ccc-uat-shots-";

const RUN_ID = /^[A-Za-z0-9-]{1,40}$/;
const LABEL = /^[a-z0-9-]{1,60}$/;
const MAX_COORDINATE = 10_000;

/** Folders under the home directory that sync or share documents; shots never go there. */
const HOME_DOCUMENT_FOLDERS = ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"];

function isInsideOrEqual(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/**
 * Creates `<base>/ccc-uat-shots-<runId>` with mode exactly 0700 (repairing a looser existing
 * mode). The base defaults to the system temporary folder and is refused when it is, or is
 * inside, the repository or the home directory's document folders. An explicit override goes
 * through the same checks.
 */
export function createShotsDir(input: {
  base?: string;
  runId: string;
  repoRoot?: string;
  homeDir?: string;
}): string {
  if (!RUN_ID.test(input.runId)) throw new Error("The run id for the shots folder is not plain.");
  const base = input.base ?? tmpdir();
  if (!isAbsolute(base)) throw new Error("The shots base folder must be an absolute path.");
  const realBase = realResolve(base);
  if (isInsideOrEqual(realResolve(input.repoRoot ?? REPO_ROOT), realBase)) {
    throw new Error("The shots folder must be outside the repository.");
  }
  const home = input.homeDir ?? homedir();
  for (const name of HOME_DOCUMENT_FOLDERS) {
    if (isInsideOrEqual(realResolve(join(home, name)), realBase)) {
      throw new Error("The shots folder must not be inside the home document folders.");
    }
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = join(base, `${SHOTS_PREFIX}${input.runId}`);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new Error("The shots folder must not be a symbolic link.");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** `<dir>/<NN>-<label>.png` for a two-digit item and a label of lowercase letters, digits, hyphens. */
export function shotPath(dir: string, item: number, label: string): string {
  if (!Number.isInteger(item) || item < 0 || item > 99) {
    throw new Error("The shot item number must be an integer from 0 to 99.");
  }
  if (!LABEL.test(label)) {
    throw new Error("The shot label must be lowercase letters, digits and hyphens.");
  }
  return join(dir, `${String(item).padStart(2, "0")}-${label}.png`);
}

/** Throws unless `file` is a .png strictly inside `dir`. */
export function assertShotInside(dir: string, file: string): void {
  if (!file.endsWith(".png") || !isStrictlyInside(dir, file)) {
    throw new Error("The screenshot path is not a png inside the shots folder.");
  }
}

/**
 * Removes every `ccc-uat-shots-*` folder in `base` whose run id is not in `keepRunIds`. A symbolic
 * link with such a name is unlinked, never followed; other entries are left alone.
 */
export function purgeStaleShotDirs(input: {
  base: string;
  keepRunIds: readonly string[];
  /**
   * When given, only folders last modified longer ago than this are removed, so the images and
   * look-pending state of a recent, not yet judged run survive a later run (Wave 3 WR-03).
   */
  maxAgeMs?: number;
  now?: number;
}): string[] {
  if (!existsSync(input.base)) return [];
  const now = input.now ?? Date.now();
  const removed: string[] = [];
  for (const name of readdirSync(input.base).sort()) {
    if (!name.startsWith(SHOTS_PREFIX)) continue;
    if (input.keepRunIds.includes(name.slice(SHOTS_PREFIX.length))) continue;
    const path = join(input.base, name);
    const stat = lstatSync(path);
    if (input.maxAgeMs !== undefined && now - stat.mtimeMs < input.maxAgeMs) continue;
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
      removed.push(name);
    } else if (stat.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

function assertShotsDirName(dir: string): void {
  const name = basename(dir);
  if (!name.startsWith(SHOTS_PREFIX) || name.length === SHOTS_PREFIX.length) {
    throw new Error("The path is not a screenshots folder.");
  }
}

/** Deletes the folder and every image in it; false when it is already gone. */
export function deleteShotsDir(dir: string): boolean {
  assertShotsDirName(dir);
  if (!existsSync(dir) && !isDanglingLink(dir)) return false;
  if (lstatSync(dir).isSymbolicLink()) {
    unlinkSync(dir);
    return true;
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** argv for the macOS screen-capture tool: quiet flag, region flag, rectangle, output path. */
export function regionArgs(rect: Rect, outPath: string): string[] {
  for (const value of [rect.x, rect.y, rect.w, rect.h]) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_COORDINATE) {
      throw new Error("The capture region must be four integers from 0 to 10000.");
    }
  }
  if (outPath === "") throw new Error("The capture output path is empty.");
  return ["-x", "-R", `${rect.x},${rect.y},${rect.w},${rect.h}`, outPath];
}

export interface CaptureDeps {
  execFile: (file: string, args: readonly string[]) => Promise<void>;
}

const execFileAsync = promisify(execFile);
const SCREENCAPTURE = "/usr/sbin/screencapture";

/**
 * Captures one small screen region (the notification banner only) to a png inside the shots
 * folder. The output path is checked BEFORE the tool runs; there is no shell.
 */
export async function captureRegion(input: {
  shotsDir: string;
  outPath: string;
  rect: Rect;
  deps?: CaptureDeps;
}): Promise<string> {
  assertShotsDirName(input.shotsDir);
  assertShotInside(input.shotsDir, input.outPath);
  const args = regionArgs(input.rect, input.outPath);
  const run =
    input.deps?.execFile ??
    (async (file: string, argv: readonly string[]) => {
      await execFileAsync(file, [...argv]);
    });
  await run(SCREENCAPTURE, args);
  return input.outPath;
}
