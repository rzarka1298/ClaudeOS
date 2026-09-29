import type { ClaudeIntegrationStatus, SessionUsage } from "@ccc/domain";
import {
  CLAUDE_INTEGRATION_PATH,
  CLAUDE_SESSION_USAGE_PATH,
  CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
  CLAUDE_USAGE_DELETE_PATH,
  SESSION_ASSOCIATE_PATH,
  SESSION_BRANCH_PATH,
  SESSION_FOCUS_PATH,
  SESSION_OPEN_TRANSCRIPT_PATH,
  SESSION_RESUME_PATH,
  SESSION_TERMINATE_REQUEST_PATH,
  SESSION_WORKTREES_PATH,
} from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeRequestError,
  deleteUsageAnalytics,
  getClaudeIntegration,
  getSessionUsage,
  requestSessionAction,
  setTranscriptAnalysis,
} from "./claude-client.js";
import type { SocketApiClient, SocketRequestOptions, SocketResponse } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * Task 1 (tracer): the settings tab reads Claude integration status and
 * flips transcript analysis through the service.
 *
 * These tests use a fake `SocketApiClient` rather than a real socket server
 * -- the transport itself is proven by `socket-api-client.test.ts`; what
 * this file proves is `claude-client.ts`'s own mapping from a response (or a
 * transport failure) to a typed value or a fixed {@link ClaudeRequestError}
 * code.
 */

function fakeClient(
  handler: (opts: SocketRequestOptions) => SocketResponse<unknown>,
): SocketApiClient {
  return {
    request: <T>(opts: SocketRequestOptions) => Promise.resolve(handler(opts) as SocketResponse<T>),
  };
}

function fakeErrorClient(error: unknown): SocketApiClient {
  return {
    request: () => Promise.reject(error),
  };
}

const VALID_STATUS: ClaudeIntegrationStatus = {
  hooks: "installed",
  hookRuntimeMissing: false,
  disableAllHooks: false,
  lastEventAt: null,
  telemetry: { kind: "ok" },
  detectedClaudeVersion: null,
  statusLine: "installed",
  statusLineReported: true,
  transcriptAnalysis: { enabled: false },
  spoolDropCount: 0,
  unknownEventCount: 0,
  cleanupPeriodDays: 30,
};

function timeoutError(): SocketUnreachableError {
  const cause = Object.assign(new Error("request timed out"), {
    code: "ETIMEDOUT",
  }) as NodeJS.ErrnoException;
  return new SocketUnreachableError("/tmp/ccc.sock", cause);
}

function connectionRefusedError(): SocketUnreachableError {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  }) as NodeJS.ErrnoException;
  return new SocketUnreachableError("/tmp/ccc.sock", cause);
}

