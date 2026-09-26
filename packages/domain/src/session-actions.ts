import { z } from "zod";
import { API_BASE } from "./api.js";

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

/** Signature stubs (RED): request schemas accept only `{}`; the rest reject everything. */
export const SessionActionRequestSchema = z.strictObject({});
export const LaunchChoiceSchema = z.never();
export const ResumeRequestSchema = z.strictObject({});
export const BranchRequestSchema = z.strictObject({});
export const OpenTranscriptRequestSchema = z.strictObject({});
export const AssociateRequestSchema = z.strictObject({});
export const TranscriptAnalysisRequestSchema = z.strictObject({});
export const ResumeResponseSchema = z.never();
export const BranchResponseSchema = z.never();
export const WorktreeListResponseSchema = z.never();
export const FocusResponseSchema = z.never();
export const TerminateRequestResponseSchema = z.never();
export const SESSION_ACTION_ERROR_CODES = [] as const;
export const SessionActionErrorBodySchema = z.never();
