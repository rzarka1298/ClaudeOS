import type { DetectionResponse, LauncherConfigView } from "@ccc/domain";
import { vi } from "vitest";
import type {
  ConfigsOutcome,
  DetectOutcome,
  LaunchersActions,
  MarkTestedOutcome,
  OpenSettingsOutcome,
  SaveOutcome,
  TestOutcome,
} from "../projects/launchers-actions.js";

/**
 * Synthetic launcher fixtures for the S6/S7 component tests (plan 04-12).
 * Names and bundle IDs are made up; paths use the `~/` display form only.
 */

export const OSASCRIPT_PRESET_ARGV = [
  "/usr/bin/osascript",
  "-e",
  "on run argv",
  "-e",
  'tell application id "com.googlecode.iterm2" to create window with default profile command (item 1 of argv)',
  "-e",
  "end run",
  "{script}",
] as const;

export const DETECTION: DetectionResponse = {
  detectedAt: "2026-09-30T10:00:00.000Z",
  apps: {
    antigravity: [
      { bundleId: "com.example.antigravity", name: "Antigravity", location: "applications" },
      {
        bundleId: "com.example.antigravity-preview",
        name: "Antigravity Preview",
        location: "user-applications",
      },
    ],
    "claude-desktop": [
      { bundleId: "com.example.claude-desktop", name: "Claude", location: "applications" },
    ],
    iterm2: [],
    ghostty: [{ bundleId: "com.example.ghostty", name: "Ghostty", location: "applications" }],
    wezterm: [],
    terminal: [{ bundleId: "com.apple.Terminal", name: "Terminal", location: "applications" }],
  },
  claudeExecutables: [
    { candidateId: "candidate-1", displayPath: "~/.local/bin/claude" },
    { candidateId: "candidate-2", displayPath: "/opt/homebrew/bin/claude" },
  ],
  terminalPresets: [
    { id: "iterm2", label: "iTerm2", argv: [...OSASCRIPT_PRESET_ARGV], verified: false },
    {
      id: "ghostty",
      label: "Ghostty",
      argv: ["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "{script}"],
      verified: false,
    },
    {
      id: "wezterm",
      label: "WezTerm",
      argv: [
        "/usr/bin/open",
        "-na",
        "WezTerm",
        "--args",
        "start",
        "--cwd",
        "{projectPath}",
        "--",
        "{script}",
      ],
      verified: false,
    },
    { id: "blank", label: "Blank template", argv: ["", "{script}"], verified: false },
  ],
  git: "available",
};

export const NOTHING_SAVED: LauncherConfigView = {
  antigravity: null,
  "claude-code": null,
  "claude-desktop": null,
};

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fake {@link LaunchersActions} whose every method is a `vi.fn` resolving success. */
export function fakeLaunchersActions(overrides: Partial<LaunchersActions> = {}): LaunchersActions {
  return {
    detect: vi.fn(() => Promise.resolve<DetectOutcome>({ kind: "detected", detection: DETECTION })),
    getConfigs: vi.fn(() =>
      Promise.resolve<ConfigsOutcome>({ kind: "loaded", configs: NOTHING_SAVED }),
    ),
    save: vi.fn(() => Promise.resolve<SaveOutcome>({ kind: "saved" })),
    test: vi.fn(() => Promise.resolve<TestOutcome>({ kind: "sent" })),
    markTested: vi.fn(() => Promise.resolve<MarkTestedOutcome>({ kind: "marked" })),
    openSystemSettings: vi.fn(() => Promise.resolve<OpenSettingsOutcome>({ kind: "opened" })),
    ...overrides,
  };
}
