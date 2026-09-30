/**
 * Parsers for the git output the service reads (D-09, PR-05).
 *
 * All input is untrusted text: branch names, commit subjects and remote
 * URLs come from the repository and can contain anything a filename or a
 * commit message can. Every value is returned as data and never
 * interpreted — no parser here evaluates, unescapes or re-parses a subject
 * or branch name, and the plugin renders them as text nodes (D-14). No
 * author is ever parsed or returned (RR-08, privacy). Remote URLs are
 * normalised the moment they are read, so a raw URL (and any userinfo it
 * carries) never leaves this module (D-13).
 *
 * The functions are total: malformed records are skipped, never thrown on.
 */
import { MAX_BRANCH_LENGTH } from "@ccc/domain";
import { type NormalisedRemote, normaliseRemote } from "./github-url.js";

/** Summary of `git status --porcelain=v2 --branch -z`. */
export interface StatusSummary {
  /** `null` when HEAD is detached or no `branch.head` header was read. */
  readonly branch: string | null;
  readonly detached: boolean;
  /** The branch has no commits yet (`# branch.oid (initial)`). */
  readonly unborn: boolean;
  readonly dirty: boolean;
}

/** One commit from `git log -z --format=%h%x1f%ct%x1f%s`. No author field exists. */
export interface ParsedCommit {
  readonly hash: string;
  /** ISO-8601 UTC, from the committer timestamp in epoch seconds. */
  readonly committedAt: string;
  readonly subject: string;
}

/** One fetch remote, already normalised: the raw URL is not kept. */
export interface ParsedRemote {
  readonly name: string;
  readonly remote: NormalisedRemote;
}

/** One `git config -z --show-scope --get-regexp` entry. `value` is `null` for a bare boolean key. */
export interface ConfigScopeEntry {
  readonly scope: string;
  readonly name: string;
  readonly value: string | null;
}

const NUL = String.fromCharCode(0);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const MAX_COMMITS = 5;
/** Matches the domain GitCommitSchema subject limit, so one long subject cannot invalidate a snapshot. */
const MAX_SUBJECT_LENGTH = 1000;
const SHORT_HASH = /^[0-9a-f]{7,40}$/;
const EPOCH_SECONDS = /^\d{1,12}$/;

/** Porcelain v2 entry records: ordinary, rename/copy, unmerged, untracked. */
function isChangeRecord(record: string): boolean {
  return (
    record.startsWith("1 ") ||
    record.startsWith("2 ") ||
    record.startsWith("u ") ||
    record.startsWith("? ")
  );
}

/** Parses NUL-separated porcelain v2 output. Only `# branch.*` headers and entry-record prefixes are read. */
export function parseStatusPorcelainV2(stdout: string): StatusSummary {
  let branch: string | null = null;
  let detached = false;
  let unborn = false;
  let dirty = false;
  const fields = stdout.split(NUL);
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i] ?? "";
    if (record.startsWith("2 ")) {
      // With -z a rename/copy record is followed by its original path as a
      // separate field; skip it so a crafted filename is never read as a header.
      dirty = true;
      i += 1;
      continue;
    }
    if (isChangeRecord(record)) {
      dirty = true;
      continue;
    }
    if (dirty) continue; // headers precede every entry record
    if (record === "# branch.oid (initial)") {
      unborn = true;
    } else if (record === "# branch.head (detached)") {
      detached = true;
      branch = null;
    } else if (record.startsWith("# branch.head ")) {
      branch = capBranch(record.slice("# branch.head ".length));
      detached = false;
    }
  }
  return { branch, detached, unborn, dirty };
}

