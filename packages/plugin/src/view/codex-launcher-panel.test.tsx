import type { DetectionResponse, LauncherConfigView } from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import {
  CODEX_APP_BUNDLE,
  CODEX_USER_INSTALL,
  fakeLaunchersActions,
  NOTHING_SAVED,
  withCodexDetection,
} from "../test-support/launchers-fixtures.js";
import { CodexLauncherPanel } from "./codex-launcher-panel.js";
import { createLaunchersSession, type LaunchersSession } from "./launchers-settings.js";

/**
 * The Codex launcher panel (plan 05.1-31, D-11, CODEX-03, UI-SPEC S4-b):
 * built from the same kit as the Claude Code panel. Every service call goes
 * through a fake `LaunchersActions`; the real detection is owner UAT.
 */

const LIVE: ConnectionState = { kind: "live" };
const DISCONNECTED: ConnectionState = { kind: "disconnected", reason: "service-unreachable" };
const NOW = Date.parse("2026-09-30T10:05:00.000Z");

const ONE_CANDIDATE = withCodexDetection([CODEX_USER_INSTALL]);
const TWO_CANDIDATES = withCodexDetection([CODEX_USER_INSTALL, CODEX_APP_BUNDLE]);

const SAVED_CODEX: LauncherConfigView = {
  ...NOTHING_SAVED,
  codex: { executableDisplay: "~/.local/bin/codex", args: [], tested: false },
};

function sessionWith(
  detection: DetectionResponse | null = ONE_CANDIDATE,
  configs: LauncherConfigView | null = NOTHING_SAVED,
): LaunchersSession {
  const session = createLaunchersSession();
  session.detection.value = detection;
  session.configs.value = configs;
  return session;
}

