import { readdir as readDirectory } from "node:fs/promises";
import { basename } from "node:path";
import {
  BundleIdSchema,
  type DetectedApp,
  type DetectionResponse,
  hasControlCharacter,
} from "@ccc/domain";
import { TERMINAL_PRESETS } from "@ccc/launchers";
import type { CodexDetection } from "../codex/detection.js";
import type { CommandRunner } from "./command-runner.js";
import { type GitResolution, resolveGit } from "./git-runner.js";
import { toDisplayPath } from "./project-views.js";
import { isExecutableFile } from "./terminal-launchers.js";

/**
 * Launcher detection (D-27, D-21, D-10, PROJ-11): what is installed on this
 * Mac, offered to the owner as PROPOSALS. Detection never saves anything and
 * never picks one of several matching bundles; the owner's explicit save
 * request does that (D-19, D-27), and the save route checks a bundle ID again
 * with {@link Detector.findBundle}.
 *
 * Apps: every candidate bundle ID ({@link CANDIDATE_BUNDLE_IDS}) is looked up
 * with Spotlight, `mdfind "kMDItemCFBundleIdentifier == '<id>'"` (a trailing
 * `*` matches a prefix: both Antigravity bundles are found by one query).
 * Each `.app` it names is confirmed by reading its own `Info.plist` with
 * `plutil`, so a stale index entry or an impostor never counts. Spotlight
 * can be off (CI, a disabled index) or stale, so when `mdfind` fails, finds
 * nothing, or names only paths that no longer hold the bundle, the detector
 * lists the Applications folders itself and reads every
 * bundle's `Info.plist` (RESEARCH Pattern 8). Each match is reported with its
 * bundle ID, display name and a location CATEGORY — never its path (T-04-09).
 *
 * The bundle ID is interpolated into a Spotlight query string (not a shell,
 * and passed as one argv element), so it must match
 * {@link DETECTION_QUERY_PATTERN} first; a value that does not never reaches
 * `mdfind` (T-04-10).
 *
 * The claude executable: the known install locations
 * ({@link CLAUDE_CANDIDATE_PATHS}) that are executable regular files. The
 * SYMLINK path is what gets proposed and stored, never its realpath:
 * `~/.local/bin/claude` points at a versioned binary under
 * `~/.local/share/claude/versions/…` and that target changes on every Claude
 * Code update, while the symlink stays put (D-21). The plugin sees each one
 * as an opaque `candidateId` and a home-abbreviated display path; the
 * absolute path stays in this process's memory, for the save route only.
 *
 * Every child runs through the injected {@link CommandRunner} with an argv
 * array and a fixed environment.
 */

/** A bundle ID, optionally with one trailing `*` (a prefix query). Nothing else reaches `mdfind`. */
export const DETECTION_QUERY_PATTERN = /^[A-Za-z0-9.-]+\*?$/;

/** The detection groups and the bundle ID (or prefix) each is looked up by (D-27). */
export const CANDIDATE_BUNDLE_IDS: Readonly<Record<keyof DetectionResponse["apps"], string>> = {
  terminal: "com.apple.Terminal",
  iterm2: "com.googlecode.iterm2",
  ghostty: "com.mitchellh.ghostty",
  wezterm: "com.github.wez.wezterm",
  "claude-desktop": "com.anthropic.claudefordesktop",
  antigravity: "com.google.antigravity*",
};

export interface ClaudeCandidate {
  /** Opaque to the plugin; resolved back to `path` by the detector only. */
  readonly candidateId: string;
  readonly path: string;
}

/** The known `claude` install locations, in proposal order (D-21). */
export function CLAUDE_CANDIDATE_PATHS(homeDir: string): readonly ClaudeCandidate[] {
  return [
    { candidateId: "local-bin", path: `${homeDir}/.local/bin/claude` },
    { candidateId: "homebrew", path: "/opt/homebrew/bin/claude" },
    { candidateId: "usr-local", path: "/usr/local/bin/claude" },
  ];
}

export interface DetectorDeps {
  readonly runner: CommandRunner;
  /** The resolved home directory (`resolveHomeDir`). */
  readonly homeDir: string;
  /** Lists a directory's entry names; defaults to `fs.promises.readdir`. Used by the Spotlight fallback. */
  readonly readdir?: (dir: string) => Promise<readonly string[]>;
  /** Regular file + `X_OK`; defaults to {@link isExecutableFile}. */
  readonly isExecutable?: (path: string) => Promise<boolean>;
  /** Defaults to `resolveGit(runner)` (D-10). */
  readonly resolveGit?: () => Promise<GitResolution>;
  readonly now?: () => Date;
  /**
   * Codex detection (plan 05.1-21). Optional: without it the response is
   * exactly what Phase 4 produced and no Codex candidate resolves.
   */
  readonly codex?: CodexDetection;
}

