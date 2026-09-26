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

/** One `git config --show-scope --get-regexp` entry. `value` is `null` for `--name-only` output. */
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
      branch = record.slice("# branch.head ".length);
      detached = false;
    }
  }
  return { branch, detached, unborn, dirty };
}

function capSubject(subject: string): string {
  if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  let cut = subject.slice(0, MAX_SUBJECT_LENGTH);
  // Never leave half of a surrogate pair at the end.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
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

function parseEntryBody(scope: string, body: string, separator: string): ConfigScopeEntry | null {
  const at = body.indexOf(separator);
  const name = at < 0 ? body : body.slice(0, at);
  if (scope === "" || name === "") return null;
  return { scope, name, value: at < 0 ? null : body.slice(at + 1) };
}

/**
 * Parses `git config --show-scope --includes --get-regexp` output.
 *
 * Two formats are accepted:
 *   - `-z` (what the service should run): `scope NUL key LF value NUL`.
 *     Unambiguous — a multi-line value stays inside its entry.
 *   - line format: `scope TAB key SP value LF` (or `scope TAB key` with
 *     `--name-only`). A config value may contain a newline, and its second
 *     line can then imitate another entry, so this format must not be used
 *     for the security decision when values matter.
 */
export function parseConfigScopeLines(stdout: string): ConfigScopeEntry[] {
  const entries: ConfigScopeEntry[] = [];
  if (stdout.includes(NUL)) {
    const fields = stdout.split(NUL);
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const entry = parseEntryBody(fields[i] ?? "", fields[i + 1] ?? "", "\n");
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const entry = parseEntryBody(line.slice(0, tab), line.slice(tab + 1), " ");
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * True when any repository-supplied (non-trusted-scope) entry names a
 * command git could run on read, other than the three canonical git-lfs
 * filter values. The service skips such a repository entirely (PR-05, E-2).
 */
export function hasLocalExecutableConfig(entries: readonly ConfigScopeEntry[]): boolean {
  return entries.some((entry) => {
    if (TRUSTED_SCOPES.has(entry.scope)) return false;
    if (!LOCAL_EXEC_KEY_REGEX.test(entry.name)) return false;
    const canonical = GIT_LFS_CANONICAL[entry.name.toLowerCase()];
    return canonical === undefined || entry.value !== canonical;
  });
}