function mount(
  actions: LaunchersActions,
  session: LaunchersSession = sessionWith(),
  connection: ConnectionState = LIVE,
) {
  return render(
    <CodexLauncherPanel
      actions={actions}
      session={session}
      connection={connection}
      now={NOW}
      sampleDisplayPath="~/code/example-project"
    />,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function panel(): HTMLElement {
  return screen.getByRole("region", { name: "Codex" });
}

function saveButton(): HTMLElement {
  return within(panel()).getByRole("button", { name: "Save launcher" });
}

afterEach(cleanup);

describe("the Codex panel, tracer (plan 05.1-31 Task 1)", () => {
  it("shows the only detected candidate preselected, saves it by id with no terminal, and reads Set up", async () => {
    const actions = fakeLaunchersActions({
      getConfigs: () => Promise.resolve({ kind: "loaded" as const, configs: SAVED_CODEX }),
    });
    const session = sessionWith();
    mount(actions, session);
    const radio = within(panel()).getByRole<HTMLInputElement>("radio", {
      name: "Found Codex 0.159.2 at ~/.local/bin/codex.",
    });
    expect(radio.checked).toBe(true);
    expect(within(panel()).getByText("Not set up")).toBeTruthy();

    fireEvent.click(saveButton());
    expect(actions.save).toHaveBeenCalledTimes(1);
    const request = vi.mocked(actions.save).mock.calls[0]?.[0];
    expect(request).toEqual({
      launcherId: "codex",
      executable: { kind: "candidate", candidateId: "codex-1" },
      args: [],
    });
    expect(Object.keys(request as object)).not.toContain("terminal");

    await settle();
    expect(within(panel()).getByText("Set up")).toBeTruthy();
    expect(within(panel()).getByText("Saved")).toBeTruthy();
  });

  it("renders no path other than the display path the service sent, and never sends a display string", () => {
    const actions = fakeLaunchersActions();
    mount(actions);
    expect(panel().textContent).toContain("~/.local/bin/codex");
    expect(panel().textContent).not.toMatch(/\/Users\//);
    fireEvent.click(saveButton());
    expect(JSON.stringify(vi.mocked(actions.save).mock.calls)).not.toContain("~/.local/bin/codex");
  });

  it("disconnected: controls are aria-disabled, last-known candidates stay, nothing is called", () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(TWO_CANDIDATES), DISCONNECTED);
    expect(
      within(panel())
        .getByRole("radio", { name: /Found Codex 0.159.2 at/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(saveButton());
    fireEvent.click(within(panel()).getByRole("radio", { name: /Found Codex 0.158.0 at/ }));
    expect(actions.save).not.toHaveBeenCalled();
    expect(
      within(panel()).getByRole<HTMLInputElement>("radio", { name: /Found Codex 0.158.0 at/ })
        .checked,
    ).toBe(false);
    expect(within(panel()).getByText(/Found Codex 0.159.2 at/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Task 2: the panel in full

function typeArgs(values: readonly string[]): void {
  values.forEach((value, index) => {
    fireEvent.click(within(panel()).getByRole("button", { name: "Add argument" }));
    fireEvent.input(within(panel()).getByLabelText(`Argument ${index + 1}`), {
      target: { value },
    });
  });
}

const REFUSAL_TAIL =
  "isn't allowed. It turns off Codex's sandbox or approval checks, so this app never launches Codex with it.";

describe("detection is a setup state, never an error (CODEX-03, UI-SPEC S4-b)", () => {
  it("renders the calm setup line for an older service whose detection lacks the Codex members", () => {
    mount(fakeLaunchersActions(), sessionWith(DETECTION));
    const line = within(panel()).getByText(
      "Codex isn't installed on this Mac. Install it, then choose Detect again.",
    );
    expect(line.textContent).toContain("◌");
    expect(within(panel()).getByText("Not set up")).toBeTruthy();
    expect(within(panel()).queryByRole("radio")).toBeNull();
    expect(panel().querySelector(".ccc-error-glyph")).toBeNull();
    expect(panel().querySelector(".ccc-field-error")).toBeNull();
    expect(panel().innerHTML).not.toContain("danger");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(within(panel()).getByText("Choose a codex executable first")).toBeTruthy();
  });

  it("renders the same setup state for a service that reports no executables", () => {
    mount(fakeLaunchersActions(), sessionWith(withCodexDetection([])));
    expect(within(panel()).getByText(/Codex isn't installed on this Mac/)).toBeTruthy();
    expect(within(panel()).queryByRole("radio")).toBeNull();
  });

  it("shows nothing about installation before detection has answered", () => {
    mount(fakeLaunchersActions(), sessionWith(null));
    expect(within(panel()).queryByText(/isn't installed/)).toBeNull();
  });
});

describe("two candidates are never silently chosen between", () => {
  it("lists both with their versions, preselects neither, and switches the preview on choice", () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(TWO_CANDIDATES));
    const user = within(panel()).getByRole<HTMLInputElement>("radio", {
      name: "Found Codex 0.159.2 at ~/.local/bin/codex.",
    });
    const bundled = within(panel()).getByRole<HTMLInputElement>("radio", {
      name: "Found Codex 0.158.0 at /Applications/Codex.app/Contents/Resources/codex.",
    });
    expect(user.checked).toBe(false);
    expect(bundled.checked).toBe(false);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(saveButton());
    expect(actions.save).not.toHaveBeenCalled();

    fireEvent.click(user);
    const preview = within(panel()).getByRole("list", { name: "Preview" });
    expect(within(preview).getAllByRole("listitem")[0]?.textContent).toBe("~/.local/bin/codex");
    expect(saveButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(bundled);
    expect(within(preview).getAllByRole("listitem")[0]?.textContent).toBe(
      "/Applications/Codex.app/Contents/Resources/codex",
    );
  });

  it("drops the version from the line when the service could not read one", () => {
    mount(
      fakeLaunchersActions(),
      sessionWith(withCodexDetection([{ ...CODEX_USER_INSTALL, version: null }])),
    );
    expect(
      within(panel()).getByRole("radio", { name: "Found Codex at ~/.local/bin/codex." }),
    ).toBeTruthy();
  });

  it("a saved row reads back as the matching candidate, and a typed path is sent as a path", () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(TWO_CANDIDATES, SAVED_CODEX));
    expect(
      within(panel()).getByRole<HTMLInputElement>("radio", { name: /Found Codex 0.159.2/ }).checked,
    ).toBe(true);
    fireEvent.click(within(panel()).getByRole("radio", { name: "Use a different path" }));
    fireEvent.input(within(panel()).getByLabelText("Path to codex"), {
      target: { value: "/opt/example/bin/codex" },
    });
    fireEvent.click(saveButton());
    expect(actions.save).toHaveBeenCalledWith({
      launcherId: "codex",
      executable: { kind: "path", path: "/opt/example/bin/codex" },
      args: [],
    });
  });
});

describe("the refused argument forms (D-11, T-05.1-15)", () => {
  const SINGLE_ROW_FORMS: readonly string[] = [
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "--sandbox=danger-full-access",
    "--full-auto",
    "--approve-for-me",
    "--dangerously-bypass-hook-trust",
  ];

  it.each(SINGLE_ROW_FORMS)("refuses %s before anything is sent", (flag) => {
    const actions = fakeLaunchersActions();
    mount(actions);
    typeArgs([flag]);
    fireEvent.click(saveButton());
    expect(actions.save).not.toHaveBeenCalled();
    const input = within(panel()).getByLabelText("Argument 1");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const line = within(panel()).getByText(`${flag} ${REFUSAL_TAIL}`);
    expect(line.className).toContain("ccc-field-error");
    expect(line.querySelector(".ccc-error-glyph")?.textContent).toBe("▲");
    expect(input.getAttribute("aria-describedby")).toBe(line.id);
  });

  it.each([
    ["--sandbox", "danger-full-access"],
    ["-s", "danger-full-access"],
  ])("refuses the danger value after %s on the value's own row", (flag, value) => {
    const actions = fakeLaunchersActions();
    mount(actions);
    typeArgs([flag, value]);
    fireEvent.click(saveButton());
    expect(actions.save).not.toHaveBeenCalled();
    expect(within(panel()).getByLabelText("Argument 1").getAttribute("aria-invalid")).toBeNull();
    expect(within(panel()).getByLabelText("Argument 2").getAttribute("aria-invalid")).toBe("true");
    expect(within(panel()).getByText(`${flag} ${value} ${REFUSAL_TAIL}`)).toBeTruthy();
  });

  it("also refuses spellings the service normalises away, and the config-carrying flags", () => {
    const actions = fakeLaunchersActions();
    mount(actions);
    typeArgs(["--Dangerously_Bypass_Approvals_And_Sandbox", "-c"]);
    fireEvent.click(saveButton());
    expect(actions.save).not.toHaveBeenCalled();
    expect(within(panel()).getByLabelText("Argument 1").getAttribute("aria-invalid")).toBe("true");
    expect(within(panel()).getByLabelText("Argument 2").getAttribute("aria-invalid")).toBe("true");
  });

  it("saves an allowed argument", async () => {
    const actions = fakeLaunchersActions();
    mount(actions);
    typeArgs(["--model", "example-model"]);
    fireEvent.click(saveButton());
    expect(actions.save).toHaveBeenCalledWith({
      launcherId: "codex",
      executable: { kind: "candidate", candidateId: "codex-1" },
      args: ["--model", "example-model"],
    });
  });

  it("renders a structured service refusal under the named row and leaves the draft intact", async () => {
    const actions = fakeLaunchersActions({
      save: vi.fn(() =>
        Promise.resolve({
          kind: "refused" as const,
          reason: "forbidden-flag" as const,
          index: 2,
          template: "codex" as const,
        }),
      ),
    });
    mount(actions);
    typeArgs(["--model", "--bypass-example"]);
    fireEvent.click(saveButton());
    await settle();
    expect(within(panel()).getByLabelText("Argument 2").getAttribute("aria-invalid")).toBe("true");
    expect(within(panel()).getByText(`--bypass-example ${REFUSAL_TAIL}`)).toBeTruthy();
    expect(within(panel()).getByLabelText<HTMLInputElement>("Argument 1").value).toBe("--model");
    expect(within(panel()).getByLabelText<HTMLInputElement>("Argument 2").value).toBe(
      "--bypass-example",
    );
  });

  it("renders an executable refusal under the executable choice", async () => {
    const actions = fakeLaunchersActions({
      save: vi.fn(() =>
        Promise.resolve({
          kind: "refused" as const,
          reason: "executable-not-found" as const,
          index: 0,
          template: "codex" as const,
        }),
      ),
    });
    mount(actions);
    fireEvent.click(saveButton());
    await settle();
    expect(within(panel()).getByText(/isn't a Codex executable this app can run/)).toBeTruthy();
  });
});

describe("the terminal line mirrors the Claude Code row", () => {
  const withClaude = (terminal: NonNullable<LauncherConfigView["claude-code"]>["terminal"]) =>
    ({
      ...NOTHING_SAVED,
      "claude-code": {
        executableDisplay: "~/.local/bin/claude",
        args: [],
        terminal,
        tested: false,
      },
    }) satisfies LauncherConfigView;

  it.each([
    [{ kind: "terminal-app" as const }, "Opens in Terminal."],
    [{ kind: "antigravity-terminal" as const }, "Opens in Antigravity."],
    [
      { kind: "custom" as const, preset: "iterm2" as const, argv: ["/usr/bin/open", "{script}"] },
      "Opens in iTerm2.",
    ],
    [
      { kind: "custom" as const, preset: "blank" as const, argv: ["/usr/bin/open", "{script}"] },
      "Opens in your terminal.",
    ],
  ])("reads the saved terminal %#", (terminal, line) => {
    mount(fakeLaunchersActions(), sessionWith(ONE_CANDIDATE, withClaude(terminal)));
    expect(within(panel()).getByText(line)).toBeTruthy();
  });

  it("follows the Claude Code draft when nothing is saved, and has no control of its own", () => {
    const session = sessionWith();
    session.claudeDraft.value = {
      executable: null,
      args: [],
      terminal: { kind: "antigravity-terminal" },
    };
    mount(fakeLaunchersActions(), session);
    expect(within(panel()).getByText("Opens in Antigravity.")).toBeTruthy();
    expect(within(panel()).queryByRole("radio", { name: /Terminal/ })).toBeNull();
    expect(within(panel()).queryByRole("combobox")).toBeNull();
  });

  it("says Terminal when neither a saved row nor a draft exists", () => {
    mount(fakeLaunchersActions());
    expect(within(panel()).getByText("Opens in Terminal.")).toBeTruthy();
  });
});

describe("Test launcher", () => {
  const SAVED_WITH_TERMINAL: LauncherConfigView = {
    ...SAVED_CODEX,
    "claude-code": {
      executableDisplay: "~/.local/bin/claude",
      args: [],
      terminal: { kind: "terminal-app" },
      tested: false,
    },
  };

  it("is aria-disabled with the hidden note until a saved row matches the draft", () => {
    mount(fakeLaunchersActions(), sessionWith(ONE_CANDIDATE, NOTHING_SAVED));
    const test = within(panel()).getByRole("button", { name: "Test the Codex launcher" });
    expect(test.getAttribute("aria-disabled")).toBe("true");
    expect(within(panel()).getByText("Save launcher first")).toBeTruthy();
  });

  it("runs the saved launcher once with the saved Claude Code terminal and asks the question", async () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(ONE_CANDIDATE, SAVED_WITH_TERMINAL));
    expect(
      within(panel()).getByText(
        "Test opens a new Terminal window at the managed vault folder that shows the Codex version.",
      ),
    ).toBeTruthy();
    const test = within(panel()).getByRole("button", { name: "Test the Codex launcher" });
    expect(test.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(test);
    expect(within(panel()).getByText("Testing…")).toBeTruthy();
    await settle();
    expect(actions.test).toHaveBeenCalledTimes(1);
    expect(actions.test).toHaveBeenCalledWith("codex", { kind: "terminal-app" });
    expect(
      within(panel()).getByText(
        "Test sent. Did a Terminal window open and show the Codex version?",
      ),
    ).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "It opened" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "It didn't open" })).toBeTruthy();
  });

  it("names a tab in Antigravity for the Antigravity terminal", async () => {
    const configs: LauncherConfigView = {
      ...SAVED_CODEX,
      "claude-code": {
        executableDisplay: "~/.local/bin/claude",
        args: [],
        terminal: { kind: "antigravity-terminal" },
        tested: false,
      },
    };
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(ONE_CANDIDATE, configs));
    expect(
      within(panel()).getByText(
        "Test opens a new tab in Antigravity at the managed vault folder that shows the Codex version.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Test the Codex launcher" }));
    await settle();
    expect(
      within(panel()).getByText(
        "Test sent. Did a tab open in Antigravity and show the Codex version?",
      ),
    ).toBeTruthy();
  });

  it("maps a typed Test error to the existing status lines", async () => {
    const actions = fakeLaunchersActions({
      test: vi.fn(() =>
        Promise.resolve({ kind: "error" as const, error: "launcher-not-configured" as const }),
      ),
    });
    mount(actions, sessionWith(ONE_CANDIDATE, SAVED_WITH_TERMINAL));
    fireEvent.click(within(panel()).getByRole("button", { name: "Test the Codex launcher" }));
    await settle();
    expect(within(panel()).getByText("Codex isn't set up yet.")).toBeTruthy();
  });
});

describe("Check Codex health (R4)", () => {
  const checkButton = () => within(panel()).getByRole("button", { name: "Check Codex health" });

  function healthRegion(): HTMLElement {
    const regions = within(panel()).getAllByRole("status");
    const found = regions.find((element) => element.getAttribute("data-codex-health") !== null);
    if (found === undefined) throw new Error("no health region");
    return found;
  }

  it("is aria-disabled with a hidden note until a Codex row is saved, and while disconnected", () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(ONE_CANDIDATE, NOTHING_SAVED));
    expect(checkButton().getAttribute("aria-disabled")).toBe("true");
    expect(within(panel()).getByText("Save a Codex launcher first")).toBeTruthy();
    fireEvent.click(checkButton());
    expect(actions.codexDoctor).not.toHaveBeenCalled();
    cleanup();
    mount(actions, sessionWith(ONE_CANDIDATE, SAVED_CODEX), DISCONNECTED);
    expect(checkButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(checkButton());
    expect(actions.codexDoctor).not.toHaveBeenCalled();
  });

  it("never runs on open, on re-render or on detect: only on the owner's press", async () => {
    const actions = fakeLaunchersActions();
    const session = sessionWith(ONE_CANDIDATE, SAVED_CODEX);
    const view = mount(actions, session);
    await settle();
    session.detection.value = TWO_CANDIDATES;
    view.rerender(
      <CodexLauncherPanel
        actions={actions}
        session={session}
        connection={LIVE}
        now={NOW + 60_000}
        sampleDisplayPath="~/code/example-project"
      />,
    );
    await settle();
    expect(actions.codexDoctor).not.toHaveBeenCalled();
  });

  it("writes Checking… with aria-busy in the click's tick, runs once, then the healthy line", async () => {
    let finish: (value: { kind: "healthy" }) => void = () => {};
    const pending = new Promise<{ kind: "healthy" }>((resolve) => {
      finish = resolve;
    });
    const actions = fakeLaunchersActions({ codexDoctor: vi.fn(() => pending) });
    mount(actions, sessionWith(ONE_CANDIDATE, SAVED_CODEX));
    expect(healthRegion().textContent).toBe("");
    fireEvent.click(checkButton());
    expect(healthRegion().textContent).toContain("Checking…");
    expect(healthRegion().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(checkButton());
    expect(actions.codexDoctor).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ kind: "healthy" });
      await pending;
    });
    expect(healthRegion().textContent).toContain("Codex doctor reports it's healthy.");
    expect(healthRegion().getAttribute("aria-busy")).toBeNull();
  });

  it("shows exactly the problem line for a problem outcome and echoes nothing else", async () => {
    const actions = fakeLaunchersActions({
      codexDoctor: vi.fn(() => Promise.resolve({ kind: "problem" as const })),
    });
    mount(actions, sessionWith(ONE_CANDIDATE, SAVED_CODEX));
    fireEvent.click(checkButton());
    await settle();
    expect(healthRegion().textContent).toContain("Codex doctor reported a problem.");
    expect(healthRegion().querySelector(".ccc-error-glyph")).not.toBeNull();
    expect(healthRegion().textContent).not.toMatch(/\/|check|version/i);
  });

  it.each(["service-disconnected", "failed"] as const)(
    "shows the existing service-failure line for a %s outcome",
    async (kind) => {
      const actions = fakeLaunchersActions({
        codexDoctor: vi.fn(() => Promise.resolve({ kind })),
      });
      mount(actions, sessionWith(ONE_CANDIDATE, SAVED_CODEX));
      fireEvent.click(checkButton());
      await settle();
      expect(healthRegion().textContent).toContain("Couldn't reach the command center service.");
      expect(healthRegion().textContent).toContain(
        "Check the service in Settings → Diagnostics, then try again.",
      );
    },
  );

  it("can be pressed again after it finishes", async () => {
    const actions = fakeLaunchersActions();
    mount(actions, sessionWith(ONE_CANDIDATE, SAVED_CODEX));
    fireEvent.click(checkButton());
    await settle();
    fireEvent.click(checkButton());
    await settle();
    expect(actions.codexDoctor).toHaveBeenCalledTimes(2);
  });

});

describe("accessibility floors", () => {
  it("has unique accessible names for its controls, each containing its visible label", () => {
    mount(fakeLaunchersActions(), sessionWith(TWO_CANDIDATES, SAVED_CODEX));
    typeArgs(["--model"]);
    const controls = [
      ...within(panel()).getAllByRole("button"),
      ...within(panel()).getAllByRole("radio"),
      ...within(panel()).getAllByRole("textbox"),
    ];
    const names = controls.map(
      (control) =>
        control.getAttribute("aria-label") ??
        control.closest("label")?.textContent?.replace(/\s+/g, " ").trim() ??
        document.querySelector(`label[for="${control.id}"]`)?.textContent ??
        control.textContent ??
        "",
    );
    // The two Remove/Add buttons carry their own visible labels; every name is unique per control.
    expect(new Set(names.filter((name) => name.startsWith("Found Codex"))).size).toBe(2);
    expect(within(panel()).getByRole("button", { name: "Check Codex health" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Test the Codex launcher" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Save launcher" })).toBeTruthy();
  });

  it("keeps the save/test status and the health result in two persistent status regions", () => {
    mount(fakeLaunchersActions(), sessionWith(ONE_CANDIDATE, SAVED_CODEX));
    const regions = within(panel()).getAllByRole("status");
    expect(regions).toHaveLength(2);
    expect(regions.map((element) => element.textContent)).toEqual(["", ""]);
  });

  it("disconnected: every new control is aria-disabled yet still focusable", () => {
    mount(fakeLaunchersActions(), sessionWith(ONE_CANDIDATE, SAVED_CODEX), DISCONNECTED);
    for (const name of ["Save launcher", "Test the Codex launcher", "Check Codex health"]) {
      const button = within(panel()).getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);
    }
  });
});
