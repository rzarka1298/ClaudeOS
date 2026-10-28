import { toDisplayPath } from "@ccc/domain/display-path.js";

/**
 * Every absolute-path run in free text: a `/` that does not follow a word character, `~`, `.` or
 * another `/` (so `logs/x`, `./x`, `~/x` stay), then characters up to whitespace, a quote, a
 * backtick or one of `,;()<>`, never ending in `.`, `,` or `:` (sentence punctuation stays outside
 * the match). At least one character must follow the slash, so a lone `/` is left alone.
 */
const ABSOLUTE_PATH = /(?<![\w~./])\/[^\s"'`,;()<>]*[^\s"'`,;()<>.,:]/g;

/**
 * A service disconnect reason with every absolute path shown as a display path (D-11, DIAG-06):
 * `~/…` inside the home folder, `…/<parent>/<name>` outside it. Node's net errors name the socket
 * path, which carries the owner's user name; this is the one place that is removed, applied where
 * the event client's state becomes the plugin's connection state so no render site can forget.
 *
 * Pure, and browser-safe: `toDisplayPath` is imported by its domain subpath, not a Node module.
 */
export function displayReason(reason: string, homeDir: string | null): string {
  return reason.replace(ABSOLUTE_PATH, (match) => toDisplayPath(match, homeDir) ?? "…");
}
