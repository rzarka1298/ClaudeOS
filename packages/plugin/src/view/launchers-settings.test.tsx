import type { DetectionResponse, LauncherConfigView } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type {
  ConfigsOutcome,
  DetectOutcome,
  LaunchersActions,
  SaveOutcome,
} from "../projects/launchers-actions.js";
import {
  createLaunchersSession,
  type LaunchersSession,
  LaunchersSettings,
  requestLaunchersFocus,
} from "./launchers-settings.js";

/**
 * S6 Launchers section (Task 1): detection on first open, the owner's
 * explicit bundle choice, drafts in memory only, Save launcher, Discard
 * changes, the progress line and the focus hand-off (D-27, D-19, D-37,
 * RR-25, RR-26). Every service call goes through a fake `LaunchersActions`.
 */

const NOW = Date.parse("2026-09-30T10:05:00.000Z");
const LIVE: ConnectionState = { kind: "live" };

const BUNDLE_A = "com.example.antigravity";
const BUNDLE_B = "com.example.antigravity-preview";
const DESKTOP = "com.example.claude-desktop";

const TWO_ANTIGRAVITY: DetectionResponse = {
  detectedAt: "2026-09-30T10:00:00.000Z",
  apps: {
    antigravity: [
      { bundleId: BUNDLE_A, name: "Antigravity", location: "applications" },
      { bundleId: BUNDLE_B, name: "Antigravity Preview", location: "user-applications" },
    ],
    "claude-desktop": [{ bundleId: DESKTOP, name: "Claude", location: "applications" }],
    iterm2: [],
    ghostty: [],
    wezterm: [],
    terminal: [{ bundleId: "com.apple.Terminal", name: "Terminal", location: "applications" }],
  },
  claudeExecutables: [{ candidateId: "candidate-1", displayPath: "~/.local/bin/claude" }],
  terminalPresets: [],
  git: "available",
};