export interface Detector {
  /** Everything installed that a launcher could use. Proposes only; stores nothing. */
  detect(): Promise<DetectionResponse>;
  /** Whether an app with exactly this bundle ID is installed (the save-time check). */
  findBundle(bundleId: string): Promise<boolean>;
  /**
   * The absolute path of a claude candidate: the one the last detection
   * found or, when this service run has not detected it (a restart since the
   * plugin's detection — codex review 3, finding 3), the candidate's fixed
   * known location ({@link CLAUDE_CANDIDATE_PATHS}). `null` for any other ID.
   * Either way the path comes from the service, never from the request
   * (T-04-23), and the save still checks it is an executable file now.
   */
  candidatePath(candidateId: string): string | null;
  /**
   * The absolute path of a Codex candidate (plan 05.1-21): the known
   * location of its id, for the save route only. `null` for an unknown id or
   * when Codex detection is not wired.
   */
  codexCandidatePath(candidateId: string): string | null;
}

const MDFIND = "/usr/bin/mdfind";
const PLUTIL = "/usr/bin/plutil";
const RUN_ENV: Readonly<Record<string, string>> = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
const MDFIND_TIMEOUT_MS = 5000;
const PLUTIL_TIMEOUT_MS = 2000;
/** The domain caps each detection group at this many apps. */
const MAX_APPS_PER_GROUP = 32;
const MAX_NAME_LENGTH = 255;

interface FoundBundle {
  readonly path: string;
  readonly bundleId: string;
}

function defaultReaddir(dir: string): Promise<readonly string[]> {
  return readDirectory(dir);
}

/** Whether `bundleId` answers `query` (exact, or a prefix when the query ends in `*`). */
function matchesQuery(bundleId: string, query: string): boolean {
  return query.endsWith("*") ? bundleId.startsWith(query.slice(0, -1)) : bundleId === query;
}

function isAppPath(line: string): boolean {
  return line.startsWith("/") && line.endsWith(".app") && !hasControlCharacter(line);
}

