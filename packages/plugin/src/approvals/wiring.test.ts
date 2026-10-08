import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { createHostRegistry } from "../host-registry.js";
import { approvalsSnapshot, summary } from "../test-support/approval-fixtures.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { approvalsSectionVisible } from "../view/approvals-state.js";
import { navigationRequest } from "../view/navigation-request.js";
import { ApprovalsApiError, approvalsApi, configureApprovalsApi } from "./api.js";
import { NOTIFY_NOTICE_TEXT, NOTIFY_TITLE, type NotificationHandle } from "./notify.js";
import {
  applyApprovalSummary,
  approvalsCounts,
  approvalsHydrated,
  resetApprovalsState,
  setApprovalUpsertHook,
} from "./signals.js";
import {
  createTestApprovalAction,
  TEST_APPROVAL_FAILED_NOTICE,
  TEST_APPROVAL_STARTED_NOTICE,
  wireApprovals,
} from "./wiring.js";

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function setup(test = vi.fn().mockResolvedValue({ outcome: "proposed", proposalId: "x" })) {
  const host = new FakeObsidianHost();
  const registry = createHostRegistry(host);
  const notices: string[] = [];
  const action = createTestApprovalAction(registry, { test }, (m) => notices.push(m));
  return { host, registry, notices, action, test };
}

describe("Test 2: the test approval action (plan 06-23, D-20, R-22)", () => {
  it("posts the start notice at once, calls the API once after the timer, and ignores a second press", async () => {
    const { host, notices, action, test } = setup();

    action.press();
    action.press();
    expect(notices).toEqual([TEST_APPROVAL_STARTED_NOTICE]);
    expect(TEST_APPROVAL_STARTED_NOTICE).toBe(
      "The test request arrives in 5 seconds. Switch to another app to see the notification.",
    );
    expect(test).not.toHaveBeenCalled();

    host.fireTimers();
    await flush();
    expect(test).toHaveBeenCalledTimes(1);

    action.press();
    expect(notices).toHaveLength(2);
  });

  it("counts the timer as one live registration", () => {
    const { host, registry } = setup();
    expect(host.liveCounts().timer).toBe(1);
    expect(registry.liveCount()).toBe(1);
  });
});

describe("Test 3: failure", () => {
  it("posts the fixed failure notice and re-enables the action", async () => {
    const test = vi.fn().mockRejectedValue(new Error("down"));
    const { host, notices, action } = setup(test);

    action.press();
    host.fireTimers();
    await flush();

    expect(notices).toEqual([TEST_APPROVAL_STARTED_NOTICE, TEST_APPROVAL_FAILED_NOTICE]);
    expect(TEST_APPROVAL_FAILED_NOTICE).toBe(
      "Couldn't send the test request. Check the service in Settings → Diagnostics, then try again.",
    );
    action.press();
    expect(notices).toHaveLength(3);
  });
});

describe("Test 5: unload", () => {
  it("cancels the pending call when the registry is disposed first", async () => {
    const { host, registry, action, test } = setup();

    action.press();
    registry.disposeAll();
    host.fireTimers();
    await flush();

    expect(test).not.toHaveBeenCalled();
    expect(host.liveCounts().timer).toBe(0);
  });
});

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const VALID_ID = "abcdefghij0123456789abcde";
const NEVER_MINTED = "0".repeat(25);

afterEach(() => {
  resetApprovalsState();
  setApprovalUpsertHook(null);
  configureApprovalsApi(null);
  navigationRequest.value = null;
  approvalsSectionVisible.value = false;
  connectionState.value = { kind: "connecting" };
});

function wired(
  options: {
    focused?: boolean;
    enabled?: boolean;
    client?: Partial<Record<"list" | "get" | "decide" | "test", ReturnType<typeof vi.fn>>>;
    host?: FakeObsidianHost;
  } = {},
) {
  const host = options.host ?? new FakeObsidianHost();
  const registry = createHostRegistry(host);
  const notices: string[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const handles: NotificationHandle[] = [];
  const created: { title: string; options: Record<string, unknown> }[] = [];
  const client = {
    list: vi.fn().mockResolvedValue(approvalsSnapshot()),
    get: vi.fn(),
    decide: vi.fn(),
    test: vi.fn().mockResolvedValue({ outcome: "proposed", proposalId: VALID_ID }),
    ...options.client,
  };
  const state = { focused: options.focused ?? false };
  const wiring = wireApprovals(registry, {
    client: client as never,
    notice: (m) => notices.push(m),
    notifyEnabled: () => options.enabled ?? true,
    appFocused: () => state.focused,
    focusWindow: () => calls.push("focus"),
    reveal: () => calls.push("reveal"),
    log: (m) => logs.push(m),
    now: () => NOW,
    createNotification: (title, opts) => {
      created.push({ title, options: { ...opts } });
      const handle: NotificationHandle = { onclick: null };
      handles.push(handle);
      return handle;
    },
  });
  return { host, registry, notices, logs, calls, handles, created, client, state, wiring };
}

describe("Test 1: client injection", () => {
  it("configures the API holder with functions over the client", async () => {
    const { client } = wired();

    await approvalsApi().list();
    await approvalsApi().test();
    const input = { proposalId: VALID_ID, decision: "deny" as const, payloadHash: "a".repeat(64) };
    client.decide.mockResolvedValue({ ok: true });
    await approvalsApi().decide(input);

    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.test).toHaveBeenCalledTimes(1);
    expect(client.decide).toHaveBeenCalledWith(input);
  });

  it("surfaces a thrown client error as a closed code only", async () => {
    const { client } = wired();
    client.get.mockRejectedValueOnce(
      Object.assign(new Error("secret path /x"), { code: "not-found" }),
    );
    client.get.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "weird-code" }));
    client.get.mockRejectedValueOnce(new Error("plain"));

    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      await approvalsApi()
        .get(VALID_ID)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(ApprovalsApiError);
          expect((error as Error).message).toBe((error as ApprovalsApiError).code);
          codes.push((error as ApprovalsApiError).code);
        });
    }
    expect(codes).toEqual(["not-found", "unrecognised-response", "unrecognised-response"]);
  });

  it("restores the disconnected default on unload", async () => {
    const { registry } = wired();
    registry.disposeAll();
    await expect(approvalsApi().list()).rejects.toMatchObject({ code: "service-disconnected" });
  });
});

