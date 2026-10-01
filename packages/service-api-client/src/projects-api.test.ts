import { readFile } from "node:fs/promises";
import {
  type DetectionResponse,
  LAUNCH_PATH,
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_MARK_TESTED_PATH,
  LAUNCHERS_SAVE_PATH,
  LAUNCHERS_TEST_PATH,
  type LauncherConfigView,
  type LaunchRequest,
  newProjectId,
  newScanRootId,
  PROJECT_GITHUB_LINK_PATH,
  PROJECT_PIN_PATH,
  PROJECT_REGISTER_PATH,
  PROJECT_REMOVE_PATH,
  PROJECT_RENAME_PATH,
  PROJECTS_REFRESH_PATH,
  type RegisterProjectResponse,
  SCAN_ROOTS_ADD_PATH,
  SCAN_ROOTS_LIST_PATH,
  SCAN_ROOTS_REMOVE_PATH,
  SCAN_ROOTS_RESCAN_PATH,
  type ScanStateResponse,
  SUGGESTION_DISMISS_PATH,
  SUGGESTION_REGISTER_PATH,
  SUGGESTIONS_PAGE_PATH,
  SYSTEM_SETTINGS_OPEN_PATH,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  addScanRoot,
  detectLaunchers,
  dismissSuggestion,
  getLauncherConfigs,
  listScanState,
  listSuggestionsPage,
  markLauncherTested,
  openSystemSettings,
  ProjectsRequestError,
  pinProject,
  refreshProjects,
  registerProject,
  registerSuggestion,
  removeProject,
  removeScanRoot,
  renameProject,
  requestLaunch,
  rescanScanRoot,
  saveLauncherConfig,
  setGithubLink,
  testLauncher,
} from "./projects-api.js";
import type { SocketApiClient, SocketRequestOptions } from "./socket-api-client.js";

/**
 * Typed client helpers for every Phase 4 route (Task 2, SC-3, PR-13).
 *
 * `fakeClient` is the exact double `socket-api-client.test.ts` uses for its
 * two vault-setup wrappers: what path a helper posts to, what body it sends,
 * and how it turns a status/body pair into a value or a
 * {@link ProjectsRequestError} — never the real transport, which is already
 * covered by the round-trip tracer and the service's own route suite.
 */

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
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

const PROJECT_ID = newProjectId();
const SCAN_ROOT_ID = newScanRootId();
const OK = { ok: true } as const;
const REGISTERED: RegisterProjectResponse = { kind: "registered", projectId: PROJECT_ID };
const SCAN_STATE: ScanStateResponse = { scanRoots: [], suggestions: [], partial: false };
const DETECTION: DetectionResponse = {
  detectedAt: "2026-09-28T00:00:00Z",
  apps: {
    antigravity: [],
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
const LAUNCHER_CONFIGS: LauncherConfigView = {
  antigravity: null,
  "claude-code": null,
  "claude-desktop": null,
};

describe("registerProject", () => {
  it("posts { path } to the register path and returns the parsed outcome", async () => {
    const { client, requests } = fakeClient({ status: 200, body: REGISTERED });
    const result = await registerProject(client, "/Users/USERNAME/code/example");
    expect(requests).toEqual([
      {
        method: "POST",
        path: PROJECT_REGISTER_PATH,
        body: { path: "/Users/USERNAME/code/example" },
      },
    ]);
    expect(result).toEqual(REGISTERED);
  });
});

describe("removeProject", () => {
  it("posts { projectId } to the remove path and returns { ok: true }", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    const result = await removeProject(client, { projectId: PROJECT_ID });
    expect(requests).toEqual([
      { method: "POST", path: PROJECT_REMOVE_PATH, body: { projectId: PROJECT_ID } },
    ]);
    expect(result).toEqual(OK);
  });
});

describe("renameProject", () => {
  it("posts { projectId, displayName } to the rename path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    await renameProject(client, { projectId: PROJECT_ID, displayName: "New name" });
    expect(requests).toEqual([
      {
        method: "POST",
        path: PROJECT_RENAME_PATH,
        body: { projectId: PROJECT_ID, displayName: "New name" },
      },
    ]);
  });
});

describe("pinProject", () => {
  it("posts { projectId, pinned } to the pin path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    await pinProject(client, { projectId: PROJECT_ID, pinned: true });
    expect(requests).toEqual([
      { method: "POST", path: PROJECT_PIN_PATH, body: { projectId: PROJECT_ID, pinned: true } },
    ]);
  });
});

describe("setGithubLink", () => {
  it("posts { projectId, url } to the github-link path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    await setGithubLink(client, {
      projectId: PROJECT_ID,
      url: "https://github.com/owner/repo",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: PROJECT_GITHUB_LINK_PATH,
        body: { projectId: PROJECT_ID, url: "https://github.com/owner/repo" },
      },
    ]);
  });
});

