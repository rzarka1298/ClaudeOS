import { z } from "zod";

/** Whether an integration piece is present in Claude Code's settings. */
export const INTEGRATION_INSTALL_STATES = ["installed", "not-installed", "unknown"] as const;
export type IntegrationInstallState = (typeof INTEGRATION_INSTALL_STATES)[number];

/**
 * Whether hook telemetry is being applied. `shape-changed` pauses session
 * tracking rather than guessing (D-12); `unsupported-version` means the
 * detected Claude Code is older than the supported minimum.
 */
export const TelemetryStatusSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ok") }),
  z.strictObject({
    kind: z.literal("shape-changed"),
    version: z.string().min(1).max(64).nullable(),
  }),
  z.strictObject({ kind: z.literal("unsupported-version"), version: z.string().min(1).max(64) }),
]);
export type TelemetryStatus = z.infer<typeof TelemetryStatusSchema>;

/**
 * The Claude integration status Settings shows (PR-24, UI-SPEC S5). The
 * service derives it from a read-only look at Claude Code's settings and its
 * own counters; only booleans, integers, a timestamp and a version cross the
 * wire. Strict, so a settings path can never ride along.
 */
export const ClaudeIntegrationStatusSchema = z.strictObject({
  hooks: z.enum(INTEGRATION_INSTALL_STATES),
  hookRuntimeMissing: z.boolean(),
  disableAllHooks: z.boolean().nullable(),
  lastEventAt: z.iso.datetime({ offset: true }).nullable(),
  telemetry: TelemetryStatusSchema,
  detectedClaudeVersion: z.string().min(1).max(64).nullable(),
  statusLine: z.enum(INTEGRATION_INSTALL_STATES),
  statusLineReported: z.boolean(),
  transcriptAnalysis: z.strictObject({ enabled: z.boolean() }),
  spoolDropCount: z.int().nonnegative(),
  unknownEventCount: z.int().nonnegative(),
  cleanupPeriodDays: z.int().min(1),
});
export type ClaudeIntegrationStatus = z.infer<typeof ClaudeIntegrationStatusSchema>;
