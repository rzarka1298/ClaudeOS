import {
  type BridgeReadiness,
  CODEX_VERSION_PATTERN,
  type DetectedCodexExecutable,
  type TerminalChoice,
} from "@ccc/domain";
import type { CommandRunner } from "../projects/command-runner.js";
import { toDisplayPath } from "../projects/project-views.js";
import { isExecutableFile } from "../projects/terminal-launchers.js";
import { type BridgeStatus, toBridgeStatusView } from "./bridge-state.js";

/**
 * Codex detection (plan 05.1-21, D-11, D-12, CODEX-03): which `codex`
 * binaries are installed, each with the version it reports, and which bridge
 * state and terminal the pair launch would propose.
 *
 * Everything here is a PROPOSAL. Detection never saves a launcher, never
 * rewrites a saved Terminal.app or custom row (OQ-2) and never runs
 * `codex doctor` (that is owner-triggered, `doctor-probe.ts`). The plugin sees
 * each candidate as an opaque id and a home-abbreviated display string; the
 * absolute path stays in this process, for the save route only (the Phase 4
 * Claude candidate pattern, T-04-23).
 *
 * Two binaries can exist on one machine: the user install (a symlink the
 * installer keeps pointing at the current release) and the ChatGPT app's
 * bundled one. Both are listed, in this order, with no choice made for the
 * owner. The SYMLINK path is what is listed and stored, never its realpath,
 * so an update of the release does not break a saved launcher (D-21).
 *
 * The version probe runs `[path, "--version"]` through the injected runner:
 * an argv array, no shell, a fixed environment, a short deadline and a small
 * output cap. The service reads no Codex file and touches no credential
 * (CODEX-09); the child's stdout is the only input, parsed with a strict
 * pattern, and a child that fails, hangs or prints anything else leaves the
 * version unknown while the candidate stays listed.
 */

/** A Codex install location that detection knows about. */
export interface CodexCandidate {
  /** Opaque to the plugin; resolved back to `path` by the detector only. */
  readonly candidateId: string;
  readonly path: string;
  readonly location: DetectedCodexExecutable["location"];
}

/** The bundled launcher inside the ChatGPT app (a fixed system location). */
const APP_BUNDLE_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

/** The known `codex` install locations, in proposal order (D-11). */
export function CODEX_CANDIDATE_PATHS(homeDir: string): readonly CodexCandidate[] {
  return [
    { candidateId: "user-install", path: `${homeDir}/.local/bin/codex`, location: "user-install" },
    { candidateId: "app-bundle", path: APP_BUNDLE_PATH, location: "app-bundle" },
    { candidateId: "homebrew", path: "/opt/homebrew/bin/codex", location: "package-manager" },
    { candidateId: "usr-local", path: "/usr/local/bin/codex", location: "package-manager" },
  ];
}

export interface CodexDetectionDeps {
  readonly runner: CommandRunner;
  /** The resolved home directory (`resolveHomeDir`). */
  readonly homeDir: string;
  /** Regular file + `X_OK`; defaults to {@link isExecutableFile}. */
  readonly isExecutable?: (path: string) => Promise<boolean>;
  /** The bridge state as the service sees it (plan 05.1-13); never throws. */
  readonly readBridgeStatus: () => BridgeStatus;
}

export interface CodexDetectionResult {
  readonly executables: readonly DetectedCodexExecutable[];
  /** Detection never runs doctor, so it always says `unknown` (D-17). */
  readonly doctor: "unknown";
  readonly bridge: BridgeReadiness;
  /** A proposal only: nothing is saved and a saved choice is never rewritten (OQ-2). */
  readonly suggestedTerminal: TerminalChoice;
}

