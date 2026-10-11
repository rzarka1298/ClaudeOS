import { readFileSync } from "node:fs";
import type {
  CodexDoctorSummary,
  CodexIntegrationStatus,
  CodexSessionsSnapshot,
  CodexTokenSummary,
  CodexUsageSnapshot,
  HeadroomSignal,
  LaunchPairResponse,
} from "@ccc/domain";
import {
  CODEX_DOCTOR_CLIENT_TIMEOUT_MS,
  CODEX_DOCTOR_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_USAGE_PATH,
  LAUNCH_PAIR_PATH,
  ProjectIdSchema,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import * as codexClient from "./codex-client.js";
import {
  CodexRequestError,
  followCodexLog,
  getCodexHeadroom,
  getCodexIntegration,
  getCodexSessions,
  getCodexTokenSummary,
  getCodexUsage,
  launchPair,
  openCodexTranscript,
  runCodexDoctor,
} from "./codex-client.js";
import * as clientIndex from "./index.js";
import type { SocketApiClient, SocketRequestOptions, SocketResponse } from "./socket-api-client.js";
import { SocketUnreachableError, VaultSetupRequestError } from "./socket-api-client.js";

/**
 * Plan 05.1-06: the Codex client maps a response (or a transport failure) to
 * a typed value or a fixed CodexRequestError code. A fake SocketApiClient is
 * used, as claude-client.test.ts does; the transport has its own tests.
 */

function fakeClient(
  handler: (opts: SocketRequestOptions) => SocketResponse<unknown>,
): SocketApiClient {
  return {
    request: <T>(opts: SocketRequestOptions) => Promise.resolve(handler(opts) as SocketResponse<T>),
  };
}

function fakeErrorClient(error: unknown): SocketApiClient {
  return { request: () => Promise.reject(error) };
}

function unreachable(code: string): SocketUnreachableError {
  const cause = Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
  return new SocketUnreachableError("/tmp/ccc.sock", cause);
}

const NOW = "2026-10-10T12:00:00.000Z";

const VALID_SIGNAL: HeadroomSignal = {
  generatedAt: NOW,
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10080, usedPercent: 41, resetsAt: "2026-10-14T00:00:00.000Z" },
    source: "app-server",
    observedAt: NOW,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
  claude: {
    kind: "available",
    window: "five-hour",
    usedPercent: 62,
    resetsAt: "2026-10-10T16:40:00.000Z",
    source: "claude-code-status-line",
    observedAt: NOW,
    freshness: "cached",
  },
};

async function failureOf(promise: Promise<unknown>): Promise<CodexRequestError> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CodexRequestError);
  return failure as CodexRequestError;
}

describe("transport rejections that are not unreachable (Codex review wave 3 MINOR)", () => {
  it("a malformed-JSON or oversized response (VaultSetupRequestError) becomes CodexRequestError unrecognised-response with the transport status", async () => {
    const failure = await failureOf(
      getCodexHeadroom(
        fakeErrorClient(
          new VaultSetupRequestError(
            200,
            "The service returned a response this client does not recognise.",
          ),
        ),
      ),
    );
    expect(failure).toBeInstanceOf(CodexRequestError);
    expect(failure.code).toBe("unrecognised-response");
    expect(failure.status).toBe(200);
    expect(failure.message).toBe("unrecognised-response");
  });
});

