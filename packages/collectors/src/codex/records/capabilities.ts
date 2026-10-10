import {
  FORMAT_MIN_RATIO,
  FORMAT_MIN_SAMPLE,
  FORMAT_ZERO_SAMPLE,
  UNVERSIONED,
} from "../../transcripts/parse.js";

/**
 * Codex version handling and per-version recognition (CODEX-03, D-16,
 * RESEARCH Pitfall 9). Codex `cli_version` values mix releases and
 * prereleases (`0.159.2`, `0.155.0-alpha.9.2`, `0.58.0-alpha.10`), so the
 * Claude-only three-part comparator (`compareVersions`) would sort them as
 * unparsable. This module has its own parse and ordering and reuses only the
 * Phase 5 recognition THRESHOLDS.
 */

export { FORMAT_MIN_RATIO, FORMAT_MIN_SAMPLE, FORMAT_ZERO_SAMPLE, UNVERSIONED };

export interface CodexVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, or null for a release. */
  readonly prerelease: readonly string[] | null;
  readonly raw: string;
}

const MAX_VERSION_LENGTH = 64;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parses `x.y.z` with an optional `-prerelease` tail; anything else is null. */
export function parseCodexVersion(text: unknown): CodexVersion | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_VERSION_LENGTH)
    return null;
  const match = VERSION.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4].split("."),
    raw: text,
  };
}

const NUMERIC = /^\d+$/;

/** Semver prerelease identifier comparison: numeric < alphanumeric; numeric by value. */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const result = compareIdentifier(a[i] ?? "", b[i] ?? "");
    if (result !== 0) return result;
  }
  return Math.sign(a.length - b.length);
}

/**
 * Orders two Codex versions, usable as a sort comparator. A prerelease sorts
 * before its release; a version that does not parse sorts before every one
 * that does, so it can never be the newest.
 */
export function compareCodexVersions(a: string, b: string): number {
  const left = parseCodexVersion(a);
  const right = parseCodexVersion(b);
  if (left === null || right === null) {
    return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  }
  for (const [x, y] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Per full `cli_version` string: sessions examined and sessions whose rollout was recognised. */
export interface CodexVersionRecognition {
  readonly sessions: number;
  readonly recognized: number;
}

export type CodexRecognitionVerdict =
  | { readonly kind: "ok" }
  /**
   * Codex data reads "unavailable - format changed in v<version>". The version
   * is null when no failing key is a parsable version (a missing or off-shape
   * string is never rendered).
   */
  | { readonly kind: "unavailable"; readonly version: string | null };

/**
 * PR-11's per-version format-change rule applied to Codex: a version with at
 * least {@link FORMAT_MIN_SAMPLE} sessions and a recognition ratio below
 * {@link FORMAT_MIN_RATIO}, or at least {@link FORMAT_ZERO_SAMPLE} with none
 * recognised, makes Codex data unavailable. When several versions fail, the
 * newest by {@link compareCodexVersions} is named. The map is keyed by the
 * full version string; a missing version uses {@link UNVERSIONED}.
 */
export function evaluateCliRecognition(
  byVersion: Readonly<Record<string, CodexVersionRecognition>>,
): CodexRecognitionVerdict {
  const failing = Object.entries(byVersion)
    .filter(([, { sessions, recognized }]) => {
      if (sessions >= FORMAT_ZERO_SAMPLE && recognized === 0) return true;
      return sessions >= FORMAT_MIN_SAMPLE && recognized / sessions < FORMAT_MIN_RATIO;
    })
    .map(([version]) => version);
  if (failing.length === 0) return { kind: "ok" };
  const newest = failing
    .filter((version) => parseCodexVersion(version) !== null)
    .sort(compareCodexVersions)
    .at(-1);
  return { kind: "unavailable", version: newest ?? null };
}
