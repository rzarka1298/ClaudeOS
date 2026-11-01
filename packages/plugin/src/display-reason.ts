import { toDisplayPath } from "@ccc/domain/display-path.js";

const ELLIPSIS = "…";

/** The most of a reason that is scanned and shown. */
const MAX_REASON_CHARS = 2000;

/** Characters that end a path run: whitespace, quotes, a backtick and `,;()<>`. */
const STOP = "\\s\"'`,;()<>";
/** A path character (anything but a stop character). */
const PATH_CHAR = `[^${STOP}]`;
/** A path character that is not a slash. */
const NAME_CHAR = `[^${STOP}/]`;
/** A last path character: not a stop character and not sentence punctuation (`.`, `,`, `:`). */
const END_CHAR = `[^${STOP}.,:]`;

/**
 * An absolute POSIX path run: a `/`, then path characters up to the first stop character, never
 * ending in sentence punctuation. A name may contain single spaces, so the run is continued across
 * up to four space-separated words when they end in a word that contains a `/` and no word of the
 * continuation starts with one (`/Volumes/Macintosh HD/Users/USERNAME/s.sock`, `/Users/USERNAME TWO/s.sock`).
 * This errs on the side of hiding: a path followed by a few words and then a relative path is
 * replaced through that relative path. Two separate absolute paths in a sentence stay separate
 * because a continuation word never starts with `/`. Known limit: a space inside the LAST segment
 * (a bare `/Users/USERNAME TWO` with nothing after it) is not followed; socket paths are always deeper.
 */
const POSIX_RUN = `\\/${PATH_CHAR}*${END_CHAR}(?:(?: (?!\\/)${NAME_CHAR}+){0,4} (?!\\/)${NAME_CHAR}*\\/(?:${PATH_CHAR}*${END_CHAR})?)?`;

/** Parent folders whose direct child is a user's folder. */
const USER_PARENTS = new Set(["users", "home"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Whether the text carries a control character (a path with one is never a usable home). */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The home folder to match literally, or null when none is configured. */
function literalHome(homeDir: string | null): string | null {
  if (homeDir === null || !homeDir.startsWith("/") || hasControlCharacter(homeDir)) return null;
  const trimmed = homeDir.replace(/\/+$/, "");
  return trimmed.length > 1 ? trimmed : null;
}

/**
 * The matcher for one reason: a `~user/...` path or an absolute path with an
 * optional `file://` scheme. The configured home folder is tried first and matched literally, so a
 * home folder with a space maps to `~` whole.
 */
function buildMatcher(homeDir: string | null): RegExp {
  const home = literalHome(homeDir);
  const homeAlternative =
    home === null
      ? ""
      : `${escapeRegExp(home)}(?=$|[${STOP}/]|[.:](?=$|[${STOP}]))(?:${POSIX_RUN})?|`;
  const source =
    "(?<![\\w~./])(?:" +
    `(?<tilde>~${NAME_CHAR}+(?=\\/)${POSIX_RUN})` +
    `|(?:file:\\/\\/)?(?<posix>${homeAlternative}${POSIX_RUN})` +
    ")";
  return new RegExp(source, "g");
}

function normalisedSegments(path: string, separator: string): string[] {
  const out: string[] = [];
  for (const segment of path.split(separator)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out;
}

/**
 * When a path has a segment directly under a `Users` or `home` folder inside the two segments a
 * display path would show, that segment is a user name: show only what is below it (`…/<name>`),
 * or `…` when nothing is. Null when the user segment is not in the shown window.
 */
function withoutUserSegment(
  segments: readonly string[],
  separator: string,
  userName: string | null,
): string | null {
  const parent = segments.findIndex(
    (segment, index) => index + 1 < segments.length && USER_PARENTS.has(segment.toLowerCase()),
  );
  if (parent === -1) return null;
  const user = parent + 1;
  if (user === segments.length - 1) return ELLIPSIS;
  if (user === segments.length - 2)
    return `${ELLIPSIS}${separator}${maskUserName(segments[segments.length - 1] ?? "", userName)}`;
  return null;
}

/** The configured user name, lower-cased, for masking (the last segment of the home folder). */
function userNameOf(homeDir: string | null): string | null {
  if (homeDir === null) return null;
  const last = normalisedSegments(homeDir, "/").at(-1);
  return last === undefined ? null : last.toLowerCase();
}

/**
 * Keeps `toDisplayPath`'s rule when a segment is shown here instead: a shown name that merely
 * contains the user name (any case) is masked as `…` (Codex wave-2 fix review).
 */
function maskUserName(segment: string, userName: string | null): string {
  return userName !== null && segment.toLowerCase().includes(userName) ? ELLIPSIS : segment;
}

function displayPosix(path: string, homeDir: string | null): string {
  const shown = toDisplayPath(path, homeDir) ?? ELLIPSIS;
  if (shown === "~" || shown.startsWith("~/")) return shown;
  return withoutUserSegment(normalisedSegments(path, "/"), "/", userNameOf(homeDir)) ?? shown;
}

function displayTilde(path: string, userName: string | null): string {
  const last = normalisedSegments(path, "/").at(-1);
  return last === undefined || last === path
    ? ELLIPSIS
    : `${ELLIPSIS}/${maskUserName(last, userName)}`;
}

function decodeFileUrlPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * A service disconnect reason with every absolute path shown as a display path (D-11, DIAG-06):
 * `~/…` inside the home folder, `…/<parent>/<name>` outside it, and never a user-name segment: a
 * segment directly under `/Users` or `/home` is dropped, a `~user/…` path is shown as `…/<name>`,
 * `file://` URLs are scrubbed like the path they carry, and paths with spaces are matched whole
 * (see POSIX_RUN). Node's net errors name the socket path, which carries the owner's user name;
 * this is the one place that is removed, applied where the event client's state becomes the
 * plugin's connection state so no render site can forget.
 *
 * Pure, and browser-safe: `toDisplayPath` is imported by its domain subpath, not a Node module.
 */
export function displayReason(reason: string, homeDir: string | null): string {
  // A disconnect reason is a short error line. Bounding what is scanned keeps the matcher's work small
  // whatever the text (FIX15); anything past the bound is dropped, never shown unscrubbed.
  const bounded =
    reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}${ELLIPSIS}` : reason;
  return bounded.replace(buildMatcher(homeDir), (match, ...rest) => {
    const groups = rest.at(-1) as { tilde?: string; posix?: string };
    if (groups.tilde !== undefined) return displayTilde(groups.tilde, userNameOf(homeDir));
    const posix = groups.posix ?? match;
    const isFileUrl = match.startsWith("file://");
    return displayPosix(isFileUrl ? decodeFileUrlPath(posix) : posix, homeDir);
  });
}