function underDir(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`);
}

export function createDetector(deps: DetectorDeps): Detector {
  const readdir = deps.readdir ?? defaultReaddir;
  const isExecutable = deps.isExecutable ?? isExecutableFile;
  const findGit = deps.resolveGit ?? (() => resolveGit(deps.runner));
  const now = deps.now ?? (() => new Date());
  const homeApplications = `${deps.homeDir}/Applications`;
  /** The Spotlight fallback's folders: the system ones and the owner's own. */
  const fallbackDirs = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    homeApplications,
  ];
  /** The last detection's claude candidates, by id. Memory only (D-21). */
  let candidates = new Map<string, string>();

  const locationOf = (path: string): DetectedApp["location"] => {
    if (underDir(path, homeApplications)) return "user-applications";
    if (underDir(path, "/Applications") || underDir(path, "/System/Applications")) {
      return "applications";
    }
    return "other";
  };

  /** One `Info.plist` key, or `null` when plutil fails or the value is unusable. */
  const readPlistKey = async (app: string, key: string): Promise<string | null> => {
    const outcome = await deps.runner.run(
      PLUTIL,
      ["-extract", key, "raw", "-o", "-", `${app}/Contents/Info.plist`],
      { timeoutMs: PLUTIL_TIMEOUT_MS, env: RUN_ENV },
    );
    if (outcome.exitCode !== 0) return null;
    const value = outcome.stdout.trim();
    return value.length === 0 || hasControlCharacter(value) ? null : value;
  };

  const readBundleId = async (app: string): Promise<string | null> => {
    const value = await readPlistKey(app, "CFBundleIdentifier");
    return value !== null && BundleIdSchema.safeParse(value).success ? value : null;
  };

  /** Spotlight's answer for one query, or `null` when it failed. */
  const spotlight = async (query: string): Promise<string[] | null> => {
    const outcome = await deps.runner.run(MDFIND, [`kMDItemCFBundleIdentifier == '${query}'`], {
      timeoutMs: MDFIND_TIMEOUT_MS,
      env: RUN_ENV,
    });
    if (outcome.exitCode !== 0 || outcome.truncated) return null;
    return outcome.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(isAppPath);
  };

  /**
   * Every bundle in the fallback folders, with its bundle ID. Built at most
   * once per detection (`scanCache`), however many groups need it.
   */
  const scanFolders = async (): Promise<FoundBundle[]> => {
    const found: FoundBundle[] = [];
    for (const dir of fallbackDirs) {
      let entries: readonly string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".app") || entry.includes("/")) continue;
        const path = `${dir}/${entry}`;
        const bundleId = await readBundleId(path);
        if (bundleId !== null) found.push({ path, bundleId });
      }
    }
    return found;
  };

  /** The confirmed bundles answering `query`, Spotlight first, then the folder scan. */
  const lookup = async (
    query: string,
    scan: () => Promise<FoundBundle[]>,
  ): Promise<FoundBundle[]> => {
    if (!DETECTION_QUERY_PATTERN.test(query)) return [];
    const paths = await spotlight(query);
    if (paths !== null && paths.length > 0) {
      const unique = [...new Set(paths)];
      const confirmed = await Promise.all(
        unique.map(async (path) => ({ path, bundleId: await readBundleId(path) })),
      );
      const found = confirmed.flatMap((entry) =>
        entry.bundleId !== null && matchesQuery(entry.bundleId, query)
          ? [{ path: entry.path, bundleId: entry.bundleId }]
          : [],
      );
      // A stale index can name only paths that no longer hold the bundle
      // (an app moved or deleted): then the folder scan decides, exactly as
      // when Spotlight is off (wave-5 finding 9).
      if (found.length > 0) return found;
    }
    return (await scan()).filter((entry) => matchesQuery(entry.bundleId, query));
  };

  const describe = async (bundle: FoundBundle): Promise<DetectedApp> => {
    const plistName = await readPlistKey(bundle.path, "CFBundleName");
    const fallbackName = basename(bundle.path, ".app");
    const name = (plistName ?? fallbackName).slice(0, MAX_NAME_LENGTH) || bundle.bundleId;
    return { bundleId: bundle.bundleId, name, location: locationOf(bundle.path) };
  };

  /** A per-call memo, so the folder scan runs at most once. */
  const scanOnce = (): (() => Promise<FoundBundle[]>) => {
    let pending: Promise<FoundBundle[]> | null = null;
    return () => {
      pending ??= scanFolders();
      return pending;
    };
  };

  const detectApps = async (): Promise<DetectionResponse["apps"]> => {
    const scan = scanOnce();
    const groups = Object.entries(CANDIDATE_BUNDLE_IDS) as [
      keyof DetectionResponse["apps"],
      string,
    ][];
    const apps = {} as Record<keyof DetectionResponse["apps"], DetectedApp[]>;
    for (const [group, query] of groups) {
      const bundles = await lookup(query, scan);
      const described = await Promise.all(bundles.map(describe));
      const seen = new Set<string>();
      apps[group] = described
        .filter((found) => {
          const key = `${found.bundleId}\u0000${found.name}\u0000${found.location}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, MAX_APPS_PER_GROUP);
    }
    return apps;
  };

  const detectClaude = async (): Promise<DetectionResponse["claudeExecutables"]> => {
    const found = new Map<string, string>();
    for (const candidate of CLAUDE_CANDIDATE_PATHS(deps.homeDir)) {
      if (await isExecutable(candidate.path)) found.set(candidate.candidateId, candidate.path);
    }
    candidates = found;
    return [...found].map(([candidateId, path]) => ({
      candidateId,
      displayPath: toDisplayPath(path, deps.homeDir),
    }));
  };

  return {
    async detect() {
      const apps = await detectApps();
      const claudeExecutables = await detectClaude();
      const git = await findGit();
      return {
        detectedAt: now().toISOString(),
        apps,
        claudeExecutables,
        terminalPresets: TERMINAL_PRESETS.map((preset) => ({
          id: preset.id,
          label: preset.label,
          argv: [...preset.argv],
          verified: false,
        })),
        git: git.kind,
      };
    },
    async findBundle(bundleId) {
      // An exact ID only: a saved launcher names one bundle, never a prefix.
      if (!BundleIdSchema.safeParse(bundleId).success) return false;
      return (await lookup(bundleId, scanOnce())).length > 0;
    },
    candidatePath(candidateId) {
      return (
        candidates.get(candidateId) ??
        CLAUDE_CANDIDATE_PATHS(deps.homeDir).find((known) => known.candidateId === candidateId)
          ?.path ??
        null
      );
    },
    codexCandidatePath() {
      return null;
    },
  };
}
