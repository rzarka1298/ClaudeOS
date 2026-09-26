import { z } from "zod";
import { API_BASE } from "./api.js";
import type { GuardConflict, LaunchPortFailure } from "./ports.js";
import { RUN_STATES } from "./run.js";
import { RunIdSchema } from "./session.js";

// Route constants: fixed paths under API_BASE, never a ':param' segment. The
// route table matches exact paths only, so a runId travels in the JSON body
// (PATTERNS fact 1, the VAULT_SETUP_PATH precedent).

/** `POST` — the hook delivers one minimized record. */
export const CLAUDE_HOOK_EVENTS_PATH = `${API_BASE}/claude/hook-events`;
/** `POST` — the status-line wrapper delivers one snapshot. */
export const CLAUDE_STATUSLINE_PATH = `${API_BASE}/claude/statusline`;
/** `GET` — the Claude integration status (PR-24). */
export const CLAUDE_INTEGRATION_PATH = `${API_BASE}/claude/integration`;
/** `POST` — turn transcript analysis on or off (D-03). */
export const CLAUDE_TRANSCRIPT_ANALYSIS_PATH = `${API_BASE}/claude/transcript-analysis`;
/** `POST` — delete cached usage analytics (D-46). */
export const CLAUDE_USAGE_DELETE_PATH = `${API_BASE}/claude/usage/delete`;
/** `POST` — per-Session usage for the detail pane (PR-23). */
export const CLAUDE_SESSION_USAGE_PATH = `${API_BASE}/claude/usage/session`;
/** `POST` — focus the Session's terminal. */
export const SESSION_FOCUS_PATH = `${API_BASE}/sessions/focus`;
/** `POST` — resume the Session in a new terminal. */
export const SESSION_RESUME_PATH = `${API_BASE}/sessions/resume`;
/** `POST` — branch (fork) the Session into a new one. */
export const SESSION_BRANCH_PATH = `${API_BASE}/sessions/branch`;
/** `POST` — list the Session project's existing worktrees (read-only). */
export const SESSION_WORKTREES_PATH = `${API_BASE}/sessions/worktrees`;
/** `POST` — reveal or open the Session's transcript. */
export const SESSION_OPEN_TRANSCRIPT_PATH = `${API_BASE}/sessions/open-transcript`;
/** `POST` — associate an unclassified Session with a registered project. */
export const SESSION_ASSOCIATE_PATH = `${API_BASE}/sessions/associate`;
/** `POST` — send a force-terminate request to the approval inbox. */
export const SESSION_TERMINATE_REQUEST_PATH = `${API_BASE}/sessions/terminate-request`;

// Request bodies are strict: an unknown key from the plugin is a bug, and a
// smuggled filesystem path must fail rather than ride along. No request
// schema has a path field at all (T-05-03): the service resolves every path
// from its own records by runId or projectId.

/** The body of every action that addresses one Session. */
export const SessionActionRequestSchema = z.strictObject({ runId: RunIdSchema });
export type SessionActionRequest = z.infer<typeof SessionActionRequestSchema>;

/** An existing worktree is addressed by the opaque id the worktree list returned, never by path. */
const WorktreeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, {
  message: "must be an opaque worktree id",
});

/**
 * A new worktree's name. Claude Code creates it (`--worktree <name>`); the
 * dashboard runs no Git write (D-28, D-30). The character set rules out
 * separators and traversal (UI-SPEC S4-a validation).
 */
export const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** How a launch should run when the guard offers choices (UI-SPEC S4-a). */
export const LaunchChoiceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("continue") }),
  z.strictObject({ kind: z.literal("plan") }),
  z.strictObject({ kind: z.literal("existing-worktree"), worktreeId: WorktreeIdSchema }),
  z.strictObject({
    kind: z.literal("new-worktree"),
    name: z
      .string()
      .regex(WORKTREE_NAME_PATTERN, { message: "must be a worktree name" })
      .refine((name) => name !== "." && name !== "..", { message: "must be a worktree name" }),
  }),
]);
export type LaunchChoice = z.infer<typeof LaunchChoiceSchema>;

export const ResumeRequestSchema = z.strictObject({
  runId: RunIdSchema,
  choice: LaunchChoiceSchema.optional(),
});
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

export const BranchRequestSchema = z.strictObject({
  runId: RunIdSchema,
  choice: LaunchChoiceSchema.optional(),
});
export type BranchRequest = z.infer<typeof BranchRequestSchema>;

/** `reveal` shows the transcript in Finder; `open` hands it to the default app (UI-SPEC S4-b). */
export const OpenTranscriptRequestSchema = z.strictObject({
  runId: RunIdSchema,
  mode: z.enum(["reveal", "open"]),
});
export type OpenTranscriptRequest = z.infer<typeof OpenTranscriptRequestSchema>;

