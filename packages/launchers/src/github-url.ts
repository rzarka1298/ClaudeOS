/**
 * Git remote normalisation and GitHub URL construction (D-13, PROJ-08).
 *
 * A remote URL is untrusted repository data and may carry credentials in
 * its userinfo (`https://user:token` followed by the at-sign and host). The
 * rule here is the Don't Hand-Roll "URL validation" row: parse with
 * `new URL()` (or the scp-like grammar git itself uses), copy out only the
 * host and path, and never copy `username`/`password` — so userinfo is gone
 * before any other code sees the value. A GitHub URL is never passed
 * through; it is rebuilt as `https://github.com/{owner}/{repo}` from parts
 * that matched GitHub's own name patterns.
 *
 * Every function except {@link githubRepoUrl} is total (never throws).
 */

export type NormalisedRemote =
  | { readonly kind: "github"; readonly owner: string; readonly repo: string }
  | { readonly kind: "other"; readonly host: string; readonly path: string }
  | { readonly kind: "invalid" };

/** GitHub user/organisation names: letters, digits, hyphens, at most 39. */
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
/** GitHub repository names: letters, digits, dot, underscore, hyphen, at most 100 (and never `.` or `..`). */
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOST = "github.com";

/** URL schemes git accepts for a network remote. `file:` and local paths are not remotes we display. */
const NETWORK_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/**
 * git's scp-like form: optional userinfo (which may itself hold a colon,
 * as in `user:password`) plus the at-sign, a host, a colon, then the path.
 * git only treats it as scp-like when no slash precedes the first colon.
 */
const SCP_LIKE = /^(?:[^@/]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/;
const HOSTNAME = /^[a-z0-9.-]{1,253}$/;
const MAX_PATH_LENGTH = 512;

function isValidRepoName(repo: string): boolean {
  return GITHUB_REPO_PATTERN.test(repo) && repo !== "." && repo !== "..";
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Reduces a host and raw path to the tagged result, stripping slashes and a trailing `.git`. */
function classify(rawHost: string, rawPath: string): NormalisedRemote {
  const host = rawHost.toLowerCase();
  if (!HOSTNAME.test(host)) return { kind: "invalid" };
  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (path === "" || path.length > MAX_PATH_LENGTH || hasControlCharacter(path)) {
    return { kind: "invalid" };
  }
  if (host === GITHUB_HOST) {
    const segments = path.split("/");
    const [owner, repo] = segments;
    if (
      segments.length === 2 &&
      owner !== undefined &&
      repo !== undefined &&
      GITHUB_OWNER_PATTERN.test(owner) &&
      isValidRepoName(repo)
    ) {
      return { kind: "github", owner, repo };
    }
  }
  return { kind: "other", host, path };
}

/** Normalises a raw remote URL. Userinfo never survives into the result. */
export function normaliseRemote(raw: string): NormalisedRemote {
  const value = raw.trim();
  if (value === "" || hasControlCharacter(value)) return { kind: "invalid" };

  if (HAS_SCHEME.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { kind: "invalid" };
    }
    if (!NETWORK_PROTOCOLS.has(parsed.protocol) || parsed.hostname === "") {
      return { kind: "invalid" };
    }
    // Only hostname and pathname are read; username and password are never touched.
    return classify(parsed.hostname, parsed.pathname);
  }

  const scp = SCP_LIKE.exec(value);
  if (scp === null) return { kind: "invalid" };
  const [, host, path] = scp;
  if (host === undefined || path === undefined) return { kind: "invalid" };
  return classify(host, path);
}

/** Rebuilds the repository URL from validated parts. Throws when either part is outside GitHub's name patterns. */
export function githubRepoUrl(owner: string, repo: string): string {
  if (!GITHUB_OWNER_PATTERN.test(owner) || !isValidRepoName(repo)) {
    throw new RangeError("not a valid GitHub owner and repository name");
  }
  return `https://${GITHUB_HOST}/${owner}/${repo}`;
}

/**
 * Accepts an owner-typed GitHub link only when it is exactly
 * `https://github.com/{owner}/{repo}`: https, no userinfo, no port, no
 * query, no fragment, exactly two path segments. Anything else is `null`.
 */
export function parseGithubOverride(url: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== GITHUB_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) return null;
  if (!GITHUB_OWNER_PATTERN.test(owner) || !isValidRepoName(repo)) return null;
  // The typed text must be exactly the canonical form: this also refuses
  // anything URL parsing silently normalised away (":443", a bare "?", case).
  return githubRepoUrl(owner, repo) === url ? { owner, repo } : null;
}

/** Host and path for the plugin's display-only `Remote` row (RR-09); `null` for an invalid remote. */
export function remoteDisplay(remote: NormalisedRemote): { host: string; path: string } | null {
  switch (remote.kind) {
    case "github":
      return { host: GITHUB_HOST, path: `${remote.owner}/${remote.repo}` };
    case "other":
      return { host: remote.host, path: remote.path };
    case "invalid":
      return null;
  }
}