describe("refreshProjects", () => {
  it("posts {} for a full refresh", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    await refreshProjects(client);
    expect(requests).toEqual([{ method: "POST", path: PROJECTS_REFRESH_PATH, body: {} }]);
  });

  it("posts { projectId } for a single-project refresh", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    await refreshProjects(client, PROJECT_ID);
    expect(requests).toEqual([
      { method: "POST", path: PROJECTS_REFRESH_PATH, body: { projectId: PROJECT_ID } },
    ]);
  });
});

describe("requestLaunch", () => {
  it("sends exactly the project-targeted body and never a path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    const request: LaunchRequest = { action: "finder", projectId: PROJECT_ID };
    const result = await requestLaunch(client, request);
    expect(requests).toEqual([{ method: "POST", path: LAUNCH_PATH, body: request }]);
    expect(result).toEqual(OK);
  });

  it("sends { action: 'claude-desktop' } with no projectId", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    const request: LaunchRequest = { action: "claude-desktop" };
    await requestLaunch(client, request);
    expect(requests).toEqual([{ method: "POST", path: LAUNCH_PATH, body: request }]);
  });

  it("returns the parsed LaunchResult for an { ok: false, error } outcome", async () => {
    const failure = { ok: false, error: "app-not-found" } as const;
    const { client } = fakeClient({ status: 200, body: failure });
    const result = await requestLaunch(client, { action: "finder", projectId: PROJECT_ID });
    expect(result).toEqual(failure);
  });
});

describe("detectLaunchers", () => {
  it("posts {} to the detect path and returns the detection response", async () => {
    const { client, requests } = fakeClient({ status: 200, body: DETECTION });
    const result = await detectLaunchers(client);
    expect(requests).toEqual([{ method: "POST", path: LAUNCHERS_DETECT_PATH, body: {} }]);
    expect(result).toEqual(DETECTION);
  });
});

describe("getLauncherConfigs", () => {
  it("posts {} to the get path and returns the saved configuration view", async () => {
    const { client, requests } = fakeClient({ status: 200, body: LAUNCHER_CONFIGS });
    const result = await getLauncherConfigs(client);
    expect(requests).toEqual([{ method: "POST", path: LAUNCHERS_GET_PATH, body: {} }]);
    expect(result).toEqual(LAUNCHER_CONFIGS);
  });
});

describe("saveLauncherConfig", () => {
  it("returns { ok: true } on 200", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    const request = { launcherId: "antigravity" as const, bundleId: "com.example.app" };
    const result = await saveLauncherConfig(client, request);
    expect(requests).toEqual([{ method: "POST", path: LAUNCHERS_SAVE_PATH, body: request }]);
    expect(result).toEqual({ ok: true });
  });

  it("returns { ok: false, reason, index } for a 422 refusal body", async () => {
    const refusal = { error: "launcher config refused", reason: "empty-argument", index: 2 };
    const { client } = fakeClient({ status: 422, body: refusal });
    const result = await saveLauncherConfig(client, {
      launcherId: "antigravity",
      bundleId: "com.example.app",
    });
    expect(result).toEqual({ ok: false, reason: "empty-argument", index: 2 });
  });

  it("passes through which Claude Code template a refusal is about", async () => {
    const refusal = {
      error: "launcher config refused",
      reason: "forbidden-flag",
      index: 1,
      template: "terminal",
    };
    const { client } = fakeClient({ status: 422, body: refusal });
    const result = await saveLauncherConfig(client, {
      launcherId: "claude-code",
      executable: { kind: "path", path: "/usr/local/bin/claude" },
      args: [],
      terminal: { kind: "custom", preset: "blank", argv: ["/usr/bin/open", "{script}"] },
    });
    expect(result).toEqual({ ok: false, reason: "forbidden-flag", index: 1, template: "terminal" });
  });

  it("throws ProjectsRequestError for any other failure", async () => {
    const { client } = fakeClient({ status: 401, body: { error: "authentication required" } });
    await expect(
      saveLauncherConfig(client, { launcherId: "antigravity", bundleId: "com.example.app" }),
    ).rejects.toBeInstanceOf(ProjectsRequestError);
  });
});

describe("testLauncher", () => {
  it("posts { launcherId } to the test path and returns the LaunchResult", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    const result = await testLauncher(client, "claude-code");
    expect(requests).toEqual([
      { method: "POST", path: LAUNCHERS_TEST_PATH, body: { launcherId: "claude-code" } },
    ]);
    expect(result).toEqual(OK);
  });
});

describe("markLauncherTested", () => {
  it("posts { launcherId } to the mark-tested path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    await markLauncherTested(client, "claude-code");
    expect(requests).toEqual([
      { method: "POST", path: LAUNCHERS_MARK_TESTED_PATH, body: { launcherId: "claude-code" } },
    ]);
  });
});