describe("getClaudeIntegration (Test 1)", () => {
  it("returns the parsed status for a 200", async () => {
    const client = fakeClient((opts) => {
      expect(opts.method).toBe("GET");
      expect(opts.path).toBe(CLAUDE_INTEGRATION_PATH);
      return { status: 200, body: VALID_STATUS };
    });

    await expect(getClaudeIntegration(client)).resolves.toEqual(VALID_STATUS);
  });

  it("maps a SocketUnreachableError to service-disconnected", async () => {
    const client = fakeErrorClient(connectionRefusedError());

    const failure = await getClaudeIntegration(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("service-disconnected");
  });

  it("maps a timeout to the timeout code", async () => {
    const client = fakeErrorClient(timeoutError());

    const failure = await getClaudeIntegration(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("timeout");
  });

  it("maps a 200 body failing the schema to unrecognised-response", async () => {
    const client = fakeClient(() => ({ status: 200, body: { nonsense: true } }));

    const failure = await getClaudeIntegration(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("unrecognised-response");
  });
});

describe("setTranscriptAnalysis (Test 2)", () => {
  it("POSTs { enabled } to CLAUDE_TRANSCRIPT_ANALYSIS_PATH and returns the parsed body", async () => {
    const client = fakeClient((opts) => {
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe(CLAUDE_TRANSCRIPT_ANALYSIS_PATH);
      expect(opts.body).toEqual({ enabled: true });
      return { status: 200, body: { enabled: true } };
    });

    await expect(setTranscriptAnalysis(client, true)).resolves.toEqual({ enabled: true });
  });
});

/**
 * Task 2: the rest of the Claude client -- session actions, per-session
 * usage, deletion. A valid 25-char RunId (`RUN_ID_PATTERN`, `session.ts`).
 */
const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c0d1";

describe("requestSessionAction (Test 1)", () => {
  it("POSTs focus to SESSION_FOCUS_PATH and returns the parsed FocusResponse", async () => {
    const client = fakeClient((opts) => {
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe(SESSION_FOCUS_PATH);
      expect(opts.body).toEqual({ runId: RUN_ID });
      return { status: 200, body: { outcome: "focused" } };
    });

    await expect(requestSessionAction(client, "focus", { runId: RUN_ID })).resolves.toEqual({
      outcome: "focused",
    });
  });

  it("maps a 409 { error: 'process-ended' } to ClaudeRequestError code process-ended", async () => {
    const client = fakeClient(() => ({ status: 409, body: { error: "process-ended" } }));

    const failure = await requestSessionAction(client, "focus", { runId: RUN_ID }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("process-ended");
  });

  it("maps a body with an unknown code to unrecognised-response", async () => {
    const client = fakeClient(() => ({ status: 409, body: { error: "not-a-real-code" } }));

    const failure = await requestSessionAction(client, "focus", { runId: RUN_ID }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("unrecognised-response");
  });
});

describe("requestSessionAction (Test 2)", () => {
  it("resume returns a launched outcome as parsed", async () => {
    const client = fakeClient((opts) => {
      expect(opts.path).toBe(SESSION_RESUME_PATH);
      return { status: 200, body: { outcome: "launched" } };
    });

    await expect(requestSessionAction(client, "resume", { runId: RUN_ID })).resolves.toEqual({
      outcome: "launched",
    });
  });

  it("branch returns a conflict outcome as parsed", async () => {
    const conflict = {
      outcome: "conflict" as const,
      projectName: "alpha",
      conflicts: [
        { runId: RUN_ID, sessionName: "Refactor parser", state: "running", lastActivityAt: null },
      ],
    };
    const client = fakeClient((opts) => {
      expect(opts.path).toBe(SESSION_BRANCH_PATH);
      return { status: 200, body: conflict };
    });

    await expect(requestSessionAction(client, "branch", { runId: RUN_ID })).resolves.toEqual(
      conflict,
    );
  });

  it("worktrees returns the parsed worktree list", async () => {
    const worktrees = { worktrees: [{ worktreeId: "wt1", branch: "main", folderBasename: "repo" }] };
    const client = fakeClient((opts) => {
      expect(opts.path).toBe(SESSION_WORKTREES_PATH);
      return { status: 200, body: worktrees };
    });

    await expect(requestSessionAction(client, "worktrees", { runId: RUN_ID })).resolves.toEqual(
      worktrees,
    );
  });

  it("open-transcript, associate and terminate-request parse their responses", async () => {
    const openTranscriptClient = fakeClient((opts) => {
      expect(opts.path).toBe(SESSION_OPEN_TRANSCRIPT_PATH);
      return { status: 200, body: { ok: true } };
    });
    await expect(
      requestSessionAction(openTranscriptClient, "open-transcript", {
        runId: RUN_ID,
        mode: "reveal",
      }),
    ).resolves.toEqual({ ok: true });

    const associateClient = fakeClient((opts) => {
      expect(opts.path).toBe(SESSION_ASSOCIATE_PATH);
      return { status: 200, body: {} };
    });
    await expect(
      requestSessionAction(associateClient, "associate", { runId: RUN_ID, projectId: "proj-1" }),
    ).resolves.toEqual({});

    const terminateClient = fakeClient((opts) => {
      expect(opts.path).toBe(SESSION_TERMINATE_REQUEST_PATH);
      return { status: 200, body: { outcome: "proposed", proposalId: "prop-1" } };
    });
    await expect(
      requestSessionAction(terminateClient, "terminate-request", { runId: RUN_ID }),
    ).resolves.toEqual({ outcome: "proposed", proposalId: "prop-1" });
  });
});

describe("requestSessionAction (Test 3)", () => {
  it("sends exactly the strict schema's shape -- no extra keys, no path fields", async () => {
    const client = fakeClient((opts) => {
      expect(opts.body).toEqual({ runId: RUN_ID, choice: { kind: "continue" } });
      return { status: 200, body: { outcome: "launched" } };
    });

    await requestSessionAction(client, "resume", {
      runId: RUN_ID,
      choice: { kind: "continue" },
    });
  });

  it("rejects a body carrying an unknown key (e.g. a smuggled path) before ever reaching the wire", async () => {
    const client = fakeClient(() => {
      throw new Error("must not be called: the strict schema should reject first");
    });
    const smuggled = { runId: RUN_ID, path: "/etc/passwd" } as unknown as { runId: string };

    await expect(requestSessionAction(client, "focus", smuggled)).rejects.toThrow();
  });
});

describe("getSessionUsage and deleteUsageAnalytics (Test 4)", () => {
  it("getSessionUsage returns the parsed SessionUsage", async () => {
    const usage: SessionUsage = {
      runId: RUN_ID,
      activity: { kind: "unavailable" },
      cost: { kind: "unavailable" },
    };
    const client = fakeClient((opts) => {
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe(CLAUDE_SESSION_USAGE_PATH);
      expect(opts.body).toEqual({ runId: RUN_ID });
      return { status: 200, body: usage };
    });

    await expect(getSessionUsage(client, RUN_ID)).resolves.toEqual(usage);
  });

  it("deleteUsageAnalytics POSTs to CLAUDE_USAGE_DELETE_PATH and resolves on 200", async () => {
    const client = fakeClient((opts) => {
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe(CLAUDE_USAGE_DELETE_PATH);
      return { status: 200, body: {} };
    });

    await expect(deleteUsageAnalytics(client)).resolves.toBeUndefined();
  });
});

describe("requestSessionAction (Test 5)", () => {
  it("a hung fake client rejects with the timeout code, advanced via fake timers rather than a real 5s wait", async () => {
    vi.useFakeTimers();
    try {
      const hungClient: SocketApiClient = {
        request: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(timeoutError()), 5000);
          }),
      };

      const settled = requestSessionAction(hungClient, "focus", { runId: RUN_ID }).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(5000);
      const failure = await settled;

      expect(failure).toBeInstanceOf(ClaudeRequestError);
      expect((failure as ClaudeRequestError).code).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
