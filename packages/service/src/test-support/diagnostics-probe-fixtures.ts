import type { ClaudeIntegrationStatus, CodexIntegrationStatus, ProbeOutcome } from "@ccc/domain";
import {
  CollectorsRowSchema,
  HooksRowSchema,
  LaunchersRowSchema,
  SchedulerRowSchema,
  VaultRowSchema,
} from "@ccc/domain";

/**
 * Fixtures for the diagnostics probe tests (plan 08-08): integration statuses as the usage and
 * Codex services report them, and a check that a probe's outcome is a row the strict domain schema
 * accepts once the runner adds the check time and the freshness. Test support only; every value is
 * invented.
 */

/** A fresh Claude install: nothing installed, analysis off, nothing dropped. */
export function claudeStatus(
  overrides: Partial<ClaudeIntegrationStatus> = {},
): ClaudeIntegrationStatus {
  return {
    hooks: "not-installed",
    hookRuntimeMissing: false,
    disableAllHooks: null,
    lastEventAt: null,
    telemetry: { kind: "ok" },
    detectedClaudeVersion: null,
    statusLine: "not-installed",
    statusLineReported: false,
    transcriptAnalysis: { enabled: false },
    spoolDropCount: 0,
    unknownEventCount: 0,
    cleanupPeriodDays: 30,
    ...overrides,
  };
}

/** A fresh Codex view: nothing installed, no doctor run. */
export function codexStatus(
  overrides: {
    hooks?: Partial<CodexIntegrationStatus["hooks"]>;
    bridge?: Partial<CodexIntegrationStatus["bridge"]>;
    codex?: Partial<CodexIntegrationStatus["codex"]>;
    doctor?: CodexIntegrationStatus["doctor"];
  } = {},
): CodexIntegrationStatus {
  return {
    hooks: { state: "not-installed", lastEventAt: null, installedSince: null, ...overrides.hooks },
    bridge: { state: "not-installed", lastWindowAt: null, ...overrides.bridge },
    codex: { installed: false, version: null, ...overrides.codex },
    doctor: overrides.doctor === undefined ? null : overrides.doctor,
  };
}

const CHECKED_AT = "2026-10-22T09:00:00.000Z";

const ROW_SCHEMAS = {
  vault: VaultRowSchema,
  hooks: HooksRowSchema,
  collectors: CollectorsRowSchema,
  scheduler: SchedulerRowSchema,
  launchers: LaunchersRowSchema,
} as const;

/**
 * Asserts nothing itself: returns whether the outcome, with a check time and `live` freshness
 * added the way the runner does, is a row the strict schema for its subsystem accepts. Tests call
 * `expect(isValidRow(outcome)).toBe(true)`, so a refusal shows the outcome in the failure.
 */
export function isValidRow(outcome: ProbeOutcome): boolean {
  const row = { ...outcome, checkedAt: CHECKED_AT, freshness: "live" };
  return (ROW_SCHEMAS[outcome.id] as { safeParse(input: unknown): { success: boolean } }).safeParse(
    row,
  ).success;
}

/** The parts of a row-with-parts outcome, typed loosely for assertions. */
export function partsOf(
  outcome: ProbeOutcome,
): readonly { partId: string; status: string; reasonCode: string; [key: string]: unknown }[] {
  const parts = (outcome as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) throw new Error("the outcome carries no parts");
  return parts as never;
}
