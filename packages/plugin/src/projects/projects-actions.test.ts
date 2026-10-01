import {
  newProjectId,
  newScanRootId,
  type RegisterProjectResponse,
  SCAN_ROOTS_ADD_PATH,
  SCAN_ROOTS_LIST_PATH,
  SCAN_ROOTS_REMOVE_PATH,
  SCAN_ROOTS_RESCAN_PATH,
  type ScanStateResponse,
  SUGGESTION_DISMISS_PATH,
  SUGGESTION_REGISTER_PATH,
} from "@ccc/domain";
import type { SocketApiClient, SocketRequestOptions } from "@ccc/service-api-client";
import { ProjectsRequestError, SocketUnreachableError } from "@ccc/service-api-client";
import { describe, expect, it } from "vitest";
import { createProjectsActions, createScanActions } from "./projects-actions.js";

/**
 * `createProjectsActions` (Task 1): the ONE seam through which
 * `packages/plugin/src/view/**` and `packages/plugin/src/widgets/**` reach
 * `@ccc/service-api-client` behavior — never directly (PATTERNS host-seam
 * rule; the S3/S4 component tests assert the import boundary itself).
 */

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function fakeClient(reply: { status: number; body: unknown }): {
  client: SocketApiClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    client: {
      request<T>(opts: SocketRequestOptions): Promise<{ status: number; body: T }> {
        requests.push({ method: opts.method, path: opts.path, body: opts.body });
        return Promise.resolve({ status: reply.status, body: reply.body as T });
      },
    },
  };
}

function throwingClient(error: Error): SocketApiClient {
  return {
    request(): Promise<never> {
      return Promise.reject(error);
    },
  };
}

const PROJECT_ID = newProjectId();

describe("createProjectsActions (Task 1)", () => {
  it("register: resolves the registered outcome and posts exactly the path", async () => {
    const registered: RegisterProjectResponse = { kind: "registered", projectId: PROJECT_ID };
    const { client, requests } = fakeClient({ status: 200, body: registered });
    const actions = createProjectsActions(client);

    const outcome = await actions.register("/Users/USERNAME/code/example-project");

    expect(outcome).toEqual({ kind: "registered", projectId: PROJECT_ID });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({ path: "/Users/USERNAME/code/example-project" });
  });

  it("register: forwards acknowledgeProtectedLocation and resolves protected-location", async () => {
    const { client, requests } = fakeClient({
      status: 200,
      body: { kind: "protected-location", location: "documents" },
    });
    const actions = createProjectsActions(client);

    const outcome = await actions.register("/Users/USERNAME/Documents/example-project", true);

    expect(outcome).toEqual({ kind: "protected-location", location: "documents" });
    expect(requests[0]?.body).toEqual({
      path: "/Users/USERNAME/Documents/example-project",
      acknowledgeProtectedLocation: true,
    });
  });

  it("register: a 422 refusal resolves refused, never rejects", async () => {
    const client = throwingClient(new ProjectsRequestError(422, "project refused"));
    const actions = createProjectsActions(client);

    await expect(actions.register("/etc")).resolves.toEqual({ kind: "refused" });
  });

  it("register: a 400 invalid body resolves invalid", async () => {
    const client = throwingClient(new ProjectsRequestError(400, "invalid request body"));
    const actions = createProjectsActions(client);

    await expect(actions.register("bad")).resolves.toEqual({ kind: "invalid" });
  });

  it("register: an ECONNREFUSED SocketUnreachableError resolves service-disconnected, and .message is never read (SC-3)", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const error = new SocketUnreachableError("/tmp/ccc.sock", cause);
    let messageWasRead = false;
    Object.defineProperty(error, "message", {
      get() {
        messageWasRead = true;
        return "Could not reach the service socket at /tmp/ccc.sock";
      },
    });
    const client = throwingClient(error);
    const actions = createProjectsActions(client);

    const outcome = await actions.register("/Users/USERNAME/code/example-project");

    expect(outcome).toEqual({ kind: "service-disconnected" });
    expect(messageWasRead).toBe(false);
  });

  it("register: an ENOENT SocketUnreachableError also resolves service-disconnected", async () => {
    const cause = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const client = throwingClient(new SocketUnreachableError("/tmp/ccc.sock", cause));
    const actions = createProjectsActions(client);

    await expect(actions.register("/x")).resolves.toEqual({ kind: "service-disconnected" });
  });

  it("register: an unrecognised failure resolves failed", async () => {
    const client = throwingClient(new Error("boom"));
    const actions = createProjectsActions(client);

    await expect(actions.register("/x")).resolves.toEqual({ kind: "failed" });
  });

  it("remove: resolves ok and posts exactly the projectId", async () => {
    const { client, requests } = fakeClient({ status: 200, body: { ok: true } });
    const actions = createProjectsActions(client);

    await expect(actions.remove(PROJECT_ID)).resolves.toEqual({ kind: "ok" });
    expect(requests[0]?.body).toEqual({ projectId: PROJECT_ID });
  });

  it("rename: resolves ok and posts the projectId and displayName", async () => {
    const { client, requests } = fakeClient({ status: 200, body: { ok: true } });
    const actions = createProjectsActions(client);

    await expect(actions.rename(PROJECT_ID, "renamed")).resolves.toEqual({ kind: "ok" });
    expect(requests[0]?.body).toEqual({ projectId: PROJECT_ID, displayName: "renamed" });
  });

  it("pin: resolves ok and posts the projectId and pinned flag", async () => {
    const { client, requests } = fakeClient({ status: 200, body: { ok: true } });
    const actions = createProjectsActions(client);

    await expect(actions.pin(PROJECT_ID, true)).resolves.toEqual({ kind: "ok" });
    expect(requests[0]?.body).toEqual({ projectId: PROJECT_ID, pinned: true });
  });

  it("setGithubLink: resolves ok and posts the projectId and url, null clears it", async () => {
    const { client, requests } = fakeClient({ status: 200, body: { ok: true } });
    const actions = createProjectsActions(client);

    await expect(actions.setGithubLink(PROJECT_ID, null)).resolves.toEqual({ kind: "ok" });
    expect(requests[0]?.body).toEqual({ projectId: PROJECT_ID, url: null });
  });

  it("refresh: resolves ok and posts no body when no projectId is given", async () => {
    const { client, requests } = fakeClient({ status: 200, body: { ok: true } });
    const actions = createProjectsActions(client);

    await expect(actions.refresh()).resolves.toEqual({ kind: "ok" });
    expect(requests[0]?.body).toEqual({});
  });

  it("a management action's 422 refusal resolves refused, never rejects", async () => {
    const client = throwingClient(new ProjectsRequestError(422, "project not found"));
    const actions = createProjectsActions(client);

    await expect(actions.remove(PROJECT_ID)).resolves.toEqual({ kind: "refused" });
  });
});