/** The first `max` UTF-16 units of `text`, never ending on half of a surrogate pair. */
function cutAt(text: string, max: number): string {
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function capSubject(subject: string): string {
  if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  return cutAt(subject, MAX_SUBJECT_LENGTH);
}

const TRUNCATION_MARKER = "…";

/**
 * Git limits each ref component, not a whole branch name, so a valid
 * branch can exceed the wire limit. It is cut to fit with a trailing `…`
 * so one repository cannot invalidate a snapshot or delta, and the
 * display still shows the name was shortened. Display only: no caller
 * resolves a ref from this value.
 */
function capBranch(branch: string): string {
  if (branch.length <= MAX_BRANCH_LENGTH) return branch;
  return `${cutAt(branch, MAX_BRANCH_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * Parses NUL-separated log records whose fields are joined by U+001F:
 * hash, committer epoch seconds, subject. The subject is everything after
 * the second separator, so a separator inside a subject stays in it.
 * Malformed records are skipped; at most five commits are returned.
 */
export function parseLogRecords(stdout: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const record of stdout.split(NUL)) {
    if (commits.length >= MAX_COMMITS) break;
    const first = record.indexOf(UNIT_SEPARATOR);
    if (first < 0) continue;
    const second = record.indexOf(UNIT_SEPARATOR, first + 1);
    if (second < 0) continue;
    const hash = record.slice(0, first).trim();
    const seconds = record.slice(first + 1, second);
    if (!SHORT_HASH.test(hash) || !EPOCH_SECONDS.test(seconds)) continue;
    const date = new Date(Number(seconds) * 1000);
    if (Number.isNaN(date.getTime())) continue;
    commits.push({
      hash,
      committedAt: date.toISOString(),
      subject: capSubject(record.slice(second + 1)),
    });
  }
  return commits;
}

const REMOTE_LINE = /^(\S+)\t(.+) \((fetch|push)\)$/;

/** Parses `git remote -v`, keeping `(fetch)` lines only and normalising each URL immediately. */
export function parseRemoteLines(stdout: string): ParsedRemote[] {
  const remotes: ParsedRemote[] = [];
  for (const line of stdout.split("\n")) {
    const match = REMOTE_LINE.exec(line);
    if (match === null || match[3] !== "fetch") continue;
    const [, name, url] = match;
    if (name === undefined || url === undefined) continue;
    remotes.push({ name, remote: normaliseRemote(url) });
  }
  return remotes;
}

/** Prefers `origin`, else the first GitHub remote, else the first remote; `null` when there is none. */
export function selectRemote(remotes: readonly ParsedRemote[]): ParsedRemote | null {
  return (
    remotes.find((r) => r.name === "origin") ??
    remotes.find((r) => r.remote.kind === "github") ??
    remotes[0] ??
    null
  );
}

/**
 * Config keys whose value is a command git may run while the service reads
 * status, log or remotes (RESEARCH Pattern 3). Written in git's canonical
 * key form (section and variable lower-cased), for
 * `git config --get-regexp`, which matches case-sensitively against that
 * canonical form.
 */
export const LOCAL_EXEC_KEY_PATTERN =
  "^(filter\\..+\\.(clean|smudge|process)|diff\\..+\\.(command|textconv)|diff\\.external|merge\\..+\\.driver|core\\.(fsmonitor|sshcommand|gitproxy|askpass|editor|pager|alternaterefscommand)|gpg(\\..+)?\\.program|sequence\\.editor)$";

/** The same pattern, case-insensitive, for matching parsed entries. */
export const LOCAL_EXEC_KEY_REGEX = new RegExp(LOCAL_EXEC_KEY_PATTERN, "i");

/**
 * Scopes whose configuration the owner controls. Everything else — `local`,
 * `worktree`, and any scope git may add or report as `unknown` — is
 * repository-supplied and untrusted. `command` is the service's own `-c`.
 */
const TRUSTED_SCOPES = new Set(["system", "global", "command"]);

/** The values `git lfs install` writes; the only local executable drivers allowed (PR-05). */
const GIT_LFS_CANONICAL: Readonly<Record<string, string>> = {
  "filter.lfs.clean": "git-lfs clean -- %f",
  "filter.lfs.smudge": "git-lfs smudge -- %f",
  "filter.lfs.process": "git-lfs filter-process",
};

/**
 * Executable keys the git runner overrides in COMMAND scope on every call,
 * with the value it sets. Command scope outranks the repository's local and
 * worktree scopes, so a repository-supplied value for one of these keys
 * never takes effect: skipping the repository for it would only hide common
 * macOS repositories (Watchman / built-in fsmonitor users) for no gain.
 *
 * This is the SINGLE source of those overrides: the service builds its `-c`
 * list from it, so a key can only be exempted here by being overridden
 * there. Anything not listed — every other executable key — stays
 * fail-closed, and a multi-line value is still refused in every scope.
 */
export const NEUTRALISING_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "core.fsmonitor": "false",
  "core.pager": "cat",
});

/**
 * The exact arguments (after the git executable and any `-c` overrides)
 * the preflight runs. `-z` is what makes the output unambiguous: a config
 * value may contain a newline, and in line format a multi-line value shows
 * only its first line where the entry is printed, so
 * `filter.lfs.clean = "git-lfs clean -- %f\ntouch PWNED"` would look
 * canonical while git runs both lines. `--name-only` is deliberately absent:
 * the git-lfs allowlist needs the values. Exit status 1 with empty output
 * means nothing matched.
 */
export const LOCAL_EXEC_PREFLIGHT_ARGS: readonly string[] = Object.freeze([
  "config",
  "-z",
  "--show-scope",
  "--includes",
  "--get-regexp",
  LOCAL_EXEC_KEY_PATTERN,
]);

/**
 * Parses the output of {@link LOCAL_EXEC_PREFLIGHT_ARGS}: `-z` format only,
 * `scope NUL key LF value NUL` per entry (`scope NUL key NUL` for a bare
 * boolean key). Empty output parses to no entries.
 *
 * Returns `null` for anything else -- line-format output, truncated output
 * (no trailing NUL, or an odd number of fields), or an entry with an empty
 * scope or key. Line format is refused outright because it cannot be read
 * safely (see LOCAL_EXEC_PREFLIGHT_ARGS); a caller must treat `null` as
 * unsafe, which {@link hasLocalExecutableConfig} does.
 */
export function parseConfigScopeLines(stdout: string): ConfigScopeEntry[] | null {
  if (stdout === "") return [];
  if (!stdout.endsWith(NUL)) return null;
  const fields = stdout.slice(0, -1).split(NUL);
  if (fields.length % 2 !== 0) return null;
  const entries: ConfigScopeEntry[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const scope = fields[i] ?? "";
    const body = fields[i + 1] ?? "";
    const newline = body.indexOf("\n");
    const name = newline < 0 ? body : body.slice(0, newline);
    if (scope === "" || name === "") return null;
    entries.push({ scope, name, value: newline < 0 ? null : body.slice(newline + 1) });
  }
  return entries;
}

function hasLineBreak(value: string | null): boolean {
  return value !== null && (value.includes("\n") || value.includes("\r"));
}

/**
 * Decides the preflight from the raw stdout of
 * `git <-c overrides> ...LOCAL_EXEC_PREFLIGHT_ARGS`. Fails closed: true
 * (skip the repository, PR-05, E-2) when
 *   - the output is not well-formed `-z` output (line format, truncated),
 *   - any value, in any scope, contains a line feed or carriage return, or
 *   - any repository-supplied (non-trusted-scope) entry names a command git
 *     could run on read, other than the three canonical git-lfs values and
 *     the keys in {@link NEUTRALISING_OVERRIDES}.
 * Empty output (git exit 1: nothing matched) is safe.
 */
export function hasLocalExecutableConfig(stdout: string): boolean {
  const entries = parseConfigScopeLines(stdout);
  if (entries === null) return true;
  return entries.some((entry) => {
    if (hasLineBreak(entry.value)) return true;
    if (TRUSTED_SCOPES.has(entry.scope)) return false;
    if (!LOCAL_EXEC_KEY_REGEX.test(entry.name)) return false;
    const key = entry.name.toLowerCase();
    if (Object.hasOwn(NEUTRALISING_OVERRIDES, key)) return false;
    const canonical = GIT_LFS_CANONICAL[key];
    return canonical === undefined || entry.value !== canonical;
  });
}
