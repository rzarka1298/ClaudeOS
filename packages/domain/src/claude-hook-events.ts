import path from "node:path";
import { z } from "zod";
import { RUN_ID_PATTERN } from "./run.js";

/**
 * The hook events Phase 5 subscribes to: the D-11 lifecycle set plus D-04's
 * tool events. Anything else a hook forwards classifies as `unknown` and is
 * counted, never applied and never treated as an error (D-12).
 */
export const KNOWN_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "UserPromptSubmit",
  "PermissionRequest",
  "PermissionDenied",
  "PostModelSwitch",
  "PostToolUse",
  "PostToolUseFailure",
] as const;
export type KnownHookEvent = (typeof KNOWN_HOOK_EVENTS)[number];

/** `SessionStart.source`, verbatim from the hooks.md matcher table. Needed. */
export const SESSION_START_SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;
export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

/**
 * `SessionEnd.reason` values documented today. The schema does NOT enforce
 * this list: a removed value such as `bypass_permissions_disabled` must still
 * parse, so `reason` is validated as an identifier and the reducer reads any
 * unlisted value as `other`.
 */
export const SESSION_END_REASONS = [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "other",
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * `StopFailure.error`, forwarded as `stop_error`. The only event whose error
 * crosses the hook boundary (PR-04), and it crosses as one of these twelve
 * values or not at all.
 */
export const STOP_FAILURE_ERRORS = [
  "rate_limit",
  "overloaded",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "cloud_credential_error",
  "unknown",
] as const;
export type StopFailureError = (typeof STOP_FAILURE_ERRORS)[number];

/** The common-input `effort` levels, forwarded as `effort_level`. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** An identifier-shaped string: letters, digits, `_` and `-` only, length-capped. */
function identifier(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, { message: "must be identifier-shaped" });
}

/**
 * An absolute, NUL-free, length-capped path (the `VaultSetupRequestSchema`
 * refinement shape, T-05-02). Containment under a known root is the
 * service's job (05-08); this only refuses shapes no real path has.
 */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), { message: "must not contain a NUL byte" })
  .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" });

/**
 * The permissive envelope every forwarded record must carry before it can be
 * classified at all. Permissive on purpose: unknown keys are tolerated (and
 * stripped), which is what lets the service tell an event it does not know
 * (`unknown`, counted) from a known event whose shape changed
 * (`shape-invalid`, flips the source to unavailable).
 */
export const HookRecordEnvelopeSchema = z.object({
  eventId: z.uuid(),
  observedAt: z.iso.datetime({ offset: true }),
  hook_event_name: z.string().min(1).max(64),
});
export type HookRecordEnvelope = z.infer<typeof HookRecordEnvelopeSchema>;

/**
 * The environment facts the hook forwards. Each is an optional hint; none is
 * ever filled in when absent. Any other env key is tolerated but dropped, so
 * a secret-bearing variable can never ride along on a record (PR-04).
 */
const HookEnvSchema = z.object({
  CLAUDE_PID: z
    .string()
    .regex(/^\d{1,10}$/, { message: "must be decimal digits" })
    .optional(),
  TERM_PROGRAM: z.string().max(64).optional(),
  CLAUDE_CODE_CHILD_SESSION: z.string().max(8).optional(),
  CCC_RUN_ID: z.string().regex(RUN_ID_PATTERN, { message: "must be RunId-shaped" }).optional(),
  CCC_LAUNCH_SOURCE: identifier(32).optional(),
});

/**
 * The fields every known event carries: the envelope, the needed
 * `session_id`, and the optional common fields. Optional means optional:
 * a field the hook did not send stays absent (D-12).
 */
const COMMON_SHAPE = {
  eventId: HookRecordEnvelopeSchema.shape.eventId,
  observedAt: HookRecordEnvelopeSchema.shape.observedAt,
  session_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, { message: "must be identifier-shaped" }),
  cwd: AbsolutePathSchema.optional(),
  transcript_path: AbsolutePathSchema.optional(),
  permission_mode: identifier(32).optional(),
  model: z.string().min(1).max(128).optional(),
  session_title: z.string().max(256).optional(),
  notification_type: identifier(64).optional(),
  tool_name: z.string().min(1).max(128).optional(),
  is_interrupt: z.boolean().optional(),
  effort_level: z.enum(EFFORT_LEVELS).optional(),
  agent_id: z.string().min(1).max(128).optional(),
  agent_type: z.string().min(1).max(128).optional(),
  from_model: z.string().min(1).max(128).optional(),
  to_model: z.string().min(1).max(128).optional(),
  switch_source: identifier(64).optional(),
  env: HookEnvSchema.optional(),
};

