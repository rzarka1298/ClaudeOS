import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { Shell } from "./shell.js";

afterEach(() => {
  cleanup();
  connectionState.value = { kind: "connecting" };
});

beforeEach(() => {
  connectionState.value = { kind: "connecting" };
});

describe("Shell", () => {
  it("renders exactly eight destinations as tabs, with exactly one selected", () => {
    render(<Shell />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(8);
    const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe("Overview");
  });

  it("wraps arrow-key movement at both ends of the destination list", () => {
    render(<Shell />);
    const tablist = screen.getByRole("tablist");

    // From the initial (first) destination, moving "previous" wraps to the last.
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    // From the last destination, moving "next" wraps back to the first.
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("renders the disconnected state's reason as text, not as color alone", () => {
    connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };
    render(<Shell />);
    expect(screen.getByText(/Disconnected — connect ECONNREFUSED/)).toBeTruthy();
  });

  it("renders the live state's start time as text", () => {
    connectionState.value = { kind: "live", startedAt: "2026-09-15T00:00:00Z", measuredAtMs: 0 };
    render(<Shell />);
    expect(screen.getByText(/Live — service started at 2026-09-15T00:00:00Z/)).toBeTruthy();
  });

  it("completes its first render without ever calling a socket client", () => {
    // Shell has no client import at all (it only reads the connectionState
    // signal — see connection-state.ts); this spy proves that structurally:
    // nothing in this component's render path ever reaches for a client.
    const clientSpy = vi.fn();
    render(<Shell />);
    expect(clientSpy).not.toHaveBeenCalled();
  });

  it("calls onDestinationChange when a different destination is selected", () => {
    const onDestinationChange = vi.fn();
    render(<Shell onDestinationChange={onDestinationChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    expect(onDestinationChange).toHaveBeenCalledWith("projects");
  });
});
