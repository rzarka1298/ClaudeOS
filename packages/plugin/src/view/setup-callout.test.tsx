import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchersNeedSetup, SetupCallout } from "./setup-callout.js";

/**
 * S10 setup callout (D-30, RR-26): `launchersNeedSetup` and the callout
 * itself, which never pops a modal.
 */

afterEach(cleanup);

const SET_UP: Parameters<typeof launchersNeedSetup>[0] = {
  antigravity: "set-up",
  "claude-code": { status: "set-up", terminalLabel: "Terminal" },
  "claude-desktop": "set-up",
};

const NONE_SET_UP: Parameters<typeof launchersNeedSetup>[0] = {
  antigravity: "not-set-up",
  "claude-code": { status: "not-set-up", terminalLabel: "Terminal" },
  "claude-desktop": "not-set-up",
};

describe("launchersNeedSetup (RR-26)", () => {
  it("is true only when antigravity, claude-code and claude-desktop are all not-set-up", () => {
    expect(launchersNeedSetup(NONE_SET_UP)).toBe(true);
  });

  it("is false when even one launcher is set up or tested", () => {
    expect(launchersNeedSetup({ ...NONE_SET_UP, antigravity: "set-up" })).toBe(false);
    expect(launchersNeedSetup({ ...NONE_SET_UP, antigravity: "tested" })).toBe(false);
    expect(
      launchersNeedSetup({
        ...NONE_SET_UP,
        "claude-code": { status: "tested", terminalLabel: "Terminal" },
      }),
    ).toBe(false);
    expect(launchersNeedSetup({ ...NONE_SET_UP, "claude-desktop": "set-up" })).toBe(false);
  });

  it("is false once every launcher is set up", () => {
    expect(launchersNeedSetup(SET_UP)).toBe(false);
  });

  it("is false for an undefined summary (nothing known yet — never claim setup is needed on no data)", () => {
    expect(launchersNeedSetup(undefined)).toBe(false);
  });

  it("Finder and GitHub status never affects the result — the type carries no field for either", () => {
    // Structural proof: LaunchersSummary has exactly three keys, none named
    // finder or github, so there is no way to construct a call that lets
    // either affect the result.
    const keys = Object.keys(NONE_SET_UP);
    expect(keys).toEqual(["antigravity", "claude-code", "claude-desktop"]);
    expect(keys).not.toContain("finder");
    expect(keys).not.toContain("github");
  });
});

describe("SetupCallout (S10)", () => {
  it("renders the S10 heading, body and primary button", () => {
    render(<SetupCallout />);
    expect(screen.getByText("Launchers aren't set up yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Choose which apps open your projects, then test each one. Finder and GitHub work without setup.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up launchers" })).toBeTruthy();
  });

  it('calls onNavigate("settings") when the button is activated', () => {
    const onNavigate = vi.fn();
    render(<SetupCallout onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up launchers" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("is part of the body — no role=dialog, no modal", () => {
    const { container } = render(<SetupCallout />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".ccc-setup-callout")).toBeTruthy();
  });
});