describe("openSystemSettings", () => {
  it("posts { pane } to the system-settings path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    await openSystemSettings(client, "automation");
    expect(requests).toEqual([
      { method: "POST", path: SYSTEM_SETTINGS_OPEN_PATH, body: { pane: "automation" } },
    ]);
  });
});

describe("addScanRoot", () => {
  it("posts the request body to the add path and returns the scan state", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SCAN_STATE });
    const request = { path: "/Users/USERNAME/code" };
    const result = await addScanRoot(client, request);
    expect(requests).toEqual([{ method: "POST", path: SCAN_ROOTS_ADD_PATH, body: request }]);
    expect(result).toEqual(SCAN_STATE);
  });
});

describe("removeScanRoot", () => {
  it("posts { scanRootId } to the remove path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SCAN_STATE });
    await removeScanRoot(client, { scanRootId: SCAN_ROOT_ID });
    expect(requests).toEqual([
      { method: "POST", path: SCAN_ROOTS_REMOVE_PATH, body: { scanRootId: SCAN_ROOT_ID } },
    ]);
  });
});

describe("rescanScanRoot", () => {
  it("posts { scanRootId } (and an optional depth) to the rescan path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SCAN_STATE });
    await rescanScanRoot(client, { scanRootId: SCAN_ROOT_ID, depth: 2 });
    expect(requests).toEqual([
      {
        method: "POST",
        path: SCAN_ROOTS_RESCAN_PATH,
        body: { scanRootId: SCAN_ROOT_ID, depth: 2 },
      },
    ]);
  });
});

describe("listScanState", () => {
  it("posts {} to the list path and returns scan roots plus suggestions", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SCAN_STATE });
    const result = await listScanState(client);
    expect(requests).toEqual([{ method: "POST", path: SCAN_ROOTS_LIST_PATH, body: {} }]);
    expect(result).toEqual(SCAN_STATE);
  });
});

describe("listSuggestionsPage (codex review 3b, finding 2)", () => {
  const cursor = { scanRootId: SCAN_ROOT_ID, scanGeneration: "gen1", afterSuggestionId: "abc123" };

  it("posts the scan generation and the last held suggestion, never an offset", async () => {
    const page = { kind: "page", suggestions: [], total: 0 } as const;
    const { client, requests } = fakeClient({ status: 200, body: page });
    expect(await listSuggestionsPage(client, cursor)).toEqual(page);
    expect(requests).toEqual([{ method: "POST", path: SUGGESTIONS_PAGE_PATH, body: cursor }]);
  });

  it("returns the service's reload answer for a stale cursor", async () => {
    const { client } = fakeClient({ status: 200, body: { kind: "reload" } });
    expect(await listSuggestionsPage(client, cursor)).toEqual({ kind: "reload" });
  });

  it("refuses an offset-shaped page body", async () => {
    const { client } = fakeClient({ status: 200, body: { suggestions: [], total: 0 } });
    await expect(listSuggestionsPage(client, cursor)).rejects.toBeInstanceOf(ProjectsRequestError);
  });
});

describe("registerSuggestion", () => {
  it("posts { suggestionId } to the suggestion-register path and returns a register outcome", async () => {
    const { client, requests } = fakeClient({ status: 200, body: REGISTERED });
    const suggestionId = "abc123";
    const result = await registerSuggestion(client, { suggestionId });
    expect(requests).toEqual([
      { method: "POST", path: SUGGESTION_REGISTER_PATH, body: { suggestionId } },
    ]);
    expect(result).toEqual(REGISTERED);
  });
});

describe("dismissSuggestion", () => {
  it("posts { suggestionId } to the suggestion-dismiss path", async () => {
    const { client, requests } = fakeClient({ status: 200, body: OK });
    const suggestionId = "abc123";
    await dismissSuggestion(client, { suggestionId });
    expect(requests).toEqual([
      { method: "POST", path: SUGGESTION_DISMISS_PATH, body: { suggestionId } },
    ]);
  });
});

describe("every helper's response validation", () => {
  it("refuses a 200 body that fails its response schema", async () => {
    const { client } = fakeClient({ status: 200, body: { not: "a valid response" } });
    await expect(registerProject(client, "/Users/USERNAME/code/example")).rejects.toBeInstanceOf(
      ProjectsRequestError,
    );
  });

  it("carries the service's constant refusal message on a non-200", async () => {
    const { client } = fakeClient({ status: 422, body: { error: "folder cannot be registered" } });
    await expect(registerProject(client, "/Users/USERNAME/code/example")).rejects.toMatchObject({
      name: "ProjectsRequestError",
      status: 422,
      message: "folder cannot be registered",
    });
  });
});

describe("no helper runs a timer", () => {
  it("the module never calls setTimeout (the 5s deadline lives in the plugin, plan 04-10)", async () => {
    const source = await readFile(new URL("./projects-api.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/setTimeout/);
  });
});
