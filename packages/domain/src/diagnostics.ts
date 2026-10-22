import { z } from "zod";
import { API_BASE } from "./api.js";
import { FreshnessSchema } from "./usage.js";

/**
 * The Diagnostics health contract (plan 08-01; D-02, D-06, D-34, D-43; DIAG-02,
 * DIAG-03; ADR-0002).
 *
 * What crosses the socket is **codes, instants, integers and dotted versions**,
 * nothing else. There is no message, no error string, no connection reason and
 * no absolute path anywhere in these schemas, because every string a schema
 * admits can reach the screen and a public bug report (threat T-08-01).
 *
 * `status` is never sent free: it is a pure function of the closed reason code
 * (the per-subsystem tables below, typed `satisfies Record<Reason,
 * SubsystemStatus>` so a missing mapping is a compile error), and the strict
 * schema refuses a row whose status disagrees with its reason's. The Diagnostics
 * view, the bundle and the tests therefore cannot disagree about a subsystem.
 *
 * This file is Node-free: it is reachable from the plugin's browser bundle.
 */

// ---------------------------------------------------------------------------
// Path

/** `GET` — the read-only health of the six subsystems. A different route from the Phase 1 handshake health. */
export const DIAGNOSTICS_HEALTH_PATH = `${API_BASE}/diagnostics/health`;

// ---------------------------------------------------------------------------
// Status

/**
 * The five states a subsystem row can read. Separate from the four-value
 * {@link FreshnessSchema} (ADR-0002 forbids a fifth freshness value): freshness
 * says how old an answer is, status says what the answer is.
 */
export const SUBSYSTEM_STATUSES = ["ok", "setup-needed", "degraded", "failing", "unknown"] as const;
export type SubsystemStatus = (typeof SUBSYSTEM_STATUSES)[number];
export const SubsystemStatusSchema = z.enum(SUBSYSTEM_STATUSES);

/** The six subsystems in their fixed display order (D-41: Codex is parts of `collectors`, not a seventh). */
export const SUBSYSTEM_IDS = [
  "service",
  "vault",
  "hooks",
  "collectors",
  "scheduler",
  "launchers",
] as const;
export type SubsystemId = (typeof SUBSYSTEM_IDS)[number];

// ---------------------------------------------------------------------------
// Reason codes (closed, one status each)

/**
 * Codes any service-side subsystem can answer with when the probe itself did
 * not finish (D-05) plus the plugin-synthesised `service-not-running` (D-03).
 * All `unknown`: a check that did not run is never `ok`.
 */
export const SHARED_REASONS = [
  "probe-timeout",
  "probe-error",
  "subsystem-not-wired",
  "service-not-running",
] as const;
export type SharedReason = (typeof SHARED_REASONS)[number];
const SHARED_REASON_STATUS = {
  "probe-timeout": "unknown",
  "probe-error": "unknown",
  "subsystem-not-wired": "unknown",
  "service-not-running": "unknown",
} as const satisfies Record<SharedReason, SubsystemStatus>;

/** The companion service row is computed by the plugin from its connection state (D-03). */
export const SERVICE_REASONS = [
  "service-live",
  "service-connecting",
  "service-unreachable",
] as const;
export type ServiceReason = (typeof SERVICE_REASONS)[number];
export const SERVICE_REASON_STATUS = {
  "service-live": "ok",
  "service-connecting": "unknown",
  "service-unreachable": "failing",
} as const satisfies Record<ServiceReason, SubsystemStatus>;