export interface CodexDetection {
  /** Proposes only; stores nothing and writes nothing. */
  detectCodex(): Promise<CodexDetectionResult>;
  /**
   * The absolute path of a Codex candidate: its fixed known location, whether
   * or not this service run has detected it yet (a restart since the plugin's
   * detection must not strand a retained id). `null` for any other id. The
   * path comes from the service, never from the request (T-05.1-01); the save
   * still checks it is an executable file now.
   */
  candidatePath(candidateId: string): string | null;
}

/** The fixed child environment: nothing is inherited from the service. */
function childEnv(homeDir: string): Readonly<Record<string, string>> {
  return { HOME: homeDir, PATH: "/usr/bin:/bin", LC_ALL: "C" };
}

/** A version probe that outlasts this is a hang. */
const VERSION_TIMEOUT_MS = 3000;
/** `codex-cli 0.159.2` is a few dozen bytes; this is generous and still tiny. */
const VERSION_MAX_OUTPUT_BYTES = 2048;
const VERSION_MAX_LENGTH = 64;

/** The one line `codex --version` prints: the product name and a dotted version. */
const VERSION_LINE = /^codex-cli ([^\s]+)$/;

/**
 * The dotted version in `codex --version` output, or `null`. Exactly one line
 * of the documented form; any other text, a second line or a control
 * character yields `null`.
 */
function parseVersion(stdout: string): string | null {
  const line = stdout.replace(/\r?\n$/, "");
  const match = VERSION_LINE.exec(line);
  const version = match?.[1];
  if (version === undefined || version.length > VERSION_MAX_LENGTH) return null;
  return CODEX_VERSION_PATTERN.test(version) ? version : null;
}

/** The bridge state the plugin shows, as the domain readiness word. */
function readinessOf(read: () => BridgeStatus): BridgeReadiness {
  try {
    return toBridgeStatusView(read()).state;
  } catch {
    // The reader is documented as total; a fault still must not fail detection.
    return "not-installed";
  }
}

/**
 * The Antigravity terminal is proposed only when the bridge is installed and
 * can carry an agent launch; anything else, including a bridge the service
 * cannot read from the right folder, proposes Terminal.app (D-12).
 */
function suggestionFor(readiness: BridgeReadiness): TerminalChoice {
  return readiness === "installed" || readiness === "installed-idle"
    ? { kind: "antigravity-terminal" }
    : { kind: "terminal-app" };
}

export function createCodexDetection(deps: CodexDetectionDeps): CodexDetection {
  const isExecutable = deps.isExecutable ?? isExecutableFile;

  const versionOf = async (path: string): Promise<string | null> => {
    try {
      const outcome = await deps.runner.run(path, ["--version"], {
        timeoutMs: VERSION_TIMEOUT_MS,
        env: childEnv(deps.homeDir),
        maxBufferBytes: VERSION_MAX_OUTPUT_BYTES,
      });
      if (outcome.exitCode !== 0 || outcome.truncated || outcome.timedOut) return null;
      return parseVersion(outcome.stdout);
    } catch {
      return null;
    }
  };

  const probe = async (candidate: CodexCandidate): Promise<DetectedCodexExecutable | null> => {
    if (!(await isExecutable(candidate.path))) return null;
    return {
      candidateId: candidate.candidateId,
      displayPath: toDisplayPath(candidate.path, deps.homeDir),
      version: await versionOf(candidate.path),
      location: candidate.location,
    };
  };

  return {
    async detectCodex() {
      const probed = await Promise.all(CODEX_CANDIDATE_PATHS(deps.homeDir).map(probe));
      const executables = probed.filter(
        (found): found is DetectedCodexExecutable => found !== null,
      );
      const bridge = readinessOf(deps.readBridgeStatus);
      return {
        executables,
        doctor: "unknown",
        bridge,
        suggestedTerminal: suggestionFor(bridge),
      };
    },
    candidatePath(candidateId) {
      return (
        CODEX_CANDIDATE_PATHS(deps.homeDir).find((known) => known.candidateId === candidateId)
          ?.path ?? null
      );
    },
  };
}
