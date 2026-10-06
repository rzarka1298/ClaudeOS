import { describe, expect, it, vi } from "vitest";
import { createHostRegistry } from "../host-registry.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { APPROVAL_PROTOCOL_ACTION, registerApprovalProtocol } from "./protocol.js";

const VALID_ID = "abcdefghij0123456789abcde";

function setup() {
  const host = new FakeObsidianHost();
  const registry = createHostRegistry(host);
  const navigateToApproval = vi.fn<(id: string | null) => void>();
  const log = vi.fn<(message: string) => void>();
  return { host, registry, navigateToApproval, log };
}

describe("registerApprovalProtocol (plan 06-09, D-26, research Pattern 9)", () => {
  it("registers the ccc-approval action once, through the registry", () => {
    const { host, registry, navigateToApproval, log } = setup();

    registerApprovalProtocol(registry, { navigateToApproval, log });

    expect(APPROVAL_PROTOCOL_ACTION).toBe("ccc-approval");
    expect(registry.liveCount()).toBe(1);
    expect(host.liveCounts().protocolHandler).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("routes a delivered link to the navigation dependency", () => {
    const { host, registry, navigateToApproval, log } = setup();
    registerApprovalProtocol(registry, { navigateToApproval, log });

    host.fireProtocol("ccc-approval", { action: "ccc-approval", id: VALID_ID });

    expect(navigateToApproval).toHaveBeenCalledTimes(1);
    expect(navigateToApproval).toHaveBeenCalledWith(VALID_ID);
  });

  it("a second registration with the same registry does not throw out of the function; the throw is reported through the log", () => {
    const { host, registry, navigateToApproval, log } = setup();
    registerApprovalProtocol(registry, { navigateToApproval, log });

    expect(() => registerApprovalProtocol(registry, { navigateToApproval, log })).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("ccc-approval");
    expect(registry.liveCount()).toBe(1);
    expect(host.liveCounts().protocolHandler).toBe(1);
  });

  it("the handler is gone after disposeAll", () => {
    const { host, registry, navigateToApproval, log } = setup();
    registerApprovalProtocol(registry, { navigateToApproval, log });

    registry.disposeAll();

    expect(host.liveCounts().protocolHandler).toBe(0);
    expect(host.fireProtocol("ccc-approval", { id: VALID_ID })).toBe(false);
    expect(navigateToApproval).not.toHaveBeenCalled();
  });
});