export const AssociateRequestSchema = z.strictObject({
  runId: RunIdSchema,
  projectId: z.string().min(1).max(128),
});
export type AssociateRequest = z.infer<typeof AssociateRequestSchema>;

export const TranscriptAnalysisRequestSchema = z.strictObject({ enabled: z.boolean() });
export type TranscriptAnalysisRequest = z.infer<typeof TranscriptAnalysisRequestSchema>;

/** A Run the concurrent-write guard found in the target directory (D-27). */
export const GuardConflictSchema = z.strictObject({
  runId: RunIdSchema,
  sessionName: z.string().min(1).max(256),
  state: z.enum(RUN_STATES),
  lastActivityAt: z.iso.datetime({ offset: true }).nullable(),
}) satisfies z.ZodType<GuardConflict, unknown>;

const ConflictOutcomeSchema = z.strictObject({
  outcome: z.literal("conflict"),
  projectName: z.string().min(1).max(256),
  conflicts: z.array(GuardConflictSchema).min(1),
});

export const ResumeResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("launched") }),
  ConflictOutcomeSchema,
]);
export type ResumeResponse = z.infer<typeof ResumeResponseSchema>;

/** A branch launch also returns the child Run pre-registered for the fork. */
export const BranchResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("launched"), childRunId: RunIdSchema }),
  ConflictOutcomeSchema,
]);
export type BranchResponse = z.infer<typeof BranchResponseSchema>;

/** Existing worktrees, by opaque id, branch and folder basename only — never a path. */
export const WorktreeListResponseSchema = z.strictObject({
  worktrees: z.array(
    z.strictObject({
      worktreeId: WorktreeIdSchema,
      branch: z.string().min(1).max(256),
      folderBasename: z
        .string()
        .min(1)
        .max(255)
        .refine((value) => !value.includes("/") && !value.includes("\0"), {
          message: "must be a basename, not a path",
        }),
    }),
  ),
});
export type WorktreeListResponse = z.infer<typeof WorktreeListResponseSchema>;

/**
 * `focused` selected the Session's own tab; `activated` could only bring the
 * terminal app forward (its display name, e.g. "Terminal").
 */
export const FocusResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("focused") }),
  z.strictObject({ outcome: z.literal("activated"), terminalApp: z.string().min(1).max(64) }),
]);
export type FocusResponse = z.infer<typeof FocusResponseSchema>;

export const TerminateRequestResponseSchema = z.strictObject({
  outcome: z.literal("proposed"),
  proposalId: z.string().min(1).max(128),
});
export type TerminateRequestResponse = z.infer<typeof TerminateRequestResponseSchema>;

/**
 * Why a session action failed. Each code maps one-to-one onto the UI-SPEC
 * reason vocabulary; the plugin owns the copy, so no body ever carries a
 * message or a path.
 */
export const SESSION_ACTION_ERROR_CODES = [
  "service-disconnected",
  "timeout",
  "process-ended",
  "terminal-unsupported",
  "background-session",
  "automation-denied",
  "transcript-missing",
  "transcript-outside-root",
  "project-missing",
  "launcher-not-configured",
  "run-not-found",
  "invalid-state",
  "approval-unavailable",
  "project-not-registered",
  // Terminal-launch failures (resume and branch), one per LaunchPortFailure.
  "folder-access-denied",
  "spawn-failed",
  "project-moved",
  "app-not-found",
] as const;
export type SessionActionErrorCode = (typeof SESSION_ACTION_ERROR_CODES)[number];

/**
 * The error code a resume or branch reports when the terminal launcher
 * fails. Exhaustive over {@link LaunchPortFailure}: adding a failure kind
 * without a code is a compile error, so no launch failure is ever
 * mislabelled as a different reason.
 */
export const LAUNCH_PORT_FAILURE_ERROR_CODES = {
  "launcher-not-configured": "launcher-not-configured",
  "app-not-found": "app-not-found",
  "project-missing": "project-missing",
  "project-moved": "project-moved",
  "automation-denied": "automation-denied",
  "folder-access-denied": "folder-access-denied",
  timeout: "timeout",
  "spawn-failed": "spawn-failed",
} as const satisfies Record<LaunchPortFailure, SessionActionErrorCode>;

export const SessionActionErrorBodySchema = z.strictObject({
  error: z.enum(SESSION_ACTION_ERROR_CODES),
});
export type SessionActionErrorBody = z.infer<typeof SessionActionErrorBodySchema>;