const SCAN_ROOT_ID = newScanRootId();
const SCAN_STATE: ScanStateResponse = {
  scanRoots: [
    {
      scanRootId: SCAN_ROOT_ID,
      displayPath: "~/code",
      depth: 1,
      addedAt: "2026-09-30T00:00:00.000Z",
      lastScannedAt: "2026-09-30T00:00:01.000Z",
    },
  ],
  suggestions: [
    {
      suggestionId: "abc123",
      scanRootId: SCAN_ROOT_ID,
      folderName: "example-project",
      displayPath: "~/code/example-project",
    },
  ],
  partial: false,
};

describe("createScanActions (plan 04-13 Task 1)", () => {
  it("addScanRoot: resolves the scan state and posts exactly the path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SCAN_STATE });
    const outcome = await createScanActions(client).addScanRoot("/Users/USERNAME/code");
    expect(outcome).toEqual({ kind: "state", state: SCAN_STATE });
    expect(requests).toEqual([
      { method: "POST", path: SCAN_ROOTS_ADD_PATH, body: { path: "/Users/USERNAME/code" } },
    ]);
  });

  it("addScanRoot: forwards acknowledgeProtectedLocation only when given", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SCAN_STATE });
    await createScanActions(client).addScanRoot("/Users/USERNAME/Documents/code", true);
    expect(requests[0]?.body).toEqual({
      path: "/Users/USERNAME/Documents/code",
      acknowledgeProtectedLocation: true,
    });
  });

  it("rescan, removeScanRoot and listScanState address the scan folder by ID only", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SCAN_STATE });
    const actions = createScanActions(client);
    expect(await actions.rescan(SCAN_ROOT_ID, 2)).toEqual({ kind: "state", state: SCAN_STATE });
    expect(await actions.removeScanRoot(SCAN_ROOT_ID)).toEqual({
      kind: "state",
      state: SCAN_STATE,
    });
    expect(await actions.listScanState()).toEqual({ kind: "state", state: SCAN_STATE });
    expect(requests).toEqual([
      {
        method: "POST",
        path: SCAN_ROOTS_RESCAN_PATH,
        body: { scanRootId: SCAN_ROOT_ID, depth: 2 },
      },
      { method: "POST", path: SCAN_ROOTS_REMOVE_PATH, body: { scanRootId: SCAN_ROOT_ID } },
      { method: "POST", path: SCAN_ROOTS_LIST_PATH, body: {} },
    ]);
  });

  it("registerSuggestion resolves registered and dismissSuggestion resolves ok, by suggestionId only", async () => {
    const registered: RegisterProjectResponse = { kind: "registered", projectId: PROJECT_ID };
    const reg = fakeClient({ status: 200, body: registered });
    expect(await createScanActions(reg.client).registerSuggestion("abc123")).toEqual(registered);
    expect(reg.requests).toEqual([
      { method: "POST", path: SUGGESTION_REGISTER_PATH, body: { suggestionId: "abc123" } },
    ]);
    const dis = fakeClient({ status: 200, body: { ok: true } });
    expect(await createScanActions(dis.client).dismissSuggestion("abc123")).toEqual({ kind: "ok" });
    expect(dis.requests[0]?.path).toBe(SUGGESTION_DISMISS_PATH);
  });

  it("never rejects: 422 refused, 400 invalid, unreachable service-disconnected, anything else failed", async () => {
    const refused = createScanActions(
      fakeClient({ status: 422, body: { error: "folder cannot be scanned" } }).client,
    );
    expect(await refused.addScanRoot("/Users/USERNAME/code")).toEqual({ kind: "refused" });
    expect(await refused.registerSuggestion("abc123")).toEqual({ kind: "refused" });
    const invalid = createScanActions(
      fakeClient({ status: 400, body: { error: "invalid request body" } }).client,
    );
    expect(await invalid.rescan(SCAN_ROOT_ID)).toEqual({ kind: "invalid" });
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const down = createScanActions(
      throwingClient(new SocketUnreachableError("/tmp/ccc.sock", cause)),
    );
    expect(await down.listScanState()).toEqual({ kind: "service-disconnected" });
    expect(await down.dismissSuggestion("abc123")).toEqual({ kind: "service-disconnected" });
    const broken = createScanActions(throwingClient(new Error("boom")));
    expect(await broken.removeScanRoot(SCAN_ROOT_ID)).toEqual({ kind: "failed" });
  });
});
