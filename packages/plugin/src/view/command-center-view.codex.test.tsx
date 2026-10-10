import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_FOLLOW_LOG_PATH, CODEX_OPEN_TRANSCRIPT_PATH } from "@ccc/domain/codex-api.js";
import type {
  AuthenticatedSocketApiClient,
  EventClient,
  SocketRequestOptions,
} from "@ccc/service-api-client";
import { act, cleanup, render } from "@testing-library/preact";
import type { WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings.js";
import { type StubLeaf, Scope as StubScope } from "../test-support/obsidian-stub.js";
import { CommandCenterView } from "./command-center-view.js";
import type { SessionActionHost } from "./session-action-runner.js";

/**
 * Plan 05.1-19 task 2: the view host is the ONLY place the Codex client calls
 * and the Codex modal openers are bound (UI-SPEC non-negotiable 7, T-05.1-18).
 * The shell is replaced with a probe that captures the `sessionActions` prop
 * the view builds, so the binding is proven without rendering the dashboard.
 */

const captured = vi.hoisted(() => ({ sessionActions: undefined as unknown }));

vi.mock("./shell.js", () => ({
  Shell: (props: { sessionActions?: unknown }) => {
    captured.sessionActions = props.sessionActions;
    return null;
  },
}));

const THREAD_ID = "thread-0123abcd";
const WRAPPER_RUN_ID = "20261006T120000123Z";

interface Recorded {
  readonly method: string | undefined;
  readonly path: string;
  readonly body: unknown;
}

function recordingClient(requests: Recorded[]): AuthenticatedSocketApiClient {
  return {
    request<T>(opts: SocketRequestOptions): Promise<{ status: number; body: T }> {
      requests.push({ method: opts.method, path: opts.path, body: opts.body });
      return Promise.resolve({ status: 200, body: { ok: true } as T });
    },
    invalidateToken: () => {},
  };
}

function stubLeaf(): StubLeaf {
  const { container } = render(<div />);
  const contentEl = container.firstElementChild as HTMLElement;
  return {
    app: { scope: new StubScope() },
    contentEl: Object.assign(contentEl, { empty: () => contentEl.replaceChildren() }),
  };
}

async function openView(requests: Recorded[]): Promise<SessionActionHost> {
  const eventClient: EventClient = { subscribe: vi.fn(), dispose: vi.fn() };
  const view = new CommandCenterView(stubLeaf() as unknown as WorkspaceLeaf, {
    settings: { ...DEFAULT_SETTINGS, lastOpenedDestination: "overview" },
    client: recordingClient(requests),
    eventClient,
    saveSettings: () => Promise.resolve(),
    openSwitcher: vi.fn(),
    requestLaunch: vi.fn(),
  });
  await act(async () => {
    await view.onOpen();
  });
  return captured.sessionActions as SessionActionHost;
}

afterEach(() => {
  cleanup();
  captured.sessionActions = undefined;
});

describe("CommandCenterView binds the Codex session actions (plan 05.1-19 task 2)", () => {
  it("Test 5: openTranscript posts the thread id and via to the open-transcript route", async () => {
    const requests: Recorded[] = [];
    const host = await openView(requests);

    await host.codex?.openTranscript({ threadId: THREAD_ID, via: "reveal" });

    expect(requests).toEqual([
      {
        method: "POST",
        path: CODEX_OPEN_TRANSCRIPT_PATH,
        body: { threadId: THREAD_ID, via: "reveal" },
      },
    ]);
  });

  it("Test 5: followLog posts the wrapper run id to the follow-log route", async () => {
    const requests: Recorded[] = [];
    const host = await openView(requests);

    await host.codex?.followLog({ runId: WRAPPER_RUN_ID });

    expect(requests).toEqual([
      { method: "POST", path: CODEX_FOLLOW_LOG_PATH, body: { runId: WRAPPER_RUN_ID } },
    ]);
  });

  it("Test 5: the ui object keeps every existing session opener and gains the two Codex openers", async () => {
    const host = await openView([]);

    expect(typeof host.ui.notify).toBe("function");
    expect(typeof host.ui.openTranscriptWarning).toBe("function");
    expect(typeof host.ui.openTerminateRequest).toBe("function");
    expect(typeof host.ui.openCodexTranscriptWarning).toBe("function");
    expect(typeof host.ui.openCodexFollowWarning).toBe("function");
  });

  it("Test 5: a smuggled path is refused by the client before any request is made", async () => {
    const requests: Recorded[] = [];
    const host = await openView(requests);

    await expect(
      host.codex?.openTranscript({
        threadId: THREAD_ID,
        via: "reveal",
        path: "/Users/USERNAME/x",
      } as never),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});

describe("the Codex client is bound in the view host only (T-05.1-18)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const viewSource = readFileSync(join(here, "command-center-view.ts"), "utf8");

  it("Test 5: the view source binds both client calls and merges the Codex openers", () => {
    expect(viewSource).toMatch(/openCodexTranscript\(/);
    expect(viewSource).toMatch(/followCodexLog\(/);
    expect(viewSource).toMatch(/createObsidianCodexUi\(/);
  });

  it("Test 5: no widget and not the runner calls a Codex client function", () => {
    const widgetsDir = join(here, "..", "widgets");
    const files = readdirSync(widgetsDir)
      .filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes(".test."))
      .map((name) => join(widgetsDir, name));
    files.push(join(here, "session-action-runner.ts"), join(here, "codex-modals.ts"));
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\b(openCodexTranscript|followCodexLog)\s*\(/);
    }
  });
});
