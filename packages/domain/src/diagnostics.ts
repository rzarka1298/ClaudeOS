import { z } from "zod";
import { API_BASE } from "./api.js";
import { DisplayPathSchema } from "./display-path.js";
import type { RunErrorCode } from "./research.js";
import { FreshnessSchema } from "./usage.js";

/**
 * The Diagnostics health contract (plan 08-01; D-02, D-04, D-06, D-08, D-34,
 * D-35, D-39, D-41, D-43; DIAG-02, DIAG-03; ADR-0002).
 *
 * What crosses the socket is **codes, instants, integers and dotted versions**,
 * nothing else. There is no message, no error string, no connection reason and
 * no absolute path anywhere in these schemas, because every string a schema
 * admits can reach the screen and a public bug report (threat T-08-01).
 *
 * `status` is never sent free: it is a pure function of the closed reason code
 * (the per-subsystem tables below, typed `satisfies Record<Reason,
 * SubsystemStatus>` so a missing mapping is a compile error), and the strict
 * schema refuses a row whose status disagrees with its reason's. For a row made
 * of parts the status must also equal the roll-up of its parts' statuses
 * ({@link rollupStatus}). The Diagnostics view, the bundle and the tests
 * therefore cannot disagree about a subsystem.
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

/** A recognised status as itself, anything else as `unknown`. */
function asKnownStatus(status: unknown): SubsystemStatus {
  return (SUBSYSTEM_STATUSES as readonly unknown[]).includes(status)
    ? (status as SubsystemStatus)
    : "unknown";
}

/** The ranks the roll-up uses. `setup-needed` is handled separately (see {@link rollupStatus}). */
const ROLLUP_RANK = {
  failing: 4,
  degraded: 3,
  unknown: 2,
  ok: 1,
  "setup-needed": 1,
} as const satisfies Record<SubsystemStatus, number>;

/**
 * The status of a row made of parts (D-06): `failing > degraded > unknown >
 * ok`, and `setup-needed` only when **every** part is `setup-needed`, so one
 * unconfigured optional part never masks a working one and one working part
 * never hides that nothing else is set up. A mix of `ok` and `setup-needed` is
 * `ok`. No parts at all is `unknown`: nothing is invented as working.
 */
export function rollupStatus(statuses: readonly SubsystemStatus[]): SubsystemStatus {
  if (statuses.length === 0) return "unknown";
  // A status the table does not know is unknown, never ok (a value that skipped parsing must not read as working).
  const known = statuses.map(asKnownStatus);
  if (known.every((status) => status === "setup-needed")) return "setup-needed";
  let worst: SubsystemStatus = "ok";
  for (const status of known) {
    if (ROLLUP_RANK[status] > ROLLUP_RANK[worst]) worst = status;
  }
  return worst;
}

/**
 * The status of a row made of parts when some parts are **passive** (D-34a,
 * resolving D-34 against D-06). A passive part is one that cannot be "not set
 * up": it reads `ok` simply because nothing is wrong (collectors' `telemetry`
 * and `spool`). A passive `ok` does not count as a working part when deciding
 * between `ok` and `setup-needed`, so a row whose non-passive parts are all
 * `setup-needed` reads `setup-needed` (a fresh install). A passive part that is
 * `degraded`, `failing` or `unknown` still raises the row, and a row that is
 * entirely passive-`ok` reads `ok`. With no passive ids this is
 * {@link rollupStatus}, so one ready launcher still keeps the launchers row `ok`.
 */
