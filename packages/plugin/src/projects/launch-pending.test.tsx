import { newProjectId } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import { signal } from "@preact/signals";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { Shell } from "../view/shell.js";
import type { WidgetState } from "../widgets/contract.js";
import type { ProjectShortcutsData } from "../widgets/panels.js";
import type { WidgetId } from "../widgets/registry.js";
import { createLaunchRequester } from "./launch-client.js";
import { resetLaunchStatus } from "./launch-status.js";

/**
 * The end-to-end tracer (Task 1): a click on the Finder button inside the
 * REAL Project shortcuts card (rendered through the real `Shell`) travels as
 * a `launch:finder` descriptor through the one dispatcher, into a REAL
 * `createLaunchRequester`, and acknowledges in the SAME render — no `await`,
 * no `act` flush, no timer advance between the click and the assertion
 * (D-40, PERF-05).
 */

const PROJECT_ID = newProjectId();

function readyProjectShortcuts(): WidgetState<ProjectShortcutsData> {
  const now = new Date().toISOString();
  return {
    kind: "ready",
    data: {
      projects: [
        {
          id: PROJECT_ID,
          name: "example-project",
          pinned: false,
          git: {
            kind: "repo",
            branch: "main",
            detached: false,
            dirty: false,
            commits: [],
            remote: null,
          },
          gitReadFailed: false,
          github: { kind: "none" },
          observedAt: now,
          openItems: null,
          sessionCount: null,
          nextTask: null,
        },
      ],
      launchers: {
        antigravity: "set-up",
        "claude-code": { status: "set-up", terminalLabel: "Terminal" },
        "claude-desktop": "set-up",
      },
    },
    observedAt: now,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };
}

function stateForOverride(id: WidgetId) {
  if (id === "project-shortcuts") return signal<WidgetState<unknown>>(readyProjectShortcuts());
  return signal<WidgetState<unknown>>({ kind: "unavailable" });
}

function hostTimers() {
  return {
    setTimer: (callback: () => void, ms: number): number => window.setTimeout(callback, ms),
    clearTimer: (id: number): void => window.clearTimeout(id),
  };
}

function neverSettlingClient(): { client: SocketApiClient; calls: number } {
  const state = { calls: 0 };
  return {
    calls: 0,
    client: {
      request: () => {
        state.calls += 1;
        return new Promise(() => {});
      },
    },
  };
}

afterEach(() => {
  cleanup();
  resetLaunchStatus();
  connectionState.value = { kind: "connecting" };
});

beforeEach(() => {
  resetLaunchStatus();
  connectionState.value = { kind: "live" };
});

describe('click Finder on a Project shortcuts row (Task 1 tracer, "Revealing in Finder…" before any await)', () => {
  it("acknowledges in the same render: status text, aria-disabled and data-launch-state, label unchanged", () => {
    const { client } = neverSettlingClient();
    const requestLaunch = createLaunchRequester({
      client,
      notify: vi.fn(),
      connection: () => connectionState.value,
      projectName: () => "example-project",
      ...hostTimers(),
    });

    render(<Shell stateFor={stateForOverride} requestLaunch={requestLaunch} />);

    const finderButton = screen.getByRole("button", { name: "Reveal example-project in Finder" });
    fireEvent.click(finderButton);

    expect(screen.getByText("Revealing in Finder…")).toBeTruthy();
    expect(finderButton.getAttribute("aria-disabled")).toBe("true");
    expect(finderButton.getAttribute("data-launch-state")).toBe("opening");
    expect(finderButton.textContent).toBe("Finder");
  });

  it("a second click while opening sends no second request", () => {
    const record = { calls: 0 };
    const client: SocketApiClient = {
      request: () => {
        record.calls += 1;
        return new Promise(() => {});
      },
    };
    const requestLaunch = createLaunchRequester({
      client,
      notify: vi.fn(),
      connection: () => connectionState.value,
      projectName: () => "example-project",
      ...hostTimers(),
    });

    render(<Shell stateFor={stateForOverride} requestLaunch={requestLaunch} />);

    const finderButton = screen.getByRole("button", { name: "Reveal example-project in Finder" });
    fireEvent.click(finderButton);
    fireEvent.click(finderButton);

    expect(record.calls).toBe(1);
  });
});