describe("Test 2: the notifier", () => {
  const fresh = () => summary(1, "pending", 1, { createdAt: new Date(NOW + 1000).toISOString() });

  it("raises a generic native notification when unfocused, tagged with the proposal id", () => {
    const { created } = wired({ focused: false });

    applyApprovalSummary(
      summary(1, "pending", 1, {
        createdAt: new Date(NOW + 1000).toISOString(),
        title: "Force-terminate ccc-hostile-secret",
        requesterLabel: "Daily digest",
        requesterKind: "skill",
        operationLabel: "Force-terminate a Claude session",
      }),
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe(NOTIFY_TITLE);
    expect(created[0]?.options.tag).toBe(fresh().proposalId);
    expect(JSON.stringify(created[0])).not.toContain("hostile-secret");
    expect(created[0]?.options.body).toBe("Daily digest asks to force-terminate a Claude session.");
  });

  it("raises the Notice when focused with the section hidden, and nothing when it is visible", () => {
    const first = wired({ focused: true });
    applyApprovalSummary(fresh());
    expect(first.notices).toEqual([NOTIFY_NOTICE_TEXT]);
    expect(first.created).toHaveLength(0);
    first.registry.disposeAll();
    resetApprovalsState();

    const second = wired({ focused: true });
    approvalsSectionVisible.value = true;
    applyApprovalSummary(fresh());
    expect(second.notices).toEqual([]);
    expect(second.created).toHaveLength(0);
  });

  it("a click focuses Obsidian then selects the request", () => {
    const { handles, calls } = wired({ focused: false });
    applyApprovalSummary(fresh());

    handles[0]?.onclick?.();

    expect(calls).toEqual(["focus", "reveal"]);
    expect(navigationRequest.value).toMatchObject({
      destination: "agent-runs",
      focusProposalId: fresh().proposalId,
    });
  });

  it("clears the upsert hook at unload", () => {
    const { registry, created } = wired({ focused: false });
    registry.disposeAll();
    applyApprovalSummary(fresh());
    expect(created).toHaveLength(0);
  });
});

describe("Test 3: the ccc-approval link", () => {
  it("selects a valid id, and the never-minted id for a malformed or missing one", () => {
    const { host } = wired();

    host.fireProtocol("ccc-approval", { action: "ccc-approval", id: VALID_ID });
    expect(navigationRequest.value).toMatchObject({ focusProposalId: VALID_ID });

    for (const params of [{ id: "not an id" }, { action: "ccc-approval" }, { id: "" }]) {
      navigationRequest.value = null;
      host.fireProtocol("ccc-approval", params);
      expect(navigationRequest.value).toMatchObject({ focusProposalId: NEVER_MINTED });
    }
  });

  it("a duplicate registration is logged without aborting", () => {
    const host = new FakeObsidianHost();
    wired({ host });
    let second: ReturnType<typeof wired> | undefined;
    expect(() => {
      second = wired({ host });
    }).not.toThrow();
    expect(second?.logs.some((m) => m.includes("ccc-approval"))).toBe(true);
  });
});

describe("Test 5: reconnect refresh", () => {
  it("refreshes the snapshot once per call", async () => {
    const { wiring, client } = wired({
      client: { list: vi.fn().mockResolvedValue(approvalsSnapshot({ pending: [summary(1)] })) },
    });

    wiring.onLive();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.list).toHaveBeenCalledTimes(1);
    expect(approvalsHydrated.value).toBe(true);
    expect(approvalsCounts.value.pending).toBe(1);
  });

  it("a failed refresh changes nothing and a disconnect never clears counts", async () => {
    const { wiring } = wired({ client: { list: vi.fn().mockRejectedValue(new Error("down")) } });
    approvalsCounts.value = { pending: 3, decided: 0, expired: 0 };

    wiring.onLive();
    connectionState.value = { kind: "disconnected", reason: "closed" };
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(approvalsCounts.value.pending).toBe(3);
    expect(approvalsHydrated.value).toBe(false);
  });
});

describe("Test 7: no decide path", () => {
  const dir = dirname(fileURLToPath(import.meta.url));

  it("the wiring and commands modules import no client value and create no proposal but the test route", () => {
    for (const file of ["wiring.ts", "commands.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source).not.toMatch(/^import(?! type)[^;]*from "@ccc\/service-api-client"/m);
      expect(source).not.toMatch(/createApprovalsClient|\.submit\(|\.propose\(|propose[A-Z]/);
      expect(source).not.toMatch(/approve\(|deny\(/);
    }
  });
});