/**
 * One known event's schema: strict on the needed fields, tolerant of the
 * rest (D-12) — but tolerant means stripped, never kept. An unlisted key
 * (a prompt, `tool_input`, a future field) parses without error and is
 * absent from the validated record, so nothing the schema does not name can
 * be persisted or spooled downstream (PR-04). The literal event name makes
 * the union discriminable.
 */
function hookRecordSchema<TEvent extends KnownHookEvent, TNeeded extends z.ZodRawShape>(
  event: TEvent,
  needed: TNeeded,
) {
  return z.object({ ...COMMON_SHAPE, hook_event_name: z.literal(event), ...needed });
}

/** Every known event's schema. Total over {@link KNOWN_HOOK_EVENTS}. */
export const HOOK_RECORD_SCHEMAS = {
  SessionStart: hookRecordSchema("SessionStart", { source: z.enum(SESSION_START_SOURCES) }),
  SessionEnd: hookRecordSchema("SessionEnd", { reason: identifier(64).optional() }),
  Stop: hookRecordSchema("Stop", {}),
  StopFailure: hookRecordSchema("StopFailure", { stop_error: z.enum(STOP_FAILURE_ERRORS) }),
  Notification: hookRecordSchema("Notification", {}),
  SubagentStart: hookRecordSchema("SubagentStart", {}),
  SubagentStop: hookRecordSchema("SubagentStop", {}),
  TaskCreated: hookRecordSchema("TaskCreated", {}),
  TaskCompleted: hookRecordSchema("TaskCompleted", {}),
  UserPromptSubmit: hookRecordSchema("UserPromptSubmit", {}),
  PermissionRequest: hookRecordSchema("PermissionRequest", {}),
  PermissionDenied: hookRecordSchema("PermissionDenied", {}),
  PostModelSwitch: hookRecordSchema("PostModelSwitch", {}),
  PostToolUse: hookRecordSchema("PostToolUse", {}),
  PostToolUseFailure: hookRecordSchema("PostToolUseFailure", {}),
} as const satisfies Record<KnownHookEvent, z.ZodType>;

/** The validated record of one known event, discriminated on `hook_event_name`. */
export type HookRecordOf<TEvent extends KnownHookEvent> = z.infer<
  (typeof HOOK_RECORD_SCHEMAS)[TEvent]
>;

/**
 * The minimized record the hook emits and the service validates (RESEARCH
 * "Minimized hook record"). The hook in 05-03 imports this type-only.
 */
export type MinimalHookRecord = {
  [TEvent in KnownHookEvent]: HookRecordOf<TEvent>;
}[KnownHookEvent];

/**
 * The four ways a forwarded record can classify. `shape-invalid` names the
 * offending field paths and never their values (D-12, D-49, T-05-01).
 */
export type HookRecordClassification =
  | { readonly kind: "known"; readonly event: KnownHookEvent; readonly record: MinimalHookRecord }
  | { readonly kind: "unknown"; readonly eventName: string }
  | {
      readonly kind: "shape-invalid";
      readonly event: KnownHookEvent;
      readonly issuePaths: readonly string[];
    }
  | { readonly kind: "envelope-invalid" };

function isKnownHookEvent(name: string): name is KnownHookEvent {
  return (KNOWN_HOOK_EVENTS as readonly string[]).includes(name);
}

/**
 * The zod issue path as a dotted string — the field's location, which is all
 * a diagnostic may name. The offending value is never read from the issue.
 */
function issuePath(issue: z.core.$ZodIssue): string {
  return issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
}

/**
 * Classifies one forwarded hook record. Never throws and never defaults a
 * missing field: a record either validates as-is against its event's schema
 * or reports which field paths failed (D-12).
 */
export function classifyHookRecord(input: unknown): HookRecordClassification {
  const envelope = HookRecordEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { kind: "envelope-invalid" };
  }
  const eventName = envelope.data.hook_event_name;
  if (!isKnownHookEvent(eventName)) {
    return { kind: "unknown", eventName };
  }
  const parsed = HOOK_RECORD_SCHEMAS[eventName].safeParse(input);
  if (!parsed.success) {
    const issuePaths = [...new Set(parsed.error.issues.map(issuePath))];
    return { kind: "shape-invalid", event: eventName, issuePaths };
  }
  return { kind: "known", event: eventName, record: parsed.data };
}
