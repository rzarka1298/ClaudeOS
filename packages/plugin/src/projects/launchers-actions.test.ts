import {
  type DetectionResponse,
  LAUNCHER_TEST_AUTOMATION_CAP_MS,
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_MARK_TESTED_PATH,
  LAUNCHERS_SAVE_PATH,
  LAUNCHERS_TEST_PATH,
  type LauncherConfigView,
  SYSTEM_SETTINGS_OPEN_PATH,
} from "@ccc/domain";
import type { SocketApiClient, SocketRequestOptions } from "@ccc/service-api-client";
import { SocketUnreachableError } from "@ccc/service-api-client";
import { describe, expect, it } from "vitest";
import { createLaunchersActions, type LaunchersActions } from "./launchers-actions.js";

/**
 * `createLaunchersActions` (Task 1): the one seam the Launchers section
 * reaches the service through. Every method resolves an outcome and never
 * rejects; a socket failure is classified by `errno` alone and its message
 * — which embeds the socket path — is never read (SC-3).
 */

interface RecordedRequest {
  readonly path: string;
  readonly body: unknown;
  readonly timeoutMs: number | undefined;
}

function fakeClient(reply: (path: string) => { status: number; body: unknown }): {
  client: SocketApiClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    client: {
      request<T>(opts: SocketRequestOptions): Promise<{ status: number; body: T }> {
        requests.push({ path: opts.path, body: opts.body, timeoutMs: opts.timeoutMs });
        const answer = reply(opts.path);
        return Promise.resolve({ status: answer.status, body: answer.body as T });
      },
    },
  };
}

/** A socket error whose message getter throws: reading it fails the test. */
function unreadableSocketError(errno: string): SocketUnreachableError {
  const cause = Object.assign(new Error("cause"), { code: errno });
  const error = new SocketUnreachableError("/tmp/ccc-test.sock", cause);
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("the socket error's message was read");
    },
  });
  return error;
}

function throwingClient(error: unknown): SocketApiClient {
  return {
    request(): Promise<never> {
      return Promise.reject(error);
    },
  };
}

const DETECTION: DetectionResponse = {
  detectedAt: "2026-09-30T10:00:00.000Z",
  apps: {
    antigravity: [
      { bundleId: "com.example.antigravity", name: "Antigravity", location: "applications" },
    ],
    "claude-desktop": [],
    iterm2: [],
    ghostty: [],
    wezterm: [],
    terminal: [],
  },
  claudeExecutables: [],
  terminalPresets: [],
  git: "available",
};

const CONFIGS: LauncherConfigView = {
  antigravity: { bundleId: "com.example.antigravity", tested: false },
  "claude-code": null,
  "claude-desktop": null,
};

const OK = { status: 200, body: { ok: true } };

