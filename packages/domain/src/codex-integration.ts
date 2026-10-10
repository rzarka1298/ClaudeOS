import { z } from "zod";
import { CODEX_VERSION_PATTERN } from "./codex-usage.js";

/**
 * The Codex integration status vocabulary (plan 05.1-03): what the Settings
 * Codex group and the launcher panel show about the bridge, the hooks, the
 * installed Codex and the owner-triggered doctor summary.
 *
 * Strict by design (CODEX-09, D-17): only enums, timestamps, booleans and a
 * dotted version cross the wire. Nothing here can carry a home path, a config
 * value or an account fact; the Settings install lines are repository-relative
 * constants in the plugin (UI-SPEC R-15).
 *
 * This module imports nothing from Node, so both domain barrels re-export it.
 */

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const CodexVersionSchema = z.string().max(64).regex(CODEX_VERSION_PATTERN, {
  message: "must be a dotted version",
});

/**
 * The Antigravity bridge, as the Settings status line reads it (UI-SPEC S4-a):
 * `installed` (a window answered recently), `installed-idle` (installed, no
 * window open), `not-installed`, `outdated` (an older extension protocol is
 * loaded) and `different-folder` (the bridge writes to a state folder the
 * service does not read).
 */
export const CODEX_BRIDGE_STATES = [
  "installed",
  "installed-idle",
  "not-installed",
  "outdated",
  "different-folder",
] as const;
export type CodexBridgeState = (typeof CODEX_BRIDGE_STATES)[number];

export const CodexBridgeStatusSchema = z.strictObject({
  state: z.enum(CODEX_BRIDGE_STATES),
  lastWindowAt: IsoDateTimeSchema.nullable(),
});
export type CodexBridgeStatus = z.infer<typeof CodexBridgeStatusSchema>;

/**
 * The Codex hooks, as the Settings status line reads it: `installed` (events
 * have arrived), `installed-no-events` (the hook file is present, nothing has
 * arrived since `installedSince`), `not-installed` and `unknown`. Hook trust is
 * the owner's `/hooks` action, so it is never a state here. `installedSince`
 * is when the owner's hook file last changed, used for the "no events since"
 * line.
 */
export const CODEX_HOOK_STATES = [
  "installed",
  "installed-no-events",
  "not-installed",
  "unknown",
] as const;
export type CodexHookState = (typeof CODEX_HOOK_STATES)[number];

export const CodexHookStatusSchema = z.strictObject({
  state: z.enum(CODEX_HOOK_STATES),
  lastEventAt: IsoDateTimeSchema.nullable(),
  installedSince: IsoDateTimeSchema.nullable(),
});
export type CodexHookStatus = z.infer<typeof CodexHookStatusSchema>;

/** Whether a Codex binary was found, and which dotted version it reported. */
export const CodexInstallSchema = z.strictObject({
  installed: z.boolean(),
  version: CodexVersionSchema.nullable(),
});
export type CodexInstall = z.infer<typeof CodexInstallSchema>;

/** The overall doctor verdict; `unrecognised` is any `schemaVersion` other than 1. */
export const CODEX_DOCTOR_OVERALL = ["ok", "warning", "fail", "unrecognised"] as const;
export type CodexDoctorOverall = (typeof CODEX_DOCTOR_OVERALL)[number];

/** The most checks a doctor summary keeps. */
export const CODEX_DOCTOR_MAX_CHECKS = 64;

/**
 * One doctor check, reduced to the RESEARCH R4 allowlist: id, category and
 * status. `details`, `summary`, `notes` and `remediation` can carry local paths
 * and account facts, so they are dropped before the wire and refused here.
 */
const CodexDoctorCheckSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, { message: "must be identifier-shaped" }),
  category: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/, { message: "must be identifier-shaped" }),
  status: z.enum(["ok", "warning", "fail"]),
});

export const CodexDoctorSummarySchema = z.strictObject({
  overall: z.enum(CODEX_DOCTOR_OVERALL),
  codexVersion: CodexVersionSchema.nullable(),
  checks: z.array(CodexDoctorCheckSchema).max(CODEX_DOCTOR_MAX_CHECKS),
});
export type CodexDoctorSummary = z.infer<typeof CodexDoctorSummarySchema>;

/**
 * The composed Codex integration status. `doctor` is null until the owner runs
 * the health check. No path, config-file or account member exists.
 */
export const CodexIntegrationStatusSchema = z.strictObject({
  hooks: CodexHookStatusSchema,
  bridge: CodexBridgeStatusSchema,
  codex: CodexInstallSchema,
  doctor: CodexDoctorSummarySchema.nullable(),
});
export type CodexIntegrationStatus = z.infer<typeof CodexIntegrationStatusSchema>;
