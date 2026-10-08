import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostRegistry } from "../host-registry.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { approvalsHeadingRequested, navigationRequest } from "../view/navigation-request.js";
import { OPEN_APPROVAL_INBOX_COMMAND_ID, registerOpenApprovalInboxCommand } from "./commands.js";

class CapturingHost extends FakeObsidianHost {
  readonly commands: { id: string; name: string; callback: () => void }[] = [];
  override addCommand(command: { id: string; name: string; callback: () => void }) {
    this.commands.push(command);
    return super.addCommand(command);
  }
}

afterEach(() => {
  navigationRequest.value = null;
  approvalsHeadingRequested.value = false;
});

describe("Test 4: the Open approval inbox command", () => {
  it("has the UI-SPEC id and name, no hotkey, and avoids the words command and plugin name", () => {
    const host = new CapturingHost();
    const registry = createHostRegistry(host);
    registerOpenApprovalInboxCommand(registry, () => {});

    const command = host.commands[0];
    expect(command?.id).toBe(OPEN_APPROVAL_INBOX_COMMAND_ID);
    expect(command?.id).toBe("open-approval-inbox");
    expect(command?.name).toBe("Open approval inbox");
    expect(command).not.toHaveProperty("hotkeys");
    expect(`${command?.id}${command?.name}`.toLowerCase()).not.toMatch(/command|claude/);
  });

  it("sets the heading intent, requests Agent runs, then reveals, working before any snapshot", () => {
    const host = new CapturingHost();
    const registry = createHostRegistry(host);
    const order: string[] = [];
    const reveal = vi.fn(() => {
      order.push(
        `reveal:${String(approvalsHeadingRequested.value)}:${navigationRequest.value?.destination}`,
      );
    });
    registerOpenApprovalInboxCommand(registry, reveal);
    expect(reveal).not.toHaveBeenCalled();
    expect(navigationRequest.value).toBeNull();

    host.commands[0]?.callback();

    expect(order).toEqual(["reveal:true:agent-runs"]);
    expect(navigationRequest.value).toEqual({
      destination: "agent-runs",
      focusApprovalsHeading: true,
    });
  });
});