export function rollupPartStatuses(
  parts: readonly { readonly partId: string; readonly status: SubsystemStatus }[],
  passivePartIds: readonly string[],
): SubsystemStatus {
  const status = rollupStatus(parts.map((part) => part.status));
  // Only a mix of `ok` and `setup-needed` (or all `ok`) can still be reclassified.
  if (status !== "ok") return status;
  const active = parts.filter((part) => !passivePartIds.includes(part.partId));
  if (active.length > 0 && active.every((part) => part.status === "setup-needed")) {
    return "setup-needed";
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Reason codes (closed, one status each)

/**
 * Codes any service-side subsystem can answer with when the probe itself did
 * not finish (D-05). All `unknown`: a check that did not run is never `ok`.
 * These are the only reasons a row without parts may carry, and the only
 * shared codes a single part may carry.
 */
export const PROBE_REASONS = ["probe-timeout", "probe-error", "subsystem-not-wired"] as const;

/**
 * Reasons only the plugin ever produces (FIX1A MINOR 4). The service never
 * sends them and the strict service response schema refuses them: the plugin
 * overlays `vault-mismatch` / `vault-check-unavailable` after comparing the
 * salted fingerprint (D-36) with the vault open in Obsidian, and clears every
 * service-dependent row to `service-not-running` while the service is away
 * (D-03). They stay in the full per-subsystem lists and status tables below
 * (the plugin's copy table must cover them); {@link SERVICE_SIDE_REASONS} is
 * those lists minus these codes. A row carrying one is typed
 * {@link DisplayedRow}, not {@link ServiceSideRow}.
 */
export const OVERLAY_ONLY_REASONS = [
  "vault-mismatch",
  "vault-check-unavailable",
  "service-not-running",
] as const;
export type OverlayOnlyReason = (typeof OVERLAY_ONLY_REASONS)[number];

/** The probe-did-not-finish codes plus the plugin-synthesised `service-not-running` (D-03). */
export const SHARED_REASONS = [...PROBE_REASONS, "service-not-running"] as const;
export type SharedReason = (typeof SHARED_REASONS)[number];
const SHARED_REASON_STATUS = {
  "probe-timeout": "unknown",
  "probe-error": "unknown",
  "subsystem-not-wired": "unknown",
  "service-not-running": "unknown",
} as const satisfies Record<SharedReason, SubsystemStatus>;

/** The shared codes a single part can carry (the plugin clears whole rows for `service-not-running`). */
const PART_PROBE_REASONS = PROBE_REASONS;

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

// -- Vault access ------------------------------------------------------------

/**
 * The full list the plugin can display. `vault-mismatch` and
 * `vault-check-unavailable` are overlaid by the plugin after it compares the
 * salted fingerprint (D-36) with the vault open in Obsidian; the service never
 * sends them (see {@link OVERLAY_ONLY_REASONS} and {@link SERVICE_SIDE_REASONS}).
 */
export const VAULT_REASONS = [
  "vault-ready",
  "vault-not-set-up",
  "managed-tree-incomplete",
  "not-an-obsidian-vault",
  "vault-mismatch",
  "vault-root-missing",
  "vault-root-not-directory",
  "vault-root-unreadable",
  "vault-root-not-writable",
  "vault-root-refused",
  "vault-check-unavailable",
  ...SHARED_REASONS,
] as const;
export type VaultReason = (typeof VAULT_REASONS)[number];
export const VAULT_REASON_STATUS = {
  "vault-ready": "ok",
  "vault-not-set-up": "setup-needed",
  "managed-tree-incomplete": "degraded",
  "not-an-obsidian-vault": "degraded",
  "vault-mismatch": "degraded",
  "vault-root-missing": "failing",
  "vault-root-not-directory": "failing",
  "vault-root-unreadable": "failing",
  "vault-root-not-writable": "failing",
  "vault-root-refused": "failing",
  "vault-check-unavailable": "unknown",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<VaultReason, SubsystemStatus>;

// -- Claude Code hooks -------------------------------------------------------

/**
 * Precedence the hooks probe (08-08) applies, mirroring `hookStatusText`:
 * not installed, then unreadable, then disabled, then runtime missing, then no
 * events yet, then silent, then receiving. Idle hooks are `unknown`, never
 * `degraded` (D-35): `lastEventAt` is process-lifetime memory, so a healthy
 * install reads `no-events-yet` after a service restart and the system cannot
 * tell idle from broken. Telemetry belongs to the collectors row.
 */
export const HOOKS_REASONS = [
  "hooks-receiving",
  "hooks-not-installed",
  "hooks-disabled-in-claude",
  "hook-runtime-missing",
  "hooks-state-unreadable",
  "no-events-yet",
  "events-silent",
  ...SHARED_REASONS,
] as const;
export type HooksReason = (typeof HOOKS_REASONS)[number];
export const HOOKS_REASON_STATUS = {
  "hooks-receiving": "ok",
  "hooks-not-installed": "setup-needed",
  "hooks-disabled-in-claude": "degraded",
  "hook-runtime-missing": "failing",
  "hooks-state-unreadable": "unknown",
  "no-events-yet": "unknown",
  "events-silent": "unknown",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<HooksReason, SubsystemStatus>;

/**
 * How long without a hook event before the row reads `events-silent` (D-35).
 * Defined once here; the plugin's Settings switches to this constant in 08-15.
 */
export const HOOK_SILENT_THRESHOLD_MS = 10 * 60 * 1000;

// -- Usage collectors (Claude parts and, per D-41, Codex parts) ---------------

export const COLLECTORS_PART_IDS = [
  "telemetry",
  "status-line",
  "transcript-analysis",
  "spool",
  "codex-install",
  "codex-hooks",
  "codex-bridge",
  "codex-doctor",
] as const;
export type CollectorsPartId = (typeof COLLECTORS_PART_IDS)[number];

/** Parts that cannot be "not set up" and so never lift a setup-needed collectors row (D-34a). */
export const COLLECTORS_PASSIVE_PART_IDS = [
  "telemetry",
  "spool",
] as const satisfies readonly CollectorsPartId[];

const TELEMETRY_REASONS = [
  "telemetry-ok",
  "telemetry-shape-changed",
  "telemetry-unsupported-version",
] as const;
const STATUS_LINE_REASONS = [
  "statusline-reporting",
  "statusline-not-installed",
  "statusline-awaiting-report",
  "statusline-state-unreadable",
] as const;
const TRANSCRIPT_ANALYSIS_REASONS = ["analysis-on", "analysis-off"] as const;
const SPOOL_REASONS = ["spool-clean", "spool-dropped-records"] as const;
const CODEX_INSTALL_REASONS = ["codex-installed", "codex-not-installed"] as const;
const CODEX_HOOKS_REASONS = [
  "codex-hooks-receiving",
  "codex-hooks-not-installed",
  "codex-hooks-no-events",
  "codex-hooks-state-unreadable",
] as const;
const CODEX_BRIDGE_REASONS = [
  "codex-bridge-ready",
  "codex-bridge-not-installed",
  "codex-bridge-outdated",
  "codex-bridge-different-folder",
] as const;
const CODEX_DOCTOR_REASONS = [
  "codex-doctor-ok",
  "codex-doctor-not-run",
  "codex-doctor-warning",
  "codex-doctor-failed",
  "codex-doctor-unrecognised",
] as const;

/** The reasons each collectors part may carry (its own codes plus the probe-did-not-finish codes). */
export const COLLECTORS_PART_REASONS = {
  telemetry: [...TELEMETRY_REASONS, ...PART_PROBE_REASONS],
  "status-line": [...STATUS_LINE_REASONS, ...PART_PROBE_REASONS],
  "transcript-analysis": [...TRANSCRIPT_ANALYSIS_REASONS, ...PART_PROBE_REASONS],
  spool: [...SPOOL_REASONS, ...PART_PROBE_REASONS],
  "codex-install": [...CODEX_INSTALL_REASONS, ...PART_PROBE_REASONS],
  "codex-hooks": [...CODEX_HOOKS_REASONS, ...PART_PROBE_REASONS],
  "codex-bridge": [...CODEX_BRIDGE_REASONS, ...PART_PROBE_REASONS],
  "codex-doctor": [...CODEX_DOCTOR_REASONS, ...PART_PROBE_REASONS],
} as const satisfies Record<CollectorsPartId, readonly [string, ...string[]]>;

export const COLLECTORS_REASONS = [
  ...TELEMETRY_REASONS,
  ...STATUS_LINE_REASONS,
  ...TRANSCRIPT_ANALYSIS_REASONS,
  ...SPOOL_REASONS,
  ...CODEX_INSTALL_REASONS,
  ...CODEX_HOOKS_REASONS,
  ...CODEX_BRIDGE_REASONS,
  ...CODEX_DOCTOR_REASONS,
  ...SHARED_REASONS,
] as const;
export type CollectorsReason = (typeof COLLECTORS_REASONS)[number];
export const COLLECTORS_REASON_STATUS = {
  "telemetry-ok": "ok",
  "telemetry-shape-changed": "degraded",
  "telemetry-unsupported-version": "degraded",
  "statusline-reporting": "ok",
  "statusline-not-installed": "setup-needed",
  "statusline-awaiting-report": "unknown",
  "statusline-state-unreadable": "unknown",
  "analysis-on": "ok",
  "analysis-off": "setup-needed",
  "spool-clean": "ok",
  "spool-dropped-records": "degraded",
  "codex-installed": "ok",
  "codex-not-installed": "setup-needed",
  "codex-hooks-receiving": "ok",
  "codex-hooks-not-installed": "setup-needed",
  "codex-hooks-no-events": "unknown",
  "codex-hooks-state-unreadable": "unknown",
  "codex-bridge-ready": "ok",
  "codex-bridge-not-installed": "setup-needed",
  "codex-bridge-outdated": "degraded",
  "codex-bridge-different-folder": "degraded",
  "codex-doctor-ok": "ok",
  "codex-doctor-not-run": "setup-needed",
  "codex-doctor-warning": "degraded",
  "codex-doctor-failed": "degraded",
  "codex-doctor-unrecognised": "unknown",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<CollectorsReason, SubsystemStatus>;

// -- Scheduler ---------------------------------------------------------------

export const SCHEDULER_PART_IDS = ["last-run", "research-key", "sources"] as const;
export type SchedulerPartId = (typeof SCHEDULER_PART_IDS)[number];

/**
 * Scheduler parts that never lift a setup-needed row (D-34a): default sources are
 * configured on a fresh install, which is not "the scheduler works".
 */
export const SCHEDULER_PASSIVE_PART_IDS = ["sources"] as const satisfies readonly SchedulerPartId[];

/**
 * One reason per `RUN_ERROR_CODES` member (D-04). The two checks below make a
 * new run error code fail the build until it has a health reason, in both
 * directions: a code without a reason, and a reason without a code.
 */
export const RUN_REASONS = [
  "run-summariser-unconfigured",
  "run-summariser-failed",
  "run-summariser-refused",
  "run-summariser-invalid-output",
  "run-all-sources-failed",
  "run-vault-write-failed",
  "run-interrupted",
] as const;
type RunReason = (typeof RUN_REASONS)[number];
type MissingRunReason = Exclude<`run-${RunErrorCode}`, RunReason>;
type ExtraRunReason = Exclude<RunReason, `run-${RunErrorCode}`>;
const everyRunCodeHasAReason: [MissingRunReason] extends [never] ? true : never = true;
const everyRunReasonHasACode: [ExtraRunReason] extends [never] ? true : never = true;
void everyRunCodeHasAReason;
void everyRunReasonHasACode;

/** Keyed by `run-${RunErrorCode}`: a code added to `RUN_ERROR_CODES` is a compile error here until mapped. */
export const RUN_REASON_STATUS = {
  "run-summariser-unconfigured": "setup-needed",
  "run-summariser-failed": "degraded",
  "run-summariser-refused": "degraded",
  "run-summariser-invalid-output": "degraded",
  "run-all-sources-failed": "degraded",
  "run-vault-write-failed": "degraded",
  "run-interrupted": "unknown",
} as const satisfies Record<`run-${RunErrorCode}`, SubsystemStatus>;

const LAST_RUN_REASONS = [
  "last-run-succeeded",
  "run-in-flight",
  "never-run",
  ...RUN_REASONS,
] as const;
const RESEARCH_KEY_REASONS = [
  "research-key-present",
  "research-key-missing",
  "research-key-check-failed",
  "research-key-not-checked",
] as const;
const SOURCES_REASONS = ["sources-configured", "sources-config-unusable"] as const;

export const SCHEDULER_PART_REASONS = {
  "last-run": [...LAST_RUN_REASONS, ...PART_PROBE_REASONS],
  "research-key": [...RESEARCH_KEY_REASONS, ...PART_PROBE_REASONS],
  sources: [...SOURCES_REASONS, ...PART_PROBE_REASONS],
} as const satisfies Record<SchedulerPartId, readonly [string, ...string[]]>;

export const SCHEDULER_REASONS = [
  ...LAST_RUN_REASONS,
  ...RESEARCH_KEY_REASONS,
  ...SOURCES_REASONS,
  ...SHARED_REASONS,
] as const;
export type SchedulerReason = (typeof SCHEDULER_REASONS)[number];
export const SCHEDULER_REASON_STATUS = {
  "last-run-succeeded": "ok",
  "run-in-flight": "ok",
  "never-run": "setup-needed",
  ...RUN_REASON_STATUS,
  "research-key-present": "ok",
  "research-key-missing": "setup-needed",
  "research-key-check-failed": "unknown",
  // No owner gesture has checked the key since the service started (ADR-0017 amendment, plan 08-07 A1).
  "research-key-not-checked": "unknown",
  "sources-configured": "ok",
  "sources-config-unusable": "degraded",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<SchedulerReason, SubsystemStatus>;

// -- App launchers -----------------------------------------------------------

/** `terminal` appears only for a custom terminal choice and is always last. */
export const LAUNCHER_PART_IDS = [
  "antigravity",
  "claude-code",
  "claude-desktop",
  "codex",
  "terminal",
] as const;
export type LauncherPartId = (typeof LAUNCHER_PART_IDS)[number];

const LAUNCHER_OWN_REASONS = [
  "launcher-ready",
  "launcher-not-set-up",
  "launcher-untested",
  "bundle-not-found",
  "executable-not-found",
  "terminal-not-found",
  "bundle-check-unavailable",
] as const;

/** Every launcher part may carry any launcher reason; the probe (08-08) decides which fits. */
export const LAUNCHERS_REASONS = [...LAUNCHER_OWN_REASONS, ...SHARED_REASONS] as const;
export type LaunchersReason = (typeof LAUNCHERS_REASONS)[number];
export const LAUNCHERS_REASON_STATUS = {
  "launcher-ready": "ok",
  "launcher-not-set-up": "setup-needed",
  "launcher-untested": "setup-needed",
  "bundle-not-found": "failing",
  "executable-not-found": "failing",
  "terminal-not-found": "failing",
  "bundle-check-unavailable": "unknown",
  ...SHARED_REASON_STATUS,
} as const satisfies Record<LaunchersReason, SubsystemStatus>;

function withoutOverlayReasons<const R extends readonly [string, ...string[]]>(
  reasons: R,
): readonly [Exclude<R[number], OverlayOnlyReason>, ...Exclude<R[number], OverlayOnlyReason>[]] {
  const overlay: readonly string[] = OVERLAY_ONLY_REASONS;
  return reasons.filter((reason) => !overlay.includes(reason)) as never;
}

/**
 * The reasons the service may send for each of its five rows: the full lists
 * above minus {@link OVERLAY_ONLY_REASONS}. The strict response schema is built
 * from these, so a response carrying a plugin-only reason is refused.
 */
export const SERVICE_SIDE_REASONS = {
  vault: withoutOverlayReasons(VAULT_REASONS),
  hooks: withoutOverlayReasons(HOOKS_REASONS),
  collectors: withoutOverlayReasons(COLLECTORS_REASONS),
  scheduler: withoutOverlayReasons(SCHEDULER_REASONS),
  launchers: withoutOverlayReasons(LAUNCHERS_REASONS),
} as const;

// ---------------------------------------------------------------------------
// Setup actions (closed, D-08, D-39): the service sends ids, the plugin owns the text

/** Existing owner-run scripts the plugin can copy. The service never sends command text. */
export const SETUP_COMMAND_IDS = [
  "claude-hooks-install",
  "codex-hooks-install",
  "codex-bridge-install",
  "research-key-setup",
] as const;
export type SetupCommandId = (typeof SETUP_COMMAND_IDS)[number];

/** The Settings destination's sections, in nav order (UI-SPEC S1); the ids are the deep-link keys. */
export const SETTINGS_SECTION_IDS = [
  "projects",
  "launchers",
  "integrations",
  "approvals-tasks",
  "paths",
  "visual",
  "security",
  "schedules",
  "diagnostics",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Existing plugin commands a setup action may run. Each carries its own confirm modal or gesture rule. */
export const SETUP_PLUGIN_COMMAND_IDS = ["vault-setup"] as const;

export const SetupActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("copy-command"), command: z.enum(SETUP_COMMAND_IDS) }),
  z.strictObject({
    kind: z.literal("go-to-section"),
    section: z.enum([...SETTINGS_SECTION_IDS, "research"]),
  }),
  z.strictObject({
    kind: z.literal("run-plugin-command"),
    command: z.enum(SETUP_PLUGIN_COMMAND_IDS),
  }),
]);
export type SetupAction = z.infer<typeof SetupActionSchema>;

// ---------------------------------------------------------------------------
// Typed values a reason sentence can interpolate (no free text)

const IsoInstantSchema = z.iso.datetime({ offset: true });

/**
 * A dotted version such as `0.1.0` or `2.1.5-beta.1`. Never free text (FIX2A F2): two to four numeric
 * components and, at most, one of the closed pre-release words `alpha`, `beta` or `rc` with an optional
 * numeric counter. Any other suffix, such as `0.1.0-SomeName`, is not a version. The diagnostic bundle
 * shares this one pattern.
 */
export const DOTTED_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$/;
const DottedVersionSchema = z.string().max(64).regex(DOTTED_VERSION_PATTERN, {
  message: "must be a dotted version",
});

/**
 * The only values a reason sentence may interpolate: versions, a count, an
 * instant and a threshold. A member that is not listed here cannot cross the
 * wire, so a path, a message or a log line has nowhere to go.
 */
export const HealthFactsSchema = z.strictObject({
  claudeVersion: DottedVersionSchema.exactOptional(),
  minimumVersion: DottedVersionSchema.exactOptional(),
  dropCount: z.int().nonnegative().exactOptional(),
  /** No longer produced (FIX2A F6, D-37a); kept optional so an older response still parses. */
  dropsSince: IsoInstantSchema.exactOptional(),
  /** When the newest dropped record was written (the dropped-records file's mtime), as a UTC instant. */
  lastDropAt: IsoInstantSchema.exactOptional(),
  silenceThresholdMs: z.int().positive().exactOptional(),
  sourceCount: z.int().nonnegative().exactOptional(),
  lastSuccessAt: IsoInstantSchema.exactOptional(),
  lastFailureAt: IsoInstantSchema.exactOptional(),
});
export type HealthFacts = z.infer<typeof HealthFactsSchema>;

// ---------------------------------------------------------------------------
// Rows and parts

interface StatusAndReason {
  readonly status: SubsystemStatus;
  readonly reasonCode: string;
}

interface PartLike extends StatusAndReason {
  readonly partId: string;
}

function statusMatchesReason(
  table: Readonly<Record<string, SubsystemStatus>>,
): (value: StatusAndReason) => boolean {
  return (value) => table[value.reasonCode] === value.status;
}

/** A part's status is its own reason's status and its reason must belong to that part. */
function partSchema<Id extends string, R extends readonly [string, ...string[]]>(
  partId: Id,
  reasons: R,
  table: Readonly<Record<string, SubsystemStatus>>,
) {
  return z
    .strictObject({
      partId: z.literal(partId),
      status: SubsystemStatusSchema,
      reasonCode: z.enum(reasons),
      setupAction: SetupActionSchema.exactOptional(),
      facts: HealthFactsSchema.exactOptional(),
    })
    .refine(statusMatchesReason(table), {
      message: "status must equal the status of the reason code",
      path: ["status"],
    });
}

/**
 * A row made of parts: the status is the roll-up of its parts (passive parts
 * excepted from the ok-versus-setup-needed decision, D-34a) and the reason is
 * the deciding part's. A row with no parts is accepted only when its reason is
 * a probe-did-not-finish code ({@link PROBE_REASONS}): the probe never produced
 * the parts, so the row says nothing but `unknown`. Any other reason would let
 * a row claim `ok` (or anything else) with no evidence (FIX1A M3).
 */
function rowWithPartsRefinement(passivePartIds: readonly string[]) {
  return (row: {
    status: SubsystemStatus;
    reasonCode: string;
    parts?: readonly PartLike[] | undefined;
  }): boolean => {
    const parts = row.parts;
    if (parts === undefined) return (PROBE_REASONS as readonly string[]).includes(row.reasonCode);
    if (row.status !== rollupPartStatuses(parts, passivePartIds)) return false;
    return parts.some((part) => part.status === row.status && part.reasonCode === row.reasonCode);
  };
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
      setupAction: SetupActionSchema.exactOptional(),
      facts: HealthFactsSchema.exactOptional(),
    })
    .refine(statusMatchesReason(table), {
      message: "status must equal the status of the reason code",
      path: ["status"],
    });
}

function serviceSideRowWithParts<
  Id extends string,
  R extends readonly [string, ...string[]],
  P extends z.ZodType<readonly PartLike[]>,
>(
  id: Id,
  reasons: R,
  table: Readonly<Record<string, SubsystemStatus>>,
  parts: P,
  passivePartIds: readonly string[] = [],
) {
  return z
    .strictObject({
      id: z.literal(id),
      status: SubsystemStatusSchema,
      reasonCode: z.enum(reasons),
      checkedAt: IsoInstantSchema,
      freshness: FreshnessSchema,
      parts: parts.exactOptional(),
      setupAction: SetupActionSchema.exactOptional(),
      facts: HealthFactsSchema.exactOptional(),
    })
    .refine(statusMatchesReason(table), {
      message: "status must equal the status of the reason code",
      path: ["status"],
    })
    .refine(rowWithPartsRefinement(passivePartIds), {
      message:
        "status must equal the roll-up of the parts and the reason must be a part's, or the probe did not finish",
      path: ["parts"],
    });
}

export const VaultRowSchema = serviceSideRow(
  "vault",
  SERVICE_SIDE_REASONS.vault,
  VAULT_REASON_STATUS,
);
export const HooksRowSchema = serviceSideRow(
  "hooks",
  SERVICE_SIDE_REASONS.hooks,
  HOOKS_REASON_STATUS,
);

const collectorPart = <Id extends CollectorsPartId>(id: Id) =>
  partSchema(id, COLLECTORS_PART_REASONS[id], COLLECTORS_REASON_STATUS);

/** The eight collectors parts, exactly, in the fixed order. */
export const CollectorsPartsSchema = z.tuple([
  collectorPart("telemetry"),
  collectorPart("status-line"),
  collectorPart("transcript-analysis"),
  collectorPart("spool"),
  collectorPart("codex-install"),
  collectorPart("codex-hooks"),
  collectorPart("codex-bridge"),
  collectorPart("codex-doctor"),
]);
export const CollectorsRowSchema = serviceSideRowWithParts(
  "collectors",
  SERVICE_SIDE_REASONS.collectors,
  COLLECTORS_REASON_STATUS,
  CollectorsPartsSchema,
  COLLECTORS_PASSIVE_PART_IDS,
);

const schedulerPart = <Id extends SchedulerPartId>(id: Id) =>
  partSchema(id, SCHEDULER_PART_REASONS[id], SCHEDULER_REASON_STATUS);

export const SchedulerPartsSchema = z.tuple([
  schedulerPart("last-run"),
  schedulerPart("research-key"),
  schedulerPart("sources"),
]);
export const SchedulerRowSchema = serviceSideRowWithParts(
  "scheduler",
  SERVICE_SIDE_REASONS.scheduler,
  SCHEDULER_REASON_STATUS,
  SchedulerPartsSchema,
  SCHEDULER_PASSIVE_PART_IDS,
);

const launcherPart = <Id extends LauncherPartId>(id: Id) =>
  partSchema(id, LAUNCHERS_REASONS, LAUNCHERS_REASON_STATUS);

/** Four launchers, or five when a custom terminal is chosen (always last). */
export const LauncherPartsSchema = z.union([
  z.tuple([
    launcherPart("antigravity"),
    launcherPart("claude-code"),
    launcherPart("claude-desktop"),
    launcherPart("codex"),
  ]),
  z.tuple([
    launcherPart("antigravity"),
    launcherPart("claude-code"),
    launcherPart("claude-desktop"),
    launcherPart("codex"),
    launcherPart("terminal"),
  ]),
]);
export const LaunchersRowSchema = serviceSideRowWithParts(
  "launchers",
  SERVICE_SIDE_REASONS.launchers,
  LAUNCHERS_REASON_STATUS,
  LauncherPartsSchema,
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

/**
 * The salted fingerprint of the managed vault path (D-36). Both sides hash the
 * input `salt + ":" + path` (the service with `node:crypto`, the plugin with
 * WebCrypto) and compare the first 16 lowercase hex characters of the SHA-256
 * digest; the path itself never crosses the wire and the fingerprint never
 * enters the bundle. The domain fixes the format only: hashing needs Node or
 * WebCrypto, which this Node-free file does not import.
 */
export const VaultFingerprintSchema = z
  .strictObject({
    salt: z.string().regex(/^[0-9a-f]{32}$/),
    digest: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .nullable();

const CountSchema = z.int().nonnegative().nullable();

export const DiagnosticsHealthResponseSchema = z.strictObject({
  generatedAt: IsoInstantSchema,
  service: z.strictObject({
    version: DottedVersionSchema,
    startedAt: IsoInstantSchema,
    /** Null when the schema-version table is empty or unreadable: never an invented number (08-07). */
    storeSchemaVersion: z.int().nonnegative().nullable(),
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
    vault: DisplayPathSchema.nullable(),
    runtimeDir: DisplayPathSchema,
    socket: DisplayPathSchema,
  }),
  vaultFingerprint: VaultFingerprintSchema,
  // `openTasks` follows the tasks list's actionable rule; `reports` counts RECORDED reports (the
  // store's research report records), not readable notes: a vault walk is not health-path work.
  counts: z.strictObject({
    projects: CountSchema,
    scanFolders: CountSchema,
    openTasks: CountSchema,
    reports: CountSchema,
  }),
});
export type DiagnosticsHealthResponse = z.infer<typeof DiagnosticsHealthResponseSchema>;
export type ServiceSideRow = DiagnosticsHealthResponse["rows"][number];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What a probe returns: a row without `checkedAt` and `freshness`, which the
 * service's probe runner adds (it knows whether this request ran the probe,
 * the single-flight cache answered, or the cap fired).
 */
export type ProbeOutcome = DistributiveOmit<ServiceSideRow, "checkedAt" | "freshness">;

/**
 * A service-side row as the plugin holds and shows it: either exactly what the
 * service sent, or a row the plugin itself produced with a plugin-only reason
 * ({@link OverlayOnlyReason}: the vault overlay, or a row cleared to
 * `service-not-running`). Only the first kind can cross the wire.
 */
export type DisplayedRow =
  | ServiceSideRow
  | (DistributiveOmit<ServiceSideRow, "reasonCode"> & { readonly reasonCode: OverlayOnlyReason });

// ---------------------------------------------------------------------------
// Health trigger (plan 08-07 Amendment A1)

/**
 * Why a health check was requested: `gesture` is an owner action (opening the
 * section, `Run checks again`) and is the only trigger allowed to spawn
 * `security`; `reconnect` is the automatic refetch after a reconnect and never
 * does. A missing or unrecognised value is treated as `reconnect` by the route.
 */
export const HealthTriggerSchema = z.enum(["gesture", "reconnect"]);
export type HealthTrigger = z.infer<typeof HealthTriggerSchema>;

// ---------------------------------------------------------------------------
// Errors (the plugin owns the copy; no body carries a message or a path)

export const DIAGNOSTICS_ERROR_CODES = [
  "service-disconnected",
  "timeout",
  "internal",
  "unrecognised-response",
] as const;
export type DiagnosticsErrorCode = (typeof DIAGNOSTICS_ERROR_CODES)[number];
export const DiagnosticsErrorCodeSchema = z.enum(DIAGNOSTICS_ERROR_CODES);

/** A closed code and nothing else. A body with another code or an extra key is not a diagnostics error. */
export const DiagnosticsErrorBodySchema = z.strictObject({ error: DiagnosticsErrorCodeSchema });
export type DiagnosticsErrorBody = z.infer<typeof DiagnosticsErrorBodySchema>;

// ---------------------------------------------------------------------------
// Display

/**
 * The single display map for a subsystem status (UI-SPEC "Vocabulary and
 * glyphs"): read by the Diagnostics view, the Security section's keychain rows
 * and the tests. Status is never colour alone: glyph, word and meaning.
 *
 * Plugin copy note (UI-SPEC R-note, for 08-13): the `ok` word for a reachable
 * but idle companion service is `Running` and for a Keychain presence chip is
 * `Present`; those are copy overrides in the plugin. This map stays at the five
 * words so the bundle and the tests share one vocabulary.
 */
export const SUBSYSTEM_STATUS_DISPLAY = {
  ok: { word: "Working", glyph: "✓", meaning: "Checked and behaving as expected." },
  "setup-needed": {
    word: "Needs setup",
    glyph: "⊕",
    meaning: "Not set up yet. Nothing is wrong; the next step is shown.",
  },
  degraded: {
    word: "Degraded",
    glyph: "▽",
    meaning: "Working, but with a problem that reduces what you see.",
  },
  failing: {
    word: "Failing",
    glyph: "✕",
    meaning: "Not working. The reason and the fix are shown.",
  },
  unknown: {
    word: "Unknown",
    glyph: "?",
    meaning: "Couldn't be checked, or no evidence yet. Never assumed working.",
  },
} as const satisfies Record<
  SubsystemStatus,
  { readonly word: string; readonly glyph: string; readonly meaning: string }
>;

/**
 * The static scope tag for Gmail, Google Calendar and GitHub (OD-2, D-48). It is
 * not a {@link SubsystemStatus}: those rows have no check time, no freshness and
 * no action, and are excluded from the summary and from the bundle.
 */
export const NOT_IN_VERSION_GLYPH = "∅";

// ---------------------------------------------------------------------------
// Summary

export interface RowSummary {
  readonly failing: number;
  readonly degraded: number;
  readonly unknown: number;
  readonly setupNeeded: number;
  readonly ok: number;
}

/**
 * Counts rows by status. Pure, so the Diagnostics view and the bundle call the
 * same code. A status that is not one of the five counts as `unknown`, never `ok`.
 */
export function summariseRows(rows: readonly { readonly status: SubsystemStatus }[]): RowSummary {
  let failing = 0;
  let degraded = 0;
  let unknown = 0;
  let setupNeeded = 0;
  let ok = 0;
  for (const row of rows) {
    const status = asKnownStatus(row.status);
    if (status === "failing") failing += 1;
    else if (status === "degraded") degraded += 1;
    else if (status === "unknown") unknown += 1;
    else if (status === "setup-needed") setupNeeded += 1;
    else ok += 1;
  }
  return { failing, degraded, unknown, setupNeeded, ok };
}
