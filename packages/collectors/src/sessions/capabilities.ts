/**
 * The Claude Code version capability table (SESS-18, PR-09).
 *
 * The version it is fed comes from the service-side `claude --version`
 * probe (05-12), which reports the *installed* binary, not the version each
 * running session was started with (RESEARCH C-7, Pitfall 10). So this table
 * decides the install-time minimum and the health display only. It never
 * gates a live session: per-session truth is hook shape validation plus the
 * status line's own `version` field.
 *
 * An absent or unparsable version is `unknown`, and an older one is
 * `unsupported`. Nothing is `supported` by default.
 */

/** The oldest Claude Code this integration supports: fork source and CLAUDE_PID arrived here. */
export const MIN_SUPPORTED_CLAUDE_VERSION = "2.1.214";

export type ClaudeCapability =
  | "fork-source"
  | "claude-pid"
  | "cross-project-resume"
  | "post-model-switch"
  | "sessionend-per-hook-timeout";

export interface CapabilityRow {
  /** The first Claude Code version with the capability. */
  readonly since: string;
  readonly capability: ClaudeCapability;
}

/** RESEARCH "State of the Art", each row cited there against the Claude Code docs. */
export const CAPABILITY_TABLE = [
  { since: "2.1.214", capability: "fork-source" },
  { since: "2.1.214", capability: "claude-pid" },
  { since: "2.1.223", capability: "cross-project-resume" },
  { since: "2.1.251", capability: "post-model-switch" },
  { since: "2.1.268", capability: "sessionend-per-hook-timeout" },
] as const satisfies readonly CapabilityRow[];

export type SupportStatus = "supported" | "unsupported" | "unknown";

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** `[major, minor, patch]`, or null for anything that is not a plain three-part version. */
function parts(version: string): readonly [number, number, number] | null {
  const match = VERSION.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Numeric comparison of two three-part versions (2.1.99 < 2.1.214), usable
 * as a sort comparator. A version that does not parse sorts before every
 * one that does, so it can never pass a minimum check.
 */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (left === null || right === null) {
    return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  }
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The version in `claude --version` output (`2.1.283 (Claude Code)`), or null. */
export function parseClaudeVersionOutput(output: string): string | null {
  const match = /^\s*(\d{1,6}\.\d{1,6}\.\d{1,6})(?:\s|$)/.exec(output.slice(0, 256));
  return match?.[1] ?? null;
}

/** Every capability the given version has; none for a version that does not parse. */
export function capabilitiesFor(version: string): readonly ClaudeCapability[] {
  if (parts(version) === null) return [];
  return CAPABILITY_TABLE.filter((row) => compareVersions(version, row.since) >= 0).map(
    (row) => row.capability,
  );
}

/** Whether the installed version meets the minimum. Absent or unparsable is unknown. */
export function supportStatus(version: string | null): SupportStatus {
  if (version === null || parts(version) === null) return "unknown";
  return compareVersions(version, MIN_SUPPORTED_CLAUDE_VERSION) >= 0 ? "supported" : "unsupported";
}
