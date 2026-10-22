import { z } from "zod";

/**
 * Display paths for the health view, the Paths section and the bundle's
 * denylist (plan 08-01; D-15, D-16; threat T-08-02).
 *
 * A display path is the only path-shaped string the diagnostics contract
 * admits, and it is never absolute: `~` for the home folder, `~/rest` inside
 * it, and `…/<parent>/<name>` (the last two segments) for anything outside it.
 * The home folder's user segment therefore never reaches the screen or a public
 * bug report through an inside-home path, and an outside-home path that happens
 * to carry that segment has it masked as `…`.
 *
 * Pure string logic over POSIX paths (the project is macOS-only for v1); no
 * Node import, so the browser bundle can use it. The service's own
 * `toDisplayPath` in `project-views.ts` is a different contract: it returns an
 * outside-home path unchanged for the project list. Never persist the output:
 * `assertNoPrivatePathValues` in the plugin's settings throws on `~/` values.
 */

/** The longest display path the schema admits. */
export const DISPLAY_PATH_MAX_LENGTH = 512;

const ELLIPSIS = "…";

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * The segments of an absolute path with `.` dropped and each `..` removing the
 * segment before it (a `..` at the root has nothing to remove). Purely lexical:
 * a symlink is not followed, so this decides how the path is *shown*, never
 * where it points.
 */
function normalisedSegmentsOf(path: string): string[] {
  const out: string[] = [];
  for (const segment of segmentsOf(path)) {
    if (segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out;
}

/** Whether a display path's segment is acceptable: non-empty and never `.` or `..`. */
function isPlainSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}

function homeSegmentsOf(homeDir: string | null): string[] {
  if (homeDir === null || !homeDir.startsWith("/") || hasControlCharacter(homeDir)) return [];
  return normalisedSegmentsOf(homeDir);
}

/**
 * Turn an absolute path into a display string, or `null` when the input is not
 * an absolute path (empty, relative, the bare root, or carrying a NUL or other
 * control character) or normalises to the root. `.` and `..` are resolved
 * lexically first, so `~/..` is never produced: a path that climbs out of home
 * takes the outside rule. Trailing slashes on either argument change nothing.
 * Outside home, any shown segment that contains the user segment (any case) is
 * masked as `…`.
 * A null, empty, relative or root `homeDir` means "no home rule": every path
 * then takes the outside rule.
 */
export function toDisplayPath(absolute: string, homeDir: string | null): string | null {
  if (!absolute.startsWith("/") || hasControlCharacter(absolute)) return null;
  const segments = normalisedSegmentsOf(absolute);
  if (segments.length === 0) return null;

  const homeSegments = homeSegmentsOf(homeDir);

  if (
    homeSegments.length > 0 &&
    segments.length >= homeSegments.length &&
    homeSegments.every((segment, index) => segments[index] === segment)
  ) {
    const rest = segments.slice(homeSegments.length);
    return rest.length === 0 ? "~" : `~/${rest.join("/")}`;
  }

  const userSegment = homeSegments.at(-1)?.toLowerCase() ?? null;
  // Any shown segment that merely CONTAINS the user segment is masked too
  // (`/Volumes/USERNAME-backup/Vault` must not leak the name).
  const shown = segments
    .slice(-2)
    .map((segment) =>
      userSegment !== null && segment.toLowerCase().includes(userSegment) ? ELLIPSIS : segment,
    );
  return `${ELLIPSIS}/${shown.join("/")}`;
}

/**
 * {@link toDisplayPath}, but never longer than the schema allows (FIX2A F9). A path whose display form
 * is over {@link DISPLAY_PATH_MAX_LENGTH} (one very long folder name) falls back to its last segment,
 * `~/…/<name>` inside home and `…/<name>` outside, truncated on a code-point boundary to fit. Returns
 * null only for what {@link toDisplayPath} refuses. The result always passes {@link isDisplayPath},
 * so a hostile or accidental long path can never make a whole health response fail its schema.
 */
export function toBoundedDisplayPath(absolute: string, homeDir: string | null): string | null {
  const shown = toDisplayPath(absolute, homeDir);
  if (shown === null || isDisplayPath(shown)) return shown;
  const prefix = shown.startsWith("~/") ? `~/${ELLIPSIS}/` : `${ELLIPSIS}/`;
  const room = DISPLAY_PATH_MAX_LENGTH - prefix.length;
  let name = "";
  for (const character of shown.split("/").at(-1) ?? "") {
    if (name.length + character.length > room) break;
    name += character;
  }
  const bounded = `${prefix}${name}`;
  return isDisplayPath(bounded) ? bounded : null;
}

/** The shape check behind {@link DisplayPathSchema}, exported for the pure callers. */
export function isDisplayPath(value: string): boolean {
  if (value.length === 0 || value.length > DISPLAY_PATH_MAX_LENGTH) return false;
  if (hasControlCharacter(value)) return false;
  if (value === "~") return true;
  if (value.startsWith("~/")) return value.slice(2).split("/").every(isPlainSegment);
  if (value.startsWith(`${ELLIPSIS}/`)) {
    const rest = value.slice(ELLIPSIS.length + 1).split("/");
    return (rest.length === 1 || rest.length === 2) && rest.every(isPlainSegment);
  }
  return false;
}

/**
 * A `~`, `~/...` or `…/a/b` string. Refuses an absolute path, a NUL, a control
 * character, over 512 characters, and any empty, `.` or `..` segment (so
 * `~//x`, `~/../x` and `~/a/` are not display paths).
 */
export const DisplayPathSchema = z.string().refine(isDisplayPath, {
  message: "must be a display path, never an absolute path",
});
export type DisplayPath = z.infer<typeof DisplayPathSchema>;
