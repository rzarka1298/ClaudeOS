export interface SanitizeOptions {
  /** The running user's home directory; replaced with the /Users/USERNAME placeholder. */
  readonly homeDir?: string | undefined;
  readonly maxLength?: number | undefined;
}

const DEFAULT_MAX_LENGTH = 300;
const HOME_PLACEHOLDER = "/Users/USERNAME";

function hasMixedCharacters(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
}

/** A single-case letters-and-digits run with a digit: token-shaped, unlike a path or kebab name. */
function isSingleCaseAlnumWithDigit(run: string): boolean {
  return /^[a-z0-9]+$/.test(run) !== /^[A-Z0-9]+$/.test(run) && /\d/.test(run);
}

/**
 * Makes assertion text safe to keep in a report or a results file (T-05.2-19, PRIV-04): home
 * paths, email addresses, long hex strings, token-shaped strings, control characters, markdown
 * images and data URLs are removed, and the result is bounded in length. It is idempotent.
 */
export function sanitizeText(text: string, options: SanitizeOptions = {}): string {
  let out = Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");

  const home = options.homeDir;
  if (home !== undefined && home !== "" && home !== "/")
    out = out.split(home).join(HOME_PLACEHOLDER);
  // A user name may hold spaces (up to three words) when a slash follows it; otherwise it ends
  // at the first space, as before.
  out = out.replace(
    /\/Users\/(?:([^/\s"'`()<>]+(?: [^/\s"'`()<>]+){0,2})(?=\/)|([^/\s"'`()<>]+))/g,
    (match, spaced: string | undefined, plain: string | undefined) =>
      (spaced ?? plain) === "USERNAME" ? match : HOME_PLACEHOLDER,
  );
  out = out
    .replace(/data:[a-z]+\/[a-z0-9.+-]+[^\s)]*/gi, "[data-url]")
    // A markdown link to an image file, with or without the leading `!`, keeps no path.
    .replace(
      /!?\[[^\]]*\]\([^)]*\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|svg)(?:[?#][^)]*)?\)/gi,
      "[image]",
    )
    .replace(/!\[/g, "[")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[hash]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) =>
      hasMixedCharacters(run) || isSingleCaseAlnumWithDigit(run) ? "[token]" : run,
    );

  out = out.replace(/\s+/g, " ").trim();
  const limit = Math.max(4, options.maxLength ?? DEFAULT_MAX_LENGTH);
  return out.length <= limit ? out : `${out.slice(0, limit - 3)}...`;
}
