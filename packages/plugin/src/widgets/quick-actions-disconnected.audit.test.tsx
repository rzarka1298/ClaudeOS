import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import type { WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";
import { type AnyWidgetDefinition, WIDGETS } from "./registry.js";

/**
 * Audit (04-10, UI-SPEC S8 "In disconnected the frame hides the buttons (Phase
 * 3 rule), unchanged"; cross-cutting D-15/D-34 "no launch toolbar renders while
 * disconnected"). Found by the wave-5 visual check: the S8 live pair still
 * renders as enabled, focusable buttons while the service is disconnected,
 * and activating one does nothing (the frame withholds onQuickAction).
 */

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const READY: WidgetState<unknown> = {
  kind: "ready",
  data: {
    launchers: {
      antigravity: "set-up",
      "claude-code": { status: "set-up", terminalLabel: "Terminal" },
      "claude-desktop": "set-up",
    },
  },
  observedAt: "2026-09-30T11:58:00.000Z",
  freshness: "live",
  partiality: { partial: false },
  isEmpty: false,
};

afterEach(() => {
  cleanup();
  connectionState.value = { kind: "connecting" };
});

describe("S8 Quick actions while disconnected (audit)", () => {
  // AUDIT-BUG (wave 5, 04-10): panels.tsx QuickActionsBody renders the live
  // pair regardless of onQuickAction; they stay enabled and inert when
  // disconnected, contrary to UI-SPEC S8. Un-skip once fixed.
  it.skip("renders no enabled live launch button for Start a Claude Code session or Open Claude Desktop", () => {
    const connection = { kind: "disconnected", reason: "The service is not running." } as const;
    connectionState.value = connection;
    render(
      <WidgetFrame
        definition={WIDGETS["quick-actions"] as AnyWidgetDefinition}
        state={READY}
        connection={connection}
        size={WIDGETS["quick-actions"].preferredSize}
        now={NOW}
        onQuickAction={vi.fn()}
      />,
    );
    for (const name of ["Start a Claude Code session", "Open Claude Desktop"]) {
      const button = screen.queryByRole("button", { name });
      if (button !== null) expect(button.getAttribute("aria-disabled")).toBe("true");
    }
  });
});
