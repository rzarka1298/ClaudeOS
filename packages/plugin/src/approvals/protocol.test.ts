import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createHostRegistry } from "../host-registry.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import {
  APPROVAL_PROTOCOL_ACTION,
  createApprovalProtocolHandler,
  registerApprovalProtocol,
} from "./protocol.js";

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

describe("the ccc-approval handler only navigates, on a pattern-matched id (T-06-11)", () => {
  function handlerWith() {
    const navigateToApproval = vi.fn<(id: string | null) => void>();
    const handler = createApprovalProtocolHandler({ navigateToApproval });
    return { handler, navigateToApproval };
  }

  it("navigates once with the id when it matches the proposal id pattern exactly", () => {
    const { handler, navigateToApproval } = handlerWith();

    handler({ action: "ccc-approval", id: VALID_ID });

    expect(navigateToApproval).toHaveBeenCalledTimes(1);
    expect(navigateToApproval).toHaveBeenCalledWith(VALID_ID);
  });

  const HOSTILE: readonly [string, Record<string, unknown>][] = [
    ["a missing id", { action: "ccc-approval" }],
    ["an array", { id: [VALID_ID] }],
    ["a number", { id: 12345 }],
    ["an object", { id: { toString: () => VALID_ID } }],
    ["an empty string", { id: "" }],
    ["a 24-character string", { id: VALID_ID.slice(0, 24) }],
    ["a 26-character string", { id: `${VALID_ID}a` }],
    ["upper-case letters", { id: VALID_ID.toUpperCase() }],
    ["a path-like string", { id: "../../etc/passwd0000000000" }],
    ["a script-like string", { id: "<script>alert(1)</script>" }],
    ["surrounding whitespace", { id: ` ${VALID_ID} ` }],
    ["a trailing newline", { id: `${VALID_ID}\n` }],
    ["an action parameter alone", { action: "approve", vault: "x" }],
    ["extra parameters alone", { vault: "x", decision: "approved", other: "y" }],
    ["an id only on the prototype", Object.create({ id: VALID_ID }) as Record<string, unknown>],
  ];

  for (const [name, params] of HOSTILE) {
    it(`navigates to the unknown-request pane for ${name} and never throws`, () => {
      const { handler, navigateToApproval } = handlerWith();

      expect(() => handler(params)).not.toThrow();

      expect(navigateToApproval).toHaveBeenCalledTimes(1);
      expect(navigateToApproval).toHaveBeenCalledWith(null);
    });
  }

  it("extra parameters never influence the id", () => {
    const { handler, navigateToApproval } = handlerWith();

    handler({
      action: "ccc-approval",
      vault: "Other vault",
      decision: "approved",
      id: VALID_ID,
      id2: "zzzzzzzzzzzzzzzzzzzzzzzzz",
    });

    expect(navigateToApproval).toHaveBeenCalledTimes(1);
    expect(navigateToApproval).toHaveBeenCalledWith(VALID_ID);
  });

  it("the registered handler applies the same rules to a delivered link", () => {
    const { host, registry, navigateToApproval, log } = setup();
    registerApprovalProtocol(registry, { navigateToApproval, log });

    host.fireProtocol("ccc-approval", { action: "ccc-approval", id: "not-an-id" });
    host.fireProtocol("ccc-approval", { action: "ccc-approval", id: VALID_ID });

    expect(navigateToApproval.mock.calls).toEqual([[null], [VALID_ID]]);
  });

  describe("source scan", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "protocol.ts"),
      "utf8",
    );

    it("imports only the host registry types and the domain id pattern", () => {
      const specifiers = [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      expect(specifiers.sort()).toEqual(["../host-registry.js", "@ccc/domain/approval.js"]);
    });

    it("has no approvals client, no decide or approve symbol and no fetch", () => {
      expect(source).not.toMatch(/\b(decide|approve|deny|denied|approved)\w*/i);
      expect(source).not.toMatch(/\bfetch\b|\.request\s*\(|service-api-client|approvals-client/);
    });

    it("gives the handler exactly one dependency, the navigation", () => {
      const match = /interface ApprovalProtocolHandlerDeps \{([^}]*)\}/.exec(source);
      expect(match).not.toBeNull();
      const members = [...(match?.[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map((m) => m[1]);
      expect(members).toEqual(["navigateToApproval"]);
    });
  });
});