describe("createLaunchersActions (Task 1)", () => {
  it("detect resolves the detection response from the detect route", async () => {
    const { client, requests } = fakeClient(() => ({ status: 200, body: DETECTION }));
    const outcome = await createLaunchersActions(client).detect();
    expect(outcome).toEqual({ kind: "detected", detection: DETECTION });
    expect(requests[0]?.path).toBe(LAUNCHERS_DETECT_PATH);
  });

  it("getConfigs resolves the saved, display-safe configuration", async () => {
    const { client, requests } = fakeClient(() => ({ status: 200, body: CONFIGS }));
    const outcome = await createLaunchersActions(client).getConfigs();
    expect(outcome).toEqual({ kind: "loaded", configs: CONFIGS });
    expect(requests[0]?.path).toBe(LAUNCHERS_GET_PATH);
  });

  it("save posts exactly the request and resolves saved", async () => {
    const { client, requests } = fakeClient(() => OK);
    const outcome = await createLaunchersActions(client).save({
      launcherId: "antigravity",
      bundleId: "com.example.antigravity",
    });
    expect(outcome).toEqual({ kind: "saved" });
    expect(requests[0]?.path).toBe(LAUNCHERS_SAVE_PATH);
    expect(requests[0]?.body).toEqual({
      launcherId: "antigravity",
      bundleId: "com.example.antigravity",
    });
  });

  it("save resolves a structured refusal as { reason, index, template } (PR-13)", async () => {
    const { client } = fakeClient(() => ({
      status: 422,
      body: {
        error: "launcher config refused",
        reason: "forbidden-flag",
        index: 2,
        template: "claude-code",
      },
    }));
    const outcome = await createLaunchersActions(client).save({
      launcherId: "claude-code",
      executable: { kind: "candidate", candidateId: "c1" },
      args: ["--model", "--dangerously-skip-permissions"],
      terminal: { kind: "terminal-app" },
    });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "forbidden-flag",
      index: 2,
      template: "claude-code",
    });
  });

  it("test resolves sent for { ok: true } and the D-26 kind for { ok: false }", async () => {
    const sent = fakeClient(() => OK);
    expect(await createLaunchersActions(sent.client).test("finder")).toEqual({ kind: "sent" });
    expect(sent.requests[0]?.path).toBe(LAUNCHERS_TEST_PATH);
    expect(sent.requests[0]?.body).toEqual({ launcherId: "finder" });

    const refused = fakeClient(() => ({
      status: 200,
      body: { ok: false, error: "automation-denied" },
    }));
    expect(await createLaunchersActions(refused.client).test("claude-code")).toEqual({
      kind: "error",
      error: "automation-denied",
    });
  });

  it("a Test that may meet the Automation prompt waits past the service's cap (wave 5)", async () => {
    const { client, requests } = fakeClient(() => OK);
    await createLaunchersActions(client).test("claude-code", {
      kind: "custom",
      preset: "iterm2",
      argv: ["/usr/bin/osascript", "-e", "tell app", "{script}"],
    });
    expect(requests[0]?.timeoutMs).toBeGreaterThan(LAUNCHER_TEST_AUTOMATION_CAP_MS);
  });

  it("a Test of a newer configuration (409) resolves conflict", async () => {
    const { client } = fakeClient(() => ({ status: 409, body: { error: "launcher changed" } }));
    expect(await createLaunchersActions(client).test("antigravity")).toEqual({ kind: "conflict" });
  });

  it("markTested resolves marked, and needs-test for the service's 409 (RR-14)", async () => {
    const marked = fakeClient(() => OK);
    expect(await createLaunchersActions(marked.client).markTested("antigravity")).toEqual({
      kind: "marked",
    });
    expect(marked.requests[0]?.path).toBe(LAUNCHERS_MARK_TESTED_PATH);
    expect(marked.requests[0]?.body).toEqual({ launcherId: "antigravity" });

    const conflict = fakeClient(() => ({
      status: 409,
      body: { error: "launcher has no passing test" },
    }));
    expect(await createLaunchersActions(conflict.client).markTested("antigravity")).toEqual({
      kind: "needs-test",
    });
  });

  it("openSystemSettings sends only the pane enum", async () => {
    const { client, requests } = fakeClient(() => OK);
    expect(await createLaunchersActions(client).openSystemSettings("automation")).toEqual({
      kind: "opened",
    });
    expect(requests[0]?.path).toBe(SYSTEM_SETTINGS_OPEN_PATH);
    expect(requests[0]?.body).toEqual({ pane: "automation" });
  });
});

describe("every action resolves and never rejects (SC-3)", () => {
  const calls: ReadonlyArray<[string, (actions: LaunchersActions) => Promise<unknown>]> = [
    ["detect", (a) => a.detect()],
    ["getConfigs", (a) => a.getConfigs()],
    ["save", (a) => a.save({ launcherId: "antigravity", bundleId: "com.example.antigravity" })],
    ["markTested", (a) => a.markTested("antigravity")],
    ["openSystemSettings", (a) => a.openSystemSettings("privacy-security")],
  ];

  it.each(calls)(
    "%s: an unreachable socket is service-disconnected, by errno only",
    async (_name, call) => {
      const actions = createLaunchersActions(throwingClient(unreadableSocketError("ECONNREFUSED")));
      await expect(call(actions)).resolves.toEqual({ kind: "service-disconnected" });
    },
  );

  it.each(calls)("%s: any other failure is failed", async (_name, call) => {
    const actions = createLaunchersActions(throwingClient(new TypeError("boom")));
    await expect(call(actions)).resolves.toEqual({ kind: "failed" });
  });

  it("test: an unreachable socket is the D-26 service-disconnected kind, a transport timeout is timeout", async () => {
    const down = createLaunchersActions(throwingClient(unreadableSocketError("ENOENT")));
    await expect(down.test("antigravity")).resolves.toEqual({
      kind: "error",
      error: "service-disconnected",
    });
    const slow = createLaunchersActions(throwingClient(unreadableSocketError("ETIMEDOUT")));
    await expect(slow.test("antigravity")).resolves.toEqual({ kind: "error", error: "timeout" });
    const other = createLaunchersActions(throwingClient(new TypeError("boom")));
    await expect(other.test("antigravity")).resolves.toEqual({
      kind: "error",
      error: "spawn-failed",
    });
  });
});