const NOTHING_SAVED: LauncherConfigView = {
  antigravity: null,
  "claude-code": null,
  "claude-desktop": null,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeActions(overrides: Partial<LaunchersActions> = {}): LaunchersActions {
  return {
    detect: vi.fn(() =>
      Promise.resolve<DetectOutcome>({ kind: "detected", detection: TWO_ANTIGRAVITY }),
    ),
    getConfigs: vi.fn(() =>
      Promise.resolve<ConfigsOutcome>({ kind: "loaded", configs: NOTHING_SAVED }),
    ),
    save: vi.fn(() => Promise.resolve<SaveOutcome>({ kind: "saved" })),
    test: vi.fn(() => Promise.resolve({ kind: "sent" as const })),
    markTested: vi.fn(() => Promise.resolve({ kind: "marked" as const })),
    openSystemSettings: vi.fn(() => Promise.resolve({ kind: "opened" as const })),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(
  actions: LaunchersActions,
  session: LaunchersSession = createLaunchersSession(),
  connection: ConnectionState = LIVE,
) {
  return render(
    <LaunchersSettings actions={actions} connection={connection} now={NOW} session={session} />,
  );
}

function panel(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

afterEach(cleanup);

describe("detection on first open (D-27)", () => {
  it("calls detect once and shows Detecting apps… in the same render", () => {
    const pending = deferred<DetectOutcome>();
    const actions = fakeActions({ detect: vi.fn(() => pending.promise) });
    mount(actions);
    expect(actions.detect).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Detecting apps…")).toBeTruthy();
  });

  it("does not detect again when the section reopens with a prior detection", async () => {
    const actions = fakeActions();
    const session = createLaunchersSession();
    const first = mount(actions, session);
    await settle();
    first.unmount();
    mount(actions, session);
    await settle();
    expect(actions.detect).toHaveBeenCalledTimes(1);
  });

  it("Detect apps runs detection again and shows Detected {relative time}", async () => {
    const actions = fakeActions();
    mount(actions);
    await settle();
    expect(screen.getByText("Detected 5 minutes ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Detect apps" }));
    expect(screen.getByText("Detecting apps…")).toBeTruthy();
    expect(actions.detect).toHaveBeenCalledTimes(2);
  });

  it("a failed detection shows its problem and next step", async () => {
    const actions = fakeActions({
      detect: vi.fn(() => Promise.resolve({ kind: "failed" as const })),
    });
    mount(actions);
    await settle();
    expect(screen.getByText("Couldn't detect apps.")).toBeTruthy();
    expect(screen.getByText("Enter bundle IDs by hand, or choose Detect apps again.")).toBeTruthy();
  });
});

describe("choosing an app (D-19, PROJ-11)", () => {
  it("two matching bundles: no radio checked, Save launcher aria-disabled with Choose an app first", async () => {
    const actions = fakeActions();
    mount(actions);
    await settle();
    const antigravity = panel("Antigravity");
    expect(
      within(antigravity).getByText(
        "Found 2 apps that look like Antigravity. Choose the one to use.",
      ),
    ).toBeTruthy();
    const group = within(antigravity).getByRole("group", { name: "Which Antigravity?" });
    const radios = within(group).getAllByRole<HTMLInputElement>("radio");
    expect(radios.length).toBe(3);
    expect(radios.some((radio) => radio.checked)).toBe(false);
    const save = within(antigravity).getByRole("button", { name: "Save launcher" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    const noteId = save.getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId ?? "")?.textContent).toBe("Choose an app first");
    fireEvent.click(save);
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("each option shows the app name, its mono bundle ID and its location", async () => {
    mount(fakeActions());
    await settle();
    const antigravity = panel("Antigravity");
    const mono = within(antigravity).getByText(BUNDLE_B);
    expect(mono.className).toContain("ccc-display-path");
    expect(within(antigravity).getByText("In your Applications folder")).toBeTruthy();
    expect(within(antigravity).getByText("In Applications")).toBeTruthy();
  });

  it("choosing one enables Save launcher and shows Unsaved changes; Save sends exactly the chosen bundle", async () => {
    const pendingSave = deferred<SaveOutcome>();
    const actions = fakeActions({ save: vi.fn(() => pendingSave.promise) });
    mount(actions);
    await settle();
    const antigravity = panel("Antigravity");
    fireEvent.click(within(antigravity).getByRole("radio", { name: /Antigravity Preview/ }));
    const save = within(antigravity).getByRole("button", { name: "Save launcher" });
    expect(save.getAttribute("aria-disabled")).not.toBe("true");
    expect(within(antigravity).getByText("Unsaved changes")).toBeTruthy();
    expect(actions.save).not.toHaveBeenCalled();

    fireEvent.click(save);
    expect(within(antigravity).getByRole("status").textContent).toContain("Saving…");
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(actions.save).toHaveBeenCalledWith({ launcherId: "antigravity", bundleId: BUNDLE_B });

    pendingSave.resolve({ kind: "saved" });
    await settle();
    expect(within(panel("Antigravity")).getByRole("status").textContent).toContain("✓ Saved");
  });

  it("one detected app is preselected but still needs Save launcher", async () => {
    const actions = fakeActions();
    mount(actions);
    await settle();
    const desktop = panel("Claude Desktop");
    expect(within(desktop).getByText("Found Claude Desktop.")).toBeTruthy();
    const radio = within(desktop).getByRole<HTMLInputElement>("radio", { name: /Claude/ });
    expect(radio.checked).toBe(true);
    expect(within(desktop).getByText("Unsaved changes")).toBeTruthy();
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("no detected app says so and offers the bundle ID field", async () => {
    const none: DetectionResponse = {
      ...TWO_ANTIGRAVITY,
      apps: { ...TWO_ANTIGRAVITY.apps, antigravity: [] },
    };
    mount(
      fakeActions({
        detect: vi.fn(() => Promise.resolve({ kind: "detected" as const, detection: none })),
      }),
    );
    await settle();
    const antigravity = panel("Antigravity");
    expect(within(antigravity).getByText("Antigravity wasn't found on this Mac.")).toBeTruthy();
    expect(within(antigravity).getByText("Install it, or enter its bundle ID below.")).toBeTruthy();
  });

  it("Use a different bundle ID: the typed value is checked on save and sent as typed", async () => {
    const actions = fakeActions();
    mount(actions);
    await settle();
    const antigravity = panel("Antigravity");
    fireEvent.click(within(antigravity).getByRole("radio", { name: "Use a different bundle ID" }));
    const input = within(antigravity).getByLabelText<HTMLInputElement>("Bundle ID");
    expect(input.getAttribute("placeholder")).toBe("com.example.app");
    fireEvent.input(input, { target: { value: "not a bundle" } });
    fireEvent.click(within(antigravity).getByRole("button", { name: "Save launcher" }));
    expect(actions.save).not.toHaveBeenCalled();
    expect(within(antigravity).getByText("Enter a bundle ID like com.example.app.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.input(input, { target: { value: "com.example.other" } });
    fireEvent.click(within(antigravity).getByRole("button", { name: "Save launcher" }));
    expect(actions.save).toHaveBeenCalledWith({
      launcherId: "antigravity",
      bundleId: "com.example.other",
    });
  });

  it("a bundle the service cannot find shows No installed app has this bundle ID.", async () => {
    const actions = fakeActions({
      save: vi.fn(() =>
        Promise.resolve<SaveOutcome>({ kind: "refused", reason: "bundle-not-found", index: null }),
      ),
    });
    mount(actions);
    await settle();
    const antigravity = panel("Antigravity");
    fireEvent.click(within(antigravity).getByRole("radio", { name: /Antigravity Preview/ }));
    fireEvent.click(within(antigravity).getByRole("button", { name: "Save launcher" }));
    await settle();
    expect(
      within(panel("Antigravity")).getByText("No installed app has this bundle ID."),
    ).toBeTruthy();
  });

  it("a failed save shows the S6 problem and next step", async () => {
    const actions = fakeActions({
      save: vi.fn(() => Promise.resolve<SaveOutcome>({ kind: "failed" })),
    });
    mount(actions);
    await settle();
    const antigravity = panel("Antigravity");
    fireEvent.click(within(antigravity).getByRole("radio", { name: /Antigravity Preview/ }));
    fireEvent.click(within(antigravity).getByRole("button", { name: "Save launcher" }));
    await settle();
    const status = within(panel("Antigravity")).getByRole("status");
    expect(status.textContent).toContain("Couldn't save launcher settings.");
    expect(status.textContent).toContain(
      "Check the service in Settings → Diagnostics, then try again.",
    );
  });
});

describe("drafts live in memory only (D-27, RR-25)", () => {
  it("Discard changes restores the saved value", async () => {
    const actions = fakeActions({
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({
          kind: "loaded",
          configs: { ...NOTHING_SAVED, antigravity: { bundleId: BUNDLE_A, tested: false } },
        }),
      ),
    });
    mount(actions);
    await settle();
    const antigravity = panel("Antigravity");
    const first = within(antigravity).getByRole<HTMLInputElement>("radio", {
      name: /^Antigravity com/,
    });
    expect(first.checked).toBe(true);
    expect(within(antigravity).queryByText("Unsaved changes")).toBeNull();

    fireEvent.click(within(antigravity).getByRole("radio", { name: /Antigravity Preview/ }));
    expect(within(antigravity).getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(within(antigravity).getByRole("button", { name: "Discard changes" }));
    expect(
      within(antigravity).getByRole<HTMLInputElement>("radio", { name: /^Antigravity com/ })
        .checked,
    ).toBe(true);
    expect(within(antigravity).queryByText("Unsaved changes")).toBeNull();
    expect(within(antigravity).queryByRole("button", { name: "Discard changes" })).toBeNull();
  });

  it("a draft survives leaving and reopening the section, and is never written anywhere", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const actions = fakeActions();
    const session = createLaunchersSession();
    const first = mount(actions, session);
    await settle();
    fireEvent.click(
      within(panel("Antigravity")).getByRole("radio", { name: /Antigravity Preview/ }),
    );
    first.unmount();
    mount(actions, session);
    await settle();
    const preview = within(panel("Antigravity")).getByRole<HTMLInputElement>("radio", {
      name: /Antigravity Preview/,
    });
    expect(preview.checked).toBe(true);
    expect(actions.save).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

describe("the panels and the progress line (S6, RR-26)", () => {
  it("renders the heading, intro and the five panels in order", async () => {
    mount(fakeActions());
    await settle();
    expect(screen.getByRole("heading", { level: 3, name: "Launchers" })).toBeTruthy();
    expect(
      screen.getByText(
        "Choose which apps open your projects, then test each one. Nothing is saved until you choose Save launcher.",
      ),
    ).toBeTruthy();
    const names = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(names).toEqual(["Antigravity", "Claude Code", "Claude Desktop", "Finder", "GitHub"]);
  });

  it("counts only Antigravity, Claude Code and Claude Desktop", async () => {
    const actions = fakeActions({
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({
          kind: "loaded",
          configs: {
            antigravity: { bundleId: BUNDLE_A, tested: true },
            "claude-code": null,
            "claude-desktop": { bundleId: DESKTOP, tested: false },
          },
        }),
      ),
    });
    mount(actions);
    await settle();
    expect(screen.getByText("2 of 3 launchers set up")).toBeTruthy();
  });

  it("shows each launcher's status badge", async () => {
    const actions = fakeActions({
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({
          kind: "loaded",
          configs: {
            antigravity: { bundleId: BUNDLE_A, tested: true },
            "claude-code": null,
            "claude-desktop": { bundleId: "com.example.gone", tested: false },
          },
        }),
      ),
    });
    mount(actions);
    await settle();
    expect(within(panel("Antigravity")).getByText("Tested")).toBeTruthy();
    expect(within(panel("Claude Code")).getByText("Not set up")).toBeTruthy();
    expect(within(panel("Claude Desktop")).getByText("App not found")).toBeTruthy();
  });

  it("a saved, untested launcher shows Set up; nothing saved shows Not set up", async () => {
    const actions = fakeActions({
      getConfigs: vi.fn(() =>
        Promise.resolve<ConfigsOutcome>({
          kind: "loaded",
          configs: { ...NOTHING_SAVED, antigravity: { bundleId: BUNDLE_A, tested: false } },
        }),
      ),
    });
    mount(actions);
    await settle();
    expect(within(panel("Antigravity")).getByText("Set up")).toBeTruthy();
    expect(within(panel("Claude Desktop")).getByText("Not set up")).toBeTruthy();
  });

  it("Finder and GitHub have nothing to set up and no Save launcher", async () => {
    mount(fakeActions());
    await settle();
    for (const name of ["Finder", "GitHub"]) {
      const section = panel(name);
      expect(within(section).getByText(/Nothing to set up\./)).toBeTruthy();
      expect(within(section).queryByRole("button", { name: "Save launcher" })).toBeNull();
    }
  });
});

describe("focus hand-off (D-30, S6)", () => {
  it("requestLaunchersFocus() moves focus to the Launchers heading on mount, once", async () => {
    requestLaunchersFocus();
    mount(fakeActions());
    await settle();
    const heading = screen.getByRole("heading", { level: 3, name: "Launchers" });
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
    cleanup();

    mount(fakeActions());
    await settle();
    expect(document.activeElement).not.toBe(
      screen.getByRole("heading", { level: 3, name: "Launchers" }),
    );
  });
});
