import { z } from "zod";

/** One rate-limit window as Claude Code's status-line JSON reports it. */
const StatusLineRateLimitSchema = z.object({
  used_percentage: z.number().min(0).max(100),
  /** An ISO timestamp or epoch seconds; the service normalizes it. */
  resets_at: z.union([z.iso.datetime({ offset: true }), z.number().nonnegative()]),
});

/**
 * The snapshot the status-line wrapper forwards (PR-14, RESEARCH Open
 * Question 4): only documented usage and identity fields. Every object here
 * is a plain `z.object`, which STRIPS unknown keys — so a repository name, a
 * pull-request title or a worktree path that reaches the service never
 * survives validation, even if the wrapper's own allowlist regressed.
 */
export const StatusLineSnapshotSchema = z.object({
  eventId: z.uuid(),
  observedAt: z.iso.datetime({ offset: true }),
  session_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, { message: "must be identifier-shaped" }),
  session_name: z.string().max(256).optional(),
  model_id: z.string().min(1).max(128).optional(),
  version: z.string().min(1).max(64).optional(),
  cost_total_usd: z.number().nonnegative().optional(),
  effort_level: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, { message: "must be identifier-shaped" })
    .optional(),
  rate_limits: z
    .object({
      five_hour: StatusLineRateLimitSchema.optional(),
      seven_day: StatusLineRateLimitSchema.optional(),
    })
    .optional(),
});
export type StatusLineSnapshot = z.infer<typeof StatusLineSnapshotSchema>;
