import { describe, expect, it } from "vitest";
import { API_BASE } from "./api.js";
import * as sessionActions from "./session-actions.js";
import {
  AssociateRequestSchema,
  BranchRequestSchema,
  BranchResponseSchema,
  FocusResponseSchema,
  LAUNCH_PORT_FAILURE_ERROR_CODES,
  LaunchChoiceSchema,
  OpenTranscriptRequestSchema,
  ResumeRequestSchema,
  ResumeResponseSchema,
  SESSION_ACTION_ERROR_CODES,
  SessionActionErrorBodySchema,
  SessionActionRequestSchema,
  TerminateRequestResponseSchema,
  TranscriptAnalysisRequestSchema,
  WorktreeListResponseSchema,
} from "./session-actions.js";

const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c0d1";
const OTHER_RUN_ID = "0mfk1a2b3ffffffffffffffff";

const routeConstants = Object.entries(sessionActions).filter(([name]) => name.endsWith("_PATH"));

describe("route constants (Test 1, PATTERNS fact 1)", () => {
  it("declares all thirteen Phase 5 routes", () => {
    expect(routeConstants.map(([name]) => name).sort()).toEqual(
      [
        "CLAUDE_HOOK_EVENTS_PATH",
        "CLAUDE_STATUSLINE_PATH",
        "CLAUDE_INTEGRATION_PATH",
        "CLAUDE_TRANSCRIPT_ANALYSIS_PATH",
        "CLAUDE_USAGE_DELETE_PATH",
        "CLAUDE_SESSION_USAGE_PATH",
        "SESSION_FOCUS_PATH",
        "SESSION_RESUME_PATH",
        "SESSION_BRANCH_PATH",
        "SESSION_WORKTREES_PATH",
        "SESSION_OPEN_TRANSCRIPT_PATH",
        "SESSION_ASSOCIATE_PATH",
        "SESSION_TERMINATE_REQUEST_PATH",
      ].sort(),
    );
  });

  it.each(routeConstants)("%s lives under API_BASE with no ':param' segment", (_name, value) => {
    expect(typeof value).toBe("string");
    const route = value as string;
    expect(route.startsWith(`${API_BASE}/`)).toBe(true);
    expect(route.slice(API_BASE.length)).not.toContain(":");
  });

  it("gives every route a distinct path", () => {
    const values = routeConstants.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("pins the exact paths", () => {
    expect(sessionActions.CLAUDE_HOOK_EVENTS_PATH).toBe("/api/v1/claude/hook-events");
    expect(sessionActions.CLAUDE_SESSION_USAGE_PATH).toBe("/api/v1/claude/usage/session");
    expect(sessionActions.SESSION_FOCUS_PATH).toBe("/api/v1/sessions/focus");
    expect(sessionActions.SESSION_TERMINATE_REQUEST_PATH).toBe(
      "/api/v1/sessions/terminate-request",
    );
  });
});

describe("SessionActionRequestSchema (Test 2)", () => {
  it("accepts { runId }", () => {
    expect(SessionActionRequestSchema.safeParse({ runId: RUN_ID }).success).toBe(true);
  });

  it("is strict: an extra key fails", () => {
    expect(SessionActionRequestSchema.safeParse({ runId: RUN_ID, pid: 42 }).success).toBe(false);
  });

  it("rejects a runId that is not RunId-shaped", () => {
    for (const runId of ["", "../etc", "0F3C2A8E-5B1D", 42]) {
      expect(SessionActionRequestSchema.safeParse({ runId }).success).toBe(false);
    }
  });
});

describe("LaunchChoiceSchema (Test 3, T-05-03)", () => {
  it.each([
    [{ kind: "continue" }],
    [{ kind: "plan" }],
    [{ kind: "existing-worktree", worktreeId: "wt_3f9a" }],
    [{ kind: "new-worktree", name: "fix-parser" }],
    [{ kind: "new-worktree", name: "a.b_c-1" }],
    [{ kind: "new-worktree", name: "n".repeat(64) }],
  ])("accepts %j", (choice) => {
    expect(LaunchChoiceSchema.safeParse(choice).success).toBe(true);
  });

  it.each([["../x"], [""], ["n".repeat(65)], ["has space"], ["a/b"]])(
    "rejects the new-worktree name %j",
    (name) => {
      expect(LaunchChoiceSchema.safeParse({ kind: "new-worktree", name }).success).toBe(false);
    },
  );

  it("rejects an existing worktree addressed by path", () => {
    expect(
      LaunchChoiceSchema.safeParse({ kind: "existing-worktree", worktreeId: "/Users/USERNAME/wt" })
        .success,
    ).toBe(false);
    expect(
      LaunchChoiceSchema.safeParse({
        kind: "existing-worktree",
        worktreeId: "wt_1",
        path: "/Users/USERNAME/wt",
      }).success,
    ).toBe(false);
  });
});

describe("request bodies carry no path (T-05-03)", () => {
  it("accepts each request in its documented shape", () => {
    expect(ResumeRequestSchema.safeParse({ runId: RUN_ID }).success).toBe(true);
    expect(ResumeRequestSchema.safeParse({ runId: RUN_ID, choice: { kind: "plan" } }).success).toBe(
      true,
    );
    expect(
      BranchRequestSchema.safeParse({
        runId: RUN_ID,
        choice: { kind: "new-worktree", name: "fix-parser" },
      }).success,
    ).toBe(true);
    expect(OpenTranscriptRequestSchema.safeParse({ runId: RUN_ID, mode: "reveal" }).success).toBe(
      true,
    );
    expect(OpenTranscriptRequestSchema.safeParse({ runId: RUN_ID, mode: "delete" }).success).toBe(
      false,
    );
    expect(AssociateRequestSchema.safeParse({ runId: RUN_ID, projectId: "proj-1" }).success).toBe(
      true,
    );
    expect(TranscriptAnalysisRequestSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(TranscriptAnalysisRequestSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });

  it.each([
    ["ResumeRequestSchema", ResumeRequestSchema],
    ["BranchRequestSchema", BranchRequestSchema],
    ["OpenTranscriptRequestSchema", OpenTranscriptRequestSchema],
    ["AssociateRequestSchema", AssociateRequestSchema],
  ] as const)("%s refuses a smuggled path key", (_name, schema) => {
    const valid = {
      runId: RUN_ID,
      mode: "open",
      projectId: "proj-1",
    };
    const keys = Object.keys(schema.shape);
    const body = Object.fromEntries(
      Object.entries(valid).filter(([key]) => keys.includes(key)),
    ) as Record<string, unknown>;
    expect(schema.safeParse(body).success).toBe(true);
    for (const key of ["cwd", "path", "transcriptPath"]) {
      expect(keys).not.toContain(key);
      expect(schema.safeParse({ ...body, [key]: "/Users/USERNAME" }).success).toBe(false);
    }
  });
});

describe("responses and errors (Tests 4-5)", () => {
  const conflict = {
    runId: OTHER_RUN_ID,
    sessionName: "Session 0f3c2a8e",
    state: "running",
    lastActivityAt: "2026-09-26T13:05:00.000Z",
  };

  it("accepts a launched resume and a conflict resume", () => {
    expect(ResumeResponseSchema.safeParse({ outcome: "launched" }).success).toBe(true);
    expect(
      ResumeResponseSchema.safeParse({
        outcome: "conflict",
        projectName: "Alpha",
        conflicts: [conflict],
      }).success,
    ).toBe(true);
  });

  it("rejects a conflict without conflicts and a conflict whose state is not a RunState", () => {
    expect(
      ResumeResponseSchema.safeParse({ outcome: "conflict", projectName: "Alpha", conflicts: [] })
        .success,
    ).toBe(false);
    expect(
      ResumeResponseSchema.safeParse({
        outcome: "conflict",
        projectName: "Alpha",
        conflicts: [{ ...conflict, state: "busy" }],
      }).success,
    ).toBe(false);
  });

  it("returns the child RunId on a launched branch", () => {
    expect(
      BranchResponseSchema.safeParse({ outcome: "launched", childRunId: RUN_ID }).success,
    ).toBe(true);
    expect(BranchResponseSchema.safeParse({ outcome: "launched" }).success).toBe(false);
  });

  it("lists worktrees by opaque id, branch and basename only", () => {
    const ok = { worktrees: [{ worktreeId: "wt_1", branch: "fix-parser", folderBasename: "fix" }] };
    expect(WorktreeListResponseSchema.safeParse(ok).success).toBe(true);
    const leaked = {
      worktrees: [{ worktreeId: "wt_1", branch: "main", folderBasename: "code/fix" }],
    };
    expect(WorktreeListResponseSchema.safeParse(leaked).success).toBe(false);
  });

  it("answers a terminate request with a proposal id", () => {
    expect(
      TerminateRequestResponseSchema.safeParse({ outcome: "proposed", proposalId: "prop-1" })
        .success,
    ).toBe(true);
  });

  it("accepts only the fixed error codes", () => {
    expect(SESSION_ACTION_ERROR_CODES).toHaveLength(18);
    for (const error of SESSION_ACTION_ERROR_CODES) {
      expect(SessionActionErrorBodySchema.safeParse({ error }).success).toBe(true);
    }
    expect(
      SessionActionErrorBodySchema.safeParse({ error: "ENOENT /Users/USERNAME/x" }).success,
    ).toBe(false);
    expect(
      SessionActionErrorBodySchema.safeParse({ error: "timeout", path: "/Users/USERNAME/x" })
        .success,
    ).toBe(false);
  });

  it("accepts focused, and activated with a terminal app display name (Test 5)", () => {
    expect(FocusResponseSchema.safeParse({ outcome: "focused" }).success).toBe(true);
    expect(
      FocusResponseSchema.safeParse({ outcome: "activated", terminalApp: "Terminal" }).success,
    ).toBe(true);
    expect(FocusResponseSchema.safeParse({ outcome: "activated" }).success).toBe(false);
  });
});

describe("launch port failures map onto session action error codes", () => {
  it("maps every LaunchPortFailure, including Phase 4's, to its own error code", () => {
    // Phase 4's launch-error enum (04 D-26) as the terminal launcher reports it.
    const failures = [
      "launcher-not-configured",
      "app-not-found",
      "project-missing",
      "project-moved",
      "automation-denied",
      "folder-access-denied",
      "timeout",
      "spawn-failed",
    ];
    expect(Object.keys(LAUNCH_PORT_FAILURE_ERROR_CODES).sort()).toEqual([...failures].sort());
    for (const failure of failures) {
      const code = (LAUNCH_PORT_FAILURE_ERROR_CODES as Record<string, string>)[failure];
      expect(SESSION_ACTION_ERROR_CODES as readonly string[]).toContain(code);
      expect(SessionActionErrorBodySchema.safeParse({ error: code }).success).toBe(true);
      // One-to-one: no failure is relabelled as a different reason.
      expect(code).toBe(failure);
    }
  });
});
