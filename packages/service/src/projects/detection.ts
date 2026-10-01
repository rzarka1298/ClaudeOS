import type { DetectionResponse } from "@ccc/domain";
import type { CommandRunner } from "./command-runner.js";
import type { GitResolution } from "./git-runner.js";

// RED stub (04-11 Task 1): the shapes only; GREEN fills in detection.

export const DETECTION_QUERY_PATTERN = /^[A-Za-z0-9.-]+\*?$/;

export const CANDIDATE_BUNDLE_IDS: Readonly<Record<keyof DetectionResponse["apps"], string>> = {
  terminal: "com.apple.Terminal",
  iterm2: "com.googlecode.iterm2",
  ghostty: "com.mitchellh.ghostty",
  wezterm: "com.github.wez.wezterm",
  "claude-desktop": "com.anthropic.claudefordesktop",
  antigravity: "com.google.antigravity*",
};

export interface ClaudeCandidate {
  readonly candidateId: string;
  readonly path: string;
}

export function CLAUDE_CANDIDATE_PATHS(_homeDir: string): readonly ClaudeCandidate[] {
  return [];
}

export interface DetectorDeps {
  readonly runner: CommandRunner;
  readonly homeDir: string;
  readonly readdir?: (dir: string) => Promise<readonly string[]>;
  readonly isExecutable?: (path: string) => Promise<boolean>;
  readonly resolveGit?: () => Promise<GitResolution>;
  readonly now?: () => Date;
}

export interface Detector {
  detect(): Promise<DetectionResponse>;
  findBundle(bundleId: string): Promise<boolean>;
  candidatePath(candidateId: string): string | null;
}

export function createDetector(_deps: DetectorDeps): Detector {
  return {
    detect: () =>
      Promise.resolve({
        detectedAt: new Date(0).toISOString(),
        apps: {
          antigravity: [],
          "claude-desktop": [],
          iterm2: [],
          ghostty: [],
          wezterm: [],
          terminal: [],
        },
        claudeExecutables: [],
        terminalPresets: [],
        git: "unavailable",
      }),
    findBundle: () => Promise.resolve(false),
    candidatePath: () => null,
  };
}