export const VAULT_REASONS = ["vault-ready", "vault-not-set-up", ...SHARED_REASONS] as const;
export type VaultReason = (typeof VAULT_REASONS)[number];
export const VAULT_REASON_STATUS = {
  "vault-ready": "ok",
  "vault-not-set-up": "setup-needed",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<VaultReason, SubsystemStatus>;

export const HOOKS_REASONS = ["hooks-receiving", "hooks-not-installed", ...SHARED_REASONS] as const;
export type HooksReason = (typeof HOOKS_REASONS)[number];
export const HOOKS_REASON_STATUS = {
  "hooks-receiving": "ok",
  "hooks-not-installed": "setup-needed",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<HooksReason, SubsystemStatus>;

export const COLLECTORS_REASONS = ["analysis-on", "analysis-off", ...SHARED_REASONS] as const;
export type CollectorsReason = (typeof COLLECTORS_REASONS)[number];
export const COLLECTORS_REASON_STATUS = {
  "analysis-on": "ok",
  "analysis-off": "setup-needed",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<CollectorsReason, SubsystemStatus>;

export const SCHEDULER_REASONS = ["last-run-succeeded", "never-run", ...SHARED_REASONS] as const;
export type SchedulerReason = (typeof SCHEDULER_REASONS)[number];
export const SCHEDULER_REASON_STATUS = {
  "last-run-succeeded": "ok",
  "never-run": "setup-needed",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<SchedulerReason, SubsystemStatus>;

export const LAUNCHERS_REASONS = [
  "launcher-ready",
  "launcher-not-set-up",
  ...SHARED_REASONS,
] as const;
export type LaunchersReason = (typeof LAUNCHERS_REASONS)[number];
export const LAUNCHERS_REASON_STATUS = {
  "launcher-ready": "ok",
  "launcher-not-set-up": "setup-needed",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<LaunchersReason, SubsystemStatus>;

// ---------------------------------------------------------------------------
// Row building blocks (typed values only; no free text)

const IsoInstantSchema = z.iso.datetime({ offset: true });

/** A dotted version such as `0.1.0` or `2.1.5-beta.1`. Never free text. */
const DOTTED_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]{1,32})?$/;
const DottedVersionSchema = z.string().max(64).regex(DOTTED_VERSION_PATTERN, {
  message: "must be a dotted version",
});

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A `~/...` or `…/a/b` string the service builds; never an absolute path.
 * Interim shape check: plan 08-01 task 3 replaces it with `DisplayPathSchema`.
 */
const DisplayPathStringSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !hasControlCharacter(value) &&
      (value === "~" || value.startsWith("~/") || value.startsWith("…/")),
    {
      message: "must be a display path, never an absolute path",
    },
  );

function statusMatchesReason<T extends { status: SubsystemStatus; reasonCode: string }>(
  table: Readonly<Record<string, SubsystemStatus>>,
): (row: T) => boolean {
  return (row) => table[row.reasonCode] === row.status;
}

function serviceSideRow<Id extends string, R extends readonly [string, ...string[]]>(
  id: Id,
  reasons: R,
  table: Readonly<Record<string, SubsystemStatus>>,
) {
  return z
    .strictObject({
      id: z.literal(id),
      status: SubsystemStatusSchema,
      reasonCode: z.enum(reasons),
      checkedAt: IsoInstantSchema,
      freshness: FreshnessSchema,
    })
    .refine(statusMatchesReason(table), {
      message: "status must equal the status of the reason code",
      path: ["status"],
    });
}

export const VaultRowSchema = serviceSideRow("vault", VAULT_REASONS, VAULT_REASON_STATUS);
export const HooksRowSchema = serviceSideRow("hooks", HOOKS_REASONS, HOOKS_REASON_STATUS);
export const CollectorsRowSchema = serviceSideRow(
  "collectors",
  COLLECTORS_REASONS,
  COLLECTORS_REASON_STATUS,
);
export const SchedulerRowSchema = serviceSideRow(
  "scheduler",
  SCHEDULER_REASONS,
  SCHEDULER_REASON_STATUS,
);
export const LaunchersRowSchema = serviceSideRow(
  "launchers",
  LAUNCHERS_REASONS,
  LAUNCHERS_REASON_STATUS,
);

/** The companion service row, computed by the plugin from its connection state (D-03, D-43). */
export const ServiceRowSchema = z
  .strictObject({
    id: z.literal("service"),
    status: SubsystemStatusSchema,
    reasonCode: z.enum(SERVICE_REASONS),
    checkedAt: IsoInstantSchema.nullable(),
    freshness: FreshnessSchema,
  })
  .refine(statusMatchesReason(SERVICE_REASON_STATUS), {
    message: "status must equal the status of the reason code",
    path: ["status"],
  });

// ---------------------------------------------------------------------------
// The response

/** Whether a Keychain item exists. Presence only, never the value (D-17, D-38). */
export const KEYCHAIN_PRESENCES = ["present", "absent", "unknown"] as const;
export const KeychainPresenceSchema = z.enum(KEYCHAIN_PRESENCES);

const CountSchema = z.int().nonnegative().nullable();

export const DiagnosticsHealthResponseSchema = z.strictObject({
  generatedAt: IsoInstantSchema,
  service: z.strictObject({
    version: DottedVersionSchema,
    startedAt: IsoInstantSchema,
    storeSchemaVersion: z.int().nonnegative(),
  }),
  /** The five service-side rows in the fixed display order; the service row is the plugin's. */
  rows: z.tuple([
    VaultRowSchema,
    HooksRowSchema,
    CollectorsRowSchema,
    SchedulerRowSchema,
    LaunchersRowSchema,
  ]),
  keychain: z.strictObject({
    installSecret: KeychainPresenceSchema,
    researchKey: KeychainPresenceSchema,
  }),
  paths: z.strictObject({
    vault: DisplayPathStringSchema.nullable(),
    runtimeDir: DisplayPathStringSchema,
    socket: DisplayPathStringSchema,
  }),
  vaultFingerprint: z.null(),
  counts: z.strictObject({
    projects: CountSchema,
    scanFolders: CountSchema,
    openTasks: CountSchema,
    reports: CountSchema,
  }),
});
export type DiagnosticsHealthResponse = z.infer<typeof DiagnosticsHealthResponseSchema>;

// ---------------------------------------------------------------------------
// Summary

export interface RowSummary {
  readonly failing: number;
  readonly degraded: number;
  readonly unknown: number;
  readonly setupNeeded: number;
  readonly ok: number;
}

/** Counts rows by status. Pure, so the Diagnostics view and the bundle call the same code. */
export function summariseRows(rows: readonly { readonly status: SubsystemStatus }[]): RowSummary {
  let failing = 0;
  let degraded = 0;
  let unknown = 0;
  let setupNeeded = 0;
  let ok = 0;
  for (const row of rows) {
    if (row.status === "failing") failing += 1;
    else if (row.status === "degraded") degraded += 1;
    else if (row.status === "unknown") unknown += 1;
    else if (row.status === "setup-needed") setupNeeded += 1;
    else ok += 1;
  }
  return { failing, degraded, unknown, setupNeeded, ok };
}
