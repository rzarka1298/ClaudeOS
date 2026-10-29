import { MIN_SUPPORTED_CLAUDE_VERSION } from "@ccc/collectors";
import type { ApprovalPresenceReason, ResearchStatusResponse } from "@ccc/domain";
import type { PinObservation, PresenceInspection } from "./approval-wiring/presence.js";
import type { UsageServices } from "./claude/usage-services.js";
import type { CodexIntegrationService } from "./codex/integration-routes.js";
import type {
  ApprovalPresenceCheck,
  ApprovalPresencePort,
} from "./diagnostics/approval-presence.js";
import type { CollectorsProbePorts } from "./diagnostics/collectors-probe.js";
import { type CountDb, readHealthCounts } from "./diagnostics/counts.js";
import type { HooksProbePorts } from "./diagnostics/hooks-probe.js";
import type { LauncherRow, LaunchersProbePorts } from "./diagnostics/launchers-probe.js";
import { createKeyPresenceCheck, type SchedulerProbePorts } from "./diagnostics/scheduler-probe.js";
import type { DiagnosticsPorts } from "./diagnostics/services.js";
import type { BundleProbeResult } from "./projects/detection.js";
import type { ResearchRouteResult } from "./research/types.js";

/**
 * The diagnostics composition (plan 08-12; D-04, D-05, D-38, D-49; T-08-30, T-08-30b, T-08-31).
 *
 * `main.ts` hands this the real service objects, each already narrowed to the one thing a probe
 * may ask of it, and gets back the read-only PORT SETS the diagnostics services turn into probes.
 * It lives next to `main.ts`, outside `src/diagnostics/`, because that folder may import nothing
 * from the rest of the service (rule 18); the process-backed ports (the bundle lookup through the
 * fixed-argv command runner, the Keychain presence check) are built by the composition root and
 * arrive here as plain functions.
 *
 * What a probe can reach, by construction:
 * - hooks and collectors: one asynchronous re-read of Claude's settings facts (with the probe's own
 *   signal), the dropped-records file's size and mtime, the CACHED Codex status (a `status()` read:
 *   no refresh, no doctor, no event), a version string and a clock;
 * - scheduler: the cached research status (null while the research services are not bound), the
 *   research key presence and a boolean;
 * - launchers: the saved launcher rows, the bounded bundle lookup and a regular-file-and-execute check.
 * No member launches, installs, writes, spawns or fetches. The research key presence closure uses the
 * resolved account the research pipeline itself reads (`researchKeyAccount`, one variable in
 * `main.ts`), never a literal, and is skipped entirely when the guarded test transport replaces the
 * key. Whether it runs at all is the services' decision, by trigger (Amendment A1).
 */