describe("getCodexHeadroom (tracer, CODEX-11, CODEX-12)", () => {
  it("Test 1: sends GET to the headroom path with no body and returns the parsed signal", async () => {
    let seen: SocketRequestOptions | undefined;
    const client = fakeClient((opts) => {
      seen = opts;
      return { status: 200, body: VALID_SIGNAL };
    });
    await expect(getCodexHeadroom(client)).resolves.toEqual(VALID_SIGNAL);
    expect(seen?.method).toBe("GET");
    expect(seen?.path).toBe(CODEX_HEADROOM_PATH);
    expect(seen?.body).toBeUndefined();
  });

  it("Test 2: a 200 body that fails the schema (a recommendedAgent key) is unrecognised-response", async () => {
    const client = fakeClient(() => ({
      status: 200,
      body: { ...VALID_SIGNAL, recommendedAgent: "codex" },
    }));
    const failure = await failureOf(getCodexHeadroom(client));
    expect(failure.code).toBe("unrecognised-response");
    expect(failure.status).toBe(200);
  });

  it("Test 3: a 503 { error: unavailable } carries status 503 and the fixed code", async () => {
    const client = fakeClient(() => ({ status: 503, body: { error: "unavailable" } }));
    const failure = await failureOf(getCodexHeadroom(client));
    expect(failure.status).toBe(503);
    expect(failure.code).toBe("unavailable");
  });

  it("Test 3: a 500 with free text is unrecognised-response and never surfaces that text", async () => {
    const secret = "stack trace at /Users/USERNAME/repo/secret.ts";
    const client = fakeClient(() => ({ status: 500, body: { error: secret } }));
    const failure = await failureOf(getCodexHeadroom(client));
    expect(failure.code).toBe("unrecognised-response");
    expect(failure.message).not.toContain("USERNAME");
    expect(failure.message).not.toContain("trace");
    expect(JSON.stringify(failure)).not.toContain("USERNAME");
  });

  it("Test 4: ETIMEDOUT maps to timeout and any other errno to service-disconnected", async () => {
    expect(
      (await failureOf(getCodexHeadroom(fakeErrorClient(unreachable("ETIMEDOUT"))))).code,
    ).toBe("timeout");
    expect(
      (await failureOf(getCodexHeadroom(fakeErrorClient(unreachable("ECONNREFUSED"))))).code,
    ).toBe("service-disconnected");
  });

  it("Test 5: the module has no function that posts to the headroom route", () => {
    const names = Object.keys(codexClient).filter((name) => /headroom/i.test(name));
    expect(names).toEqual(["getCodexHeadroom"]);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the remaining routes

const SESSIONS: CodexSessionsSnapshot = {
  kind: "available",
  sessions: [
    {
      threadId: "thread-1",
      projectId: null,
      projectName: null,
      origin: "interactive",
      state: "running",
      model: "gpt-5.4",
      effort: "high",
      startedAt: NOW,
      lastActivityAt: NOW,
      resumesAfter: null,
      title: null,
      hasTranscript: true,
      liveLogRunId: null,
    },
  ],
  hiddenCount: 0,
  analysisOn: false,
  observedAt: NOW,
  freshness: "live",
  partiality: { partial: false },
};

const USAGE: CodexUsageSnapshot = {
  kind: "available",
  windows: [{ windowMinutes: 10080, usedPercent: 41, resetsAt: NOW, limitLabel: null }],
  ordinaryUsageAllowed: true,
  rateLimitReached: false,
  rateLimitReachedType: null,
  source: "app-server",
  observedAt: NOW,
  freshness: "live",
};

const INTEGRATION: CodexIntegrationStatus = {
  hooks: { state: "installed", lastEventAt: NOW, installedSince: NOW },
  bridge: { state: "installed", lastWindowAt: NOW },
  codex: { installed: true, version: "0.159.2" },
  doctor: null,
};

const DOCTOR: CodexDoctorSummary = {
  overall: "ok",
  codexVersion: "0.159.2",
  checks: [{ id: "auth.file", category: "auth", status: "ok" }],
};

const TOKENS: CodexTokenSummary = {
  ranges: {
    today: { kind: "unavailable", reason: "analysis-off", version: null },
    "last-7-days": { kind: "unavailable", reason: "analysis-off", version: null },
    "this-month": { kind: "unavailable", reason: "analysis-off", version: null },
  },
  firstScanPending: false,
  observedAt: NOW,
};

const PAIR_ENVELOPE: LaunchPairResponse = {
  claude: { status: "opened" },
  codex: { status: "error", error: "bridge-not-installed" },
};

const RUN_ID = "20261006T120000123Z";
const PROJECT_ID = ProjectIdSchema.parse("a1b2c3d4e0123456789abcdef");

function recording(status: number, body: unknown) {
  const calls: SocketRequestOptions[] = [];
  const client = fakeClient((opts) => {
    calls.push(opts);
    return { status, body };
  });
  return { calls, client };
}

describe("the GET read routes (Test 1, Test 2)", () => {
  const cases: ReadonlyArray<
    readonly [string, string, (c: SocketApiClient) => Promise<unknown>, unknown]
  > = [
    ["sessions", CODEX_SESSIONS_PATH, getCodexSessions, SESSIONS],
    ["usage", CODEX_USAGE_PATH, getCodexUsage, USAGE],
    ["integration", CODEX_INTEGRATION_PATH, getCodexIntegration, INTEGRATION],
    ["token activity", CODEX_TOKEN_ACTIVITY_PATH, getCodexTokenSummary, TOKENS],
  ];

  for (const [name, path, call, value] of cases) {
    it(`${name}: GET with no body, parses the matching domain schema, a malformed 200 is unrecognised-response`, async () => {
      const ok = recording(200, value);
      await expect(call(ok.client)).resolves.toEqual(value);
      expect(ok.calls).toHaveLength(1);
      expect(ok.calls[0]?.method).toBe("GET");
      expect(ok.calls[0]?.path).toBe(path);
      expect(ok.calls[0]?.body).toBeUndefined();

      const bad = recording(200, { ...(value as object), extra: 1 });
      expect((await failureOf(call(bad.client))).code).toBe("unrecognised-response");
    });
  }

  it("Test 2: a token summary missing a range, or with a range under the wrong key, is unrecognised-response", async () => {
    const { "this-month": _dropped, ...missing } = TOKENS.ranges;
    expect(
      (await failureOf(getCodexTokenSummary(recording(200, { ...TOKENS, ranges: missing }).client)))
        .code,
    ).toBe("unrecognised-response");
    const wrongKey = {
      ...TOKENS,
      ranges: { ...TOKENS.ranges, today: { ...TOKENS.ranges["this-month"], kind: "available" } },
    };
    expect((await failureOf(getCodexTokenSummary(recording(200, wrongKey).client))).code).toBe(
      "unrecognised-response",
    );
  });
});

describe("openCodexTranscript and followCodexLog (Test 3, T-05.1-10)", () => {
  it("open transcript posts { threadId, via } and returns the constant ok", async () => {
    const { calls, client } = recording(200, { ok: true });
    await expect(
      openCodexTranscript(client, { threadId: "thread-1", via: "reveal" }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(CODEX_OPEN_TRANSCRIPT_PATH);
    expect(calls[0]?.body).toEqual({ threadId: "thread-1", via: "reveal" });
  });

  it("a smuggled path, rolloutPath or file throws locally and the request is never made", async () => {
    for (const key of ["path", "rolloutPath", "file"]) {
      const { calls, client } = recording(200, { ok: true });
      const request = { threadId: "thread-1", via: "open", [key]: "/Users/USERNAME/x.jsonl" };
      await expect(openCodexTranscript(client, request as never)).rejects.toThrow();
      expect(calls, key).toHaveLength(0);
    }
  });

  it("follow log posts { runId } for a wrapper run id and refuses anything else locally", async () => {
    const { calls, client } = recording(200, { ok: true });
    await expect(followCodexLog(client, { runId: RUN_ID })).resolves.toEqual({ ok: true });
    expect(calls[0]?.path).toBe(CODEX_FOLLOW_LOG_PATH);
    expect(calls[0]?.body).toEqual({ runId: RUN_ID });

    const refused = recording(200, { ok: true });
    await expect(followCodexLog(refused.client, { runId: "../x" })).rejects.toThrow();
    await expect(
      followCodexLog(refused.client, { runId: RUN_ID, path: "x" } as never),
    ).rejects.toThrow();
    expect(refused.calls).toHaveLength(0);
  });

  it("a 200 that is not the constant ok is unrecognised-response", async () => {
    const { client } = recording(200, { ok: true, path: "/Users/USERNAME/x" });
    expect(
      (await failureOf(openCodexTranscript(client, { threadId: "thread-1", via: "open" }))).code,
    ).toBe("unrecognised-response");
  });
});

describe("runCodexDoctor (Test 4)", () => {
  it("posts the strict empty body with a 70 second deadline and returns the doctor summary", async () => {
    const { calls, client } = recording(200, DOCTOR);
    await expect(runCodexDoctor(client)).resolves.toEqual(DOCTOR);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(CODEX_DOCTOR_PATH);
    expect(calls[0]?.body).toEqual({});
    expect(calls[0]?.timeoutMs).toBe(CODEX_DOCTOR_CLIENT_TIMEOUT_MS);
    expect(CODEX_DOCTOR_CLIENT_TIMEOUT_MS).toBe(70_000);
  });

  it("a doctor summary carrying details is unrecognised-response", async () => {
    const withDetails = {
      ...DOCTOR,
      checks: [{ id: "auth.file", category: "auth", status: "ok", details: "/Users/USERNAME/x" }],
    };
    expect((await failureOf(runCodexDoctor(recording(200, withDetails).client))).code).toBe(
      "unrecognised-response",
    );
  });
});

describe("launchPair (Test 5, CODEX-02)", () => {
  it("posts the strict pair request to the pair path with a 4500 ms deadline and parses the envelope", async () => {
    const { calls, client } = recording(200, PAIR_ENVELOPE);
    await expect(launchPair(client, { projectId: PROJECT_ID })).resolves.toEqual(PAIR_ENVELOPE);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(LAUNCH_PAIR_PATH);
    expect(calls[0]?.body).toEqual({ projectId: PROJECT_ID });
    expect(calls[0]?.timeoutMs).toBe(CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS);
    expect(CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS).toBe(4_500);
  });

  it("parses the guard-conflict answer too", async () => {
    const conflict = {
      ok: false,
      conflict: {
        projectName: "demo",
        conflicts: [
          {
            runId: "r".repeat(25),
            sessionName: "demo run",
            state: "running",
            lastActivityAt: NOW,
          },
        ],
      },
    };
    const { client } = recording(200, conflict);
    const result = await launchPair(client, { projectId: PROJECT_ID });
    expect(result).toEqual(conflict);
  });

  it("an extra key such as argv throws before the request is made", async () => {
    const { calls, client } = recording(200, PAIR_ENVELOPE);
    await expect(
      launchPair(client, { projectId: PROJECT_ID, argv: ["codex"] } as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("a pair answer carrying an extra agent key is unrecognised-response", async () => {
    const { client } = recording(200, { ...PAIR_ENVELOPE, gemini: { status: "opened" } });
    expect((await failureOf(launchPair(client, { projectId: PROJECT_ID }))).code).toBe(
      "unrecognised-response",
    );
  });
});

describe("fixed codes and the absence of mutating functions (Test 6, CODEX-12, D-04, D-05)", () => {
  it("every non-200 maps to a fixed vocabulary code, and free text is never surfaced", async () => {
    const codes = [
      "invalid-request",
      "not-found",
      "outside-sessions-folder",
      "run-ended",
      "bridge-not-installed",
      "bridge-outdated",
      "window-not-ready",
      "unavailable",
      "failed",
    ];
    for (const code of codes) {
      const { client } = recording(409, { error: code });
      const failure = await failureOf(
        openCodexTranscript(client, { threadId: "thread-1", via: "open" }),
      );
      expect(failure.code).toBe(code);
      expect(failure.status).toBe(409);
    }
    const { client } = recording(500, { error: "boom at /Users/USERNAME/repo" });
    const failure = await failureOf(runCodexDoctor(client));
    expect(failure.code).toBe("unrecognised-response");
    expect(failure.message).not.toContain("USERNAME");
  });

  it("exports exactly the nine read and action wrappers and the error class", () => {
    expect(Object.keys(codexClient).sort()).toEqual(
      [
        "CodexRequestError",
        "followCodexLog",
        "getCodexHeadroom",
        "getCodexIntegration",
        "getCodexSessions",
        "getCodexTokenSummary",
        "getCodexUsage",
        "launchPair",
        "openCodexTranscript",
        "runCodexDoctor",
      ].sort(),
    );
  });

  it("the source never posts to the headroom or usage paths and names no dispatch, credit or config writer", () => {
    const source = readFileSync(new URL("./codex-client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/"POST"\s*,\s*CODEX_(HEADROOM|USAGE)_PATH/);
    expect(source).not.toMatch(/\b(dispatch|consume|reset-?credit|writeConfig|config\.toml)/i);
    expect(source).not.toContain("CODEX_HOOK_EVENTS_PATH");
  });
});

describe("the service-api-client barrel (Task 3, Test 5)", () => {
  it("exports the Codex client functions and CodexRequestError, and no Claude export went missing", () => {
    for (const name of Object.keys(codexClient)) {
      expect(Object.keys(clientIndex), name).toContain(name);
    }
    expect(Object.keys(clientIndex)).toEqual(
      expect.arrayContaining([
        "CODEX_DOCTOR_CLIENT_TIMEOUT_MS",
        "CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS",
        "ClaudeRequestError",
        "deleteUsageAnalytics",
        "getClaudeIntegration",
        "getSessionUsage",
        "requestSessionAction",
        "setTranscriptAnalysis",
      ]),
    );
  });
});
