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
  out = out.replace(/\/Users\/([^/\s"'`()<>]+)/g, (match, name: string) =>
    name === "USERNAME" ? match : HOME_PLACEHOLDER,
  );
  out = out
    .replace(/data:[a-z]+\/[a-z0-9.+-]+[^\s)]*/gi, "[data-url]")
    .replace(/!\[/g, "[")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[0-9a-f]{40,}\b/gi, "[hash]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (hasMixedCharacters(run) ? "[token]" : run));

  out = out.replace(/\s+/g, " ").trim();
  const limit = Math.max(4, options.maxLength ?? DEFAULT_MAX_LENGTH);
  return out.length <= limit ? out : `${out.slice(0, limit - 3)}...`;
}