export interface DiagnosticsWiringDeps {
  /** Only the two reads the health path needs; both are asynchronous (FIX2A F1). */
  readonly usage: Pick<UsageServices, "refreshSettingsFacts" | "spoolFacts">;
  /** The cached Codex status. Absent: the collectors row stays `subsystem-not-wired`. */
  readonly codexIntegration: Pick<CodexIntegrationService, "status"> | undefined;
  /** The research status as the route answers it; a closed error until the research services are bound. */
  readonly research: { status(): ResearchRouteResult<ResearchStatusResponse> };
  /** The account the research pipeline reads its key from (the guarded override account, else the default). */
  readonly researchKeyAccount: string;
  /**
   * The attribute-only Keychain presence check (`@ccc/keychain`'s `hasSecret`): spawns the absolute
   * `/usr/bin/security` with fixed argv, never reads the value, and kills the child when `signal` fires.
   */
  readonly hasSecret: (
    account: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<"present" | "absent" | "error">;
  /** True when the guarded test transport replaces the key (the key is then never consulted). */
  readonly overrideTransportActive: boolean;
  readonly listLauncherConfigs: () => readonly LauncherRow[];
  /** The bounded one-`mdfind`-plus-`plutil` lookup (`Detector#probeBundle`). */
  readonly probeBundle: (
    bundleId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<BundleProbeResult>;
  /** A regular file with the execute bit, through `node:fs/promises`. */
  readonly isExecutableFile: (path: string) => Promise<boolean>;
  /** Whether the service's own startup read of the install secret found it (it cannot answer without). */
  readonly installSecretPresent: boolean;
  /**
   * The approval presence port (09-19, D-04), built by {@link createApprovalPresenceDiagnosticsPort}. Absent:
   * the health response carries no `approvalPresence` member.
   */
  readonly approvalPresence?: ApprovalPresencePort | undefined;
  readonly db: CountDb;
  readonly now: () => Date;
}

export type DiagnosticsPortSets = Pick<
  DiagnosticsPorts,
  | "hooksPorts"
  | "collectorsPorts"
  | "schedulerPorts"
  | "launchersPorts"
  | "keychain"
  | "counts"
  | "approvalPresence"
>;

export function createDiagnosticsPortSets(deps: DiagnosticsWiringDeps): DiagnosticsPortSets {
  const { usage, now } = deps;

  const hooksPorts: HooksProbePorts = {
    refreshSettingsFacts: (signal) => usage.refreshSettingsFacts(signal),
    now,
  };

  const codex = deps.codexIntegration;
  const collectorsPorts: CollectorsProbePorts | undefined =
    codex === undefined
      ? undefined
      : {
          integration: (signal) => usage.refreshSettingsFacts(signal),
          spoolFacts: () => usage.spoolFacts(),
          codexStatus: { status: () => codex.status() },
          minimumClaudeVersion: MIN_SUPPORTED_CLAUDE_VERSION,
          now,
        };

  // Built next to nothing else: the account is the one the pipeline reads, and the presence check
  // asks about that account only.
  const hasResearchKey = (signal: AbortSignal): Promise<"present" | "absent" | "error"> =>
    deps.hasSecret(deps.researchKeyAccount, { signal });
  const schedulerPorts: SchedulerProbePorts = {
    status: () => {
      const answer = deps.research.status();
      return answer.ok ? answer.value : null;
    },
    keyPresence: createKeyPresenceCheck({ hasResearchKey }),
    overrideTransportActive: deps.overrideTransportActive,
  };

  const launchersPorts: LaunchersProbePorts = {
    listConfigs: deps.listLauncherConfigs,
    probeBundle: (bundleId, options) => deps.probeBundle(bundleId, options),
    isExecutableFile: deps.isExecutableFile,
  };

  return {
    hooksPorts,
    collectorsPorts,
    schedulerPorts,
    launchersPorts,
    keychain: { installSecret: deps.installSecretPresent ? "present" : "unknown" },
    counts: () => readHealthCounts(deps.db),
    ...(deps.approvalPresence === undefined ? {} : { approvalPresence: deps.approvalPresence }),
  };
}

export interface ApprovalPresenceDiagnosticsDeps {
  /** True under any test or sandbox environment (`CCC_INSTALL_SECRET_ACCOUNT` set): nothing is started or read. */
  readonly sandbox: boolean;
  /** Whether the built helper exists at its absolute path; a file-existence check, never a spawn. */
  readonly helperPresent: () => boolean;
  /** The helper port's non-prompting `check`, with the closed reason when unavailable. */
  readonly inspect: () => Promise<PresenceInspection>;
  /** The GUARDED pin reader: an attribute-only Keychain read that also records the trust verdict. */
  readonly readPin: () => Promise<string | null>;
  /** The conclusion of the most recent guarded read (set by the guard's `observe`), or null. */
  readonly lastPinObservation: () => PinObservation | null;
  /** Forgets the last conclusion, so the read this check makes is the one it reports. */
  readonly clearPinObservation?: (() => void) | undefined;
}

const CHECK_FAILED: ApprovalPresenceCheck = {
  state: "unavailable",
  reason: "check-failed",
  fingerprint: null,
};

/** The reasons for which the helper's own check already settled the answer: no pin read is needed. */
const SETTLED_BY_HELPER: readonly ApprovalPresenceReason[] = [
  "helper-missing",
  "cannot-evaluate",
  "check-failed",
];

/**
 * The port Diagnostics asks whether connector-class approvals can ask for the owner's presence (09-19, D-04,
 * T-09-42, T-09-43). It lives here, outside `src/diagnostics/`, because it reaches the helper and the Keychain
 * (rule 18); the services call it only on an owner gesture and keep its answer for a reconnect.
 *
 * It folds two reads into one closed answer: the helper's non-prompting `check` and the guarded, attribute-only
 * pin read. `available` needs BOTH: the helper says it can evaluate and holds a current key, and the service
 * can read a pin it trusts (`trusted` or `adopted`). A pin the guard refused (`changed`) is `unavailable` with
 * `pin-changed` whatever the helper says, and the fingerprint shown is that of the pin now in the Keychain, so
 * the owner can compare it across installs. A pin the service cannot read, or an observation the guard did not
 * make, is `check-failed`: never `available`, never invented.
 */
export function createApprovalPresenceDiagnosticsPort(
  deps: ApprovalPresenceDiagnosticsDeps,
): ApprovalPresencePort {
  return {
    precheck() {
      if (deps.sandbox) return "sandbox";
      return deps.helperPresent() ? null : "helper-missing";
    },
    async check(signal) {
      if (deps.sandbox) return { state: "unavailable", reason: "sandbox", fingerprint: null };
      if (!deps.helperPresent()) {
        return { state: "unavailable", reason: "helper-missing", fingerprint: null };
      }
      let inspection: PresenceInspection;
      try {
        inspection = await deps.inspect();
      } catch {
        return CHECK_FAILED;
      }
      if (signal.aborted) return CHECK_FAILED;
      if (inspection.reason !== null && SETTLED_BY_HELPER.includes(inspection.reason)) {
        return { state: "unavailable", reason: inspection.reason, fingerprint: null };
      }
      deps.clearPinObservation?.();
      try {
        await deps.readPin();
      } catch {
        return CHECK_FAILED;
      }
      if (signal.aborted) return CHECK_FAILED;
      const observed = deps.lastPinObservation();
      if (observed === null) return CHECK_FAILED;
      if (observed.verdict === "changed") {
        return { state: "unavailable", reason: "pin-changed", fingerprint: observed.fingerprint };
      }
      if (inspection.state === "unavailable") {
        return {
          state: "unavailable",
          reason: inspection.reason ?? "check-failed",
          fingerprint: observed.fingerprint,
        };
      }
      if (observed.verdict === "none") return CHECK_FAILED;
      return { state: "available", reason: null, fingerprint: observed.fingerprint };
    },
  };
}
