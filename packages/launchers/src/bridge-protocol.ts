/**
 * The TypeScript mirror of the codex-bridge protocol (D-12): the constants and the small
 * algorithms of `scripts/codex/antigravity-extension/bridge-core.js` that the service needs to
 * speak the same file queue the installed helper reads. `@ccc/test-fixtures` runs a parity test
 * (`bridge-protocol-parity.test.ts`) that loads the JavaScript module and compares every constant,
 * `bridgeStateDir`, `projectDirName` and `projectStateCandidates`, so the two cannot drift.
 *
 * Pure: the only Node import is the hash function; the path arithmetic is written out so this
 * module touches no filesystem, process or environment (the caller passes `env` and `home`).
 */
import { createHash } from "node:crypto";
import { AGENT_BANNED_TOKENS } from "./agent-launch.js";

export const BRIDGE_PROTOCOL_VERSION = 2;
export const BRIDGE_CAPABILITIES: readonly string[] = ["follow", "tui", "agent"];
export const BRIDGE_RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{9}Z$/;
export const BRIDGE_REQUEST_FILE_PATTERN = /^[0-9]{8}T[0-9]{9}Z\.json$/;
export const BRIDGE_KINDS: readonly string[] = ["review", "task", "resume", "agent"];
export const BRIDGE_MODES: readonly string[] = ["follow", "tui", "agent"];
export const BRIDGE_ROLES: readonly string[] = ["review", "plan", "task", "chore"];
export const BRIDGE_TTL_MS = 10 * 60 * 1000;
export const BRIDGE_FUTURE_SKEW_MS = 60 * 1000;
export const BRIDGE_HEARTBEAT_FRESH_MS = 90 * 1000;
export const BRIDGE_CONTAIN_DELAY_MS = 2000;
export const BRIDGE_CLAIMED_KEEP_MS = 24 * 60 * 60 * 1000;
export const BRIDGE_DIRECTORY_NAMES = {
  requests: "requests",
  claimed: "claimed",
  windows: "windows",
  prompts: "prompts",
  tui: "tui",
} as const;
export const BRIDGE_PROTOCOL_MARKER_FILE = "protocol.json";
export const BRIDGE_BANNED_TOKENS: readonly string[] = AGENT_BANNED_TOKENS;
/**
 * Every kind of file a wrapper run writes under `<main>/.planning/codex/`; in-repo state is used
 * only where git ignores all of them.
 */
export const BRIDGE_STATE_PROBES: readonly string[] = [
  "reports/x-review.json",
  "reports/x-review.md",
  "reports/x-task.json",
  "sessions/x.json",
  "live/x-task.log",
  "live/x-task.jsonl",
  "live/current.log",
  "live/.current.1.tmp",
  "pending-resume.json",
  "x.json.1.tmp",
].map((p) => `.planning/codex/${p}`);

/** `path.posix.join` for the shapes this module builds: empty parts dropped, dot segments resolved. */
function joinPosix(...parts: string[]): string {
  const joined = parts.filter((part) => part.length > 0).join("/");
  if (joined === "") return ".";
  const absolute = joined.startsWith("/");
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  const body = out.join("/");
  if (absolute) return `/${body}`;
  return body === "" ? "." : body;
}

/** `path.posix.basename`: the last segment, trailing slashes ignored. */
function basenamePosix(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  const trimmed = path.slice(0, end);
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** The user-level bridge state dir: `$XDG_STATE_HOME/codex-bridge`, or `~/.local/state/codex-bridge`. */
export function bridgeStateDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg?.startsWith("/") ? xdg : joinPosix(home, ".local", "state");
  return joinPosix(base, "codex-bridge");
}

/** The fixed helper every bridge terminal runs. */
export function bridgeCommandPath(home: string): string {
  return joinPosix(home, ".local", "bin", "codex-bridge");
}

/** `<name>-<hash>`: the user-level per-project directory name for a main checkout path. */
export function projectDirName(main: string): string {
  const name =
    basenamePosix(main)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 40) || "project";
  const hash = createHash("sha256").update(main).digest("hex").slice(0, 10);
  return `${name}-${hash}`;
}

/**
 * Both places the wrapper may keep a project's run records: in the repo when git ignores the
 * probes, else under the user-level bridge state. A reader scans both and merges.
 */
export function projectStateCandidates(main: string, stateDir: string): string[] {
  return [
    joinPosix(main, ".planning", "codex"),
    joinPosix(stateDir, "projects", projectDirName(main)),
  ];
}

const MAX_RUN_ID_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z, the last four-digit year

/** `YYYYMMDDTHHMMSSmmmZ` for a millisecond timestamp (the shape `BRIDGE_RUN_ID_PATTERN` requires). */
export function formatBridgeRunId(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_RUN_ID_MS) {
    throw new RangeError("run id milliseconds out of range");
  }
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

/** The millisecond timestamp a run id encodes, or null when the id is not a real instant. */
export function parseBridgeRunId(id: string): number | null {
  if (typeof id !== "string" || !BRIDGE_RUN_ID_PATTERN.test(id)) return null;
  const ms = Date.UTC(
    Number(id.slice(0, 4)),
    Number(id.slice(4, 6)) - 1,
    Number(id.slice(6, 8)),
    Number(id.slice(9, 11)),
    Number(id.slice(11, 13)),
    Number(id.slice(13, 15)),
    Number(id.slice(15, 18)),
  );
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_RUN_ID_MS) return null;
  return formatBridgeRunId(ms) === id ? ms : null;
}

/**
 * A minter of strictly increasing run ids (Pitfall 3). The queue refuses a second request with the
 * same file name and the pair launch mints Claude's id first, so the next id is the greater of the
 * clock reading and the previous millisecond plus one: a frozen, coarse or backwards clock still
 * yields unique, ordered ids. A non-finite clock reading counts as no reading.
 */
export function createRunIdMinter(now: () => number): () => string {
  let last = -1;
  return () => {
    let reading = Number.NaN;
    try {
      reading = Math.floor(now());
    } catch {
      reading = Number.NaN;
    }
    const ms = Number.isFinite(reading) ? Math.max(reading, last + 1) : last + 1;
    last = ms;
    return formatBridgeRunId(ms);
  };
}
