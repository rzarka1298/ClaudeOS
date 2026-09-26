import { z } from "zod";
import { STOP_FAILURE_ERRORS, type StopFailureError } from "./claude-hook-events.js";
import type { RunId } from "./ids.js";
import { RUN_ID_PATTERN, RUN_STATES, type RunState } from "./run.js";

/**
 * How a Session came to exist. `skill` and `automation` are reserved for
 * milestone 2 and are never emitted in Phase 5 (D-25).
 */
export const LAUNCH_SOURCES = ["terminal", "dashboard", "external", "skill", "automation"] as const;
export type LaunchSource = (typeof LAUNCH_SOURCES)[number];

/** A running Session's second fact beside its state, never folded into the label. */
export const SESSION_ACTIVITIES = ["working", "idle"] as const;
export type SessionActivity = (typeof SESSION_ACTIVITIES)[number];

/** How a Run links to the Run it continued from. */
export const RUN_LINK_KINDS = ["resume", "fork", "clear"] as const;
export type RunLinkKind = (typeof RUN_LINK_KINDS)[number];

/** A RunId crossing the wire: validated against the minted shape, never minted here. */
export const RunIdSchema = z.custom<RunId>(
  (value) => typeof value === "string" && RUN_ID_PATTERN.test(value),
  { message: "must be a RunId" },
);

/** A single path segment. A value containing `/` is a path, which a view never carries (D-26). */
const BasenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("/") && !value.includes("\0"), {
    message: "must be a basename, not a path",
  });

/**
 * What the plugin sees of one Run. Strict: a key the service did not mean to
 * send (a full `cwd`, a transcript path) fails rather than riding along.
 */
export const SessionViewSchema = z.strictObject({
  runId: RunIdSchema,
  revision: z.number().int().nonnegative(),
  claudeSessionId: z.string().min(1).max(128).nullable(),
  state: z.enum(RUN_STATES),
  activity: z.enum(SESSION_ACTIVITIES).nullable(),
  projectId: z.string().min(1).nullable(),
  projectName: z.string().nullable(),
  name: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  launchSource: z.enum(LAUNCH_SOURCES).nullable(),
  permissionMode: z.string().nullable(),
  claudeVersion: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  subagents: z.strictObject({
    active: z.number().int().nonnegative(),
    lastType: z.string().nullable(),
  }),
  lastError: z.enum(STOP_FAILURE_ERRORS).nullable(),
  linkKind: z.enum(RUN_LINK_KINDS).nullable(),
  linkedFromRunId: RunIdSchema.nullable(),
  cwdBasename: BasenameSchema.nullable(),
  worktreeBasename: BasenameSchema.nullable(),
  hasTranscript: z.boolean(),
  terminateRequested: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

/** The `session.upserted` event payload. */
export const SessionUpsertedPayloadSchema = z.strictObject({
  session: SessionViewSchema,
});
export type SessionUpsertedPayload = z.infer<typeof SessionUpsertedPayloadSchema>;

/**
 * The internal Run model the reducer (collectors) and the store
 * (operational-store) share. Both may import only domain, so it lives here.
 * It carries private facts (full `cwd`, `transcriptPath`, `pid`) that never
 * reach a {@link SessionView}; {@link toSessionView} is the one crossing.
 */
export interface SessionRun {
  readonly runId: RunId;
  readonly revision: number;
  readonly claudeSessionId: string | null;
  readonly pid: number | null;
  /** The raw C-locale `ps -o lstart=` string, compared for equality only. */
  readonly pidStartedAt: string | null;
  readonly state: RunState;
  readonly activity: SessionActivity | null;
  readonly projectId: string | null;
  readonly name: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly launchSource: LaunchSource | null;
  readonly cwd: string | null;
  readonly worktreeRoot: string | null;
  readonly permissionMode: string | null;
  readonly lastError: StopFailureError | null;
  readonly claudeVersion: string | null;
  readonly transcriptPath: string | null;
  readonly linkKind: RunLinkKind | null;
  readonly linkedFromRunId: RunId | null;
  readonly subagentActiveIds: readonly string[];
  readonly subagentLastType: string | null;
  readonly startedAt: string;
  readonly lastActivityAt: string | null;
  readonly endedAt: string | null;
  readonly terminateRequestedAt: string | null;
  readonly endObservedAt: string | null;
}

/** Signature stub (RED). */
export function toSessionView(run: SessionRun, projectName: string | null): SessionView {
  return {
    runId: run.runId,
    revision: run.revision,
    claudeSessionId: run.claudeSessionId,
    state: run.state,
    activity: run.activity,
    projectId: run.projectId,
    projectName,
    name: run.name,
    model: run.model,
    effort: run.effort,
    launchSource: run.launchSource,
    permissionMode: run.permissionMode,
    claudeVersion: run.claudeVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    lastActivityAt: run.lastActivityAt,
    subagents: { active: 0, lastType: null },
    lastError: run.lastError,
    linkKind: run.linkKind,
    linkedFromRunId: run.linkedFromRunId,
    cwdBasename: run.cwd,
    worktreeBasename: run.worktreeRoot,
    hasTranscript: false,
    terminateRequested: false,
  };
}

/** How a run state is shown everywhere (UI-SPEC "Run-state vocabulary"). */
export interface RunStateDisplay {
  readonly label: string;
  readonly glyph: string;
  readonly group: "active" | "ended";
}

/** Signature stub (RED). */
export const RUN_STATE_DISPLAY: Readonly<Record<RunState, RunStateDisplay>> = {
  queued: { label: "", glyph: "", group: "active" },
  starting: { label: "", glyph: "", group: "active" },
  running: { label: "", glyph: "", group: "active" },
  "waiting-for-approval": { label: "", glyph: "", group: "active" },
  stale: { label: "", glyph: "", group: "active" },
  completed: { label: "", glyph: "", group: "ended" },
  failed: { label: "", glyph: "", group: "ended" },
  cancelled: { label: "", glyph: "", group: "ended" },
};

export const TERMINAL_RUN_STATES = ["completed", "failed", "cancelled"] as const;

/** Signature stub (RED). */
export function isTerminalRunState(_state: RunState): boolean {
  return false;
}

/** Signature stub (RED). */
export const STALE_RUN_EXPLANATION = "";

/** Signature stub (RED). */
export const NOT_REPORTED = "";

/** Signature stub (RED). */
export function sessionDisplayName(_view: SessionView): string {
  return "";
}
