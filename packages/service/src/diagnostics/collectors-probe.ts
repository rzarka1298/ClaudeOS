import {
  type ClaudeIntegrationStatus,
  COLLECTORS_PASSIVE_PART_IDS,
  COLLECTORS_REASON_STATUS,
  type CodexIntegrationStatus,
  type ProbeOutcome,
  type SetupAction,
} from "@ccc/domain";
import {
  bounded,
  dottedVersion,
  isoInstant,
  noAnswer,
  type Part,
  partOf,
  rowOfParts,
} from "./probe-kit.js";

/**
 * The usage collectors row (plan 08-08; D-04, D-37, D-41; T-08-19, T-08-21): the same Claude
 * integration status as the hooks row, split into telemetry, status line, transcript analysis and
 * dropped-record parts, plus the four Codex parts (install, hooks, bridge, doctor) read from the
 * Codex status the Codex services already cache. Codex is parts of this row, not a seventh
 * subsystem.
 *
 * Read-only by construction. The Codex port exposes only a `status()` read: there is no refresh
 * (which would publish events), no doctor (the owner runs it; its 60 s cap exceeds this probe's
 * 2 s) and nothing that starts a process. No part returns a path, a Codex version, a doctor check
 * id or a timestamp; versions appear only as dotted facts and the spool only as a count and the
 * instant it was first seen in this service process.
 */

export interface SpoolObservation {
  readonly count: number;
  /** True when this count is higher than the previous observation in this process. */
  readonly rose: boolean;
  /** The instant a non-zero count was first seen in this process, or null while none has been. */
  readonly since: string | null;
}

/**
 * Remembers the dropped-record count between probes (D-37). The count is the size of a file
 * nothing ever clears, so "any drop ever" would read `degraded` forever; instead a drop is news
 * only when the count rose since the previous probe in this service process. The first observation
 * is the baseline (a historic file is not a fresh drop). Memory only: a restart starts over.
 */
export interface SpoolDropTracker {
  observe(count: number, at: Date): SpoolObservation;
}

export function createSpoolDropTracker(): SpoolDropTracker {
  let previous: number | null = null;
  let since: string | null = null;
  return {
    observe(count, at) {
      const rose = previous !== null && count > previous;
      if (count > 0 && since === null) since = isoInstant(at) ?? null;
      previous = count;
      return { count, rose, since };
    },
  };
}

export interface CollectorsProbePorts {
  /** Re-reads Claude's settings facts and answers the status (the same read the hooks probe uses). */
  readonly integration: () => ClaudeIntegrationStatus;
  /** The cached Codex integration status. Only this read exists on the port. */
  readonly codexStatus: { status(): CodexIntegrationStatus };
  readonly spoolTracker: SpoolDropTracker;
  /** The oldest Claude Code version the usage tracking supports, as a dotted string. */
  readonly minimumClaudeVersion: string;
  readonly now: () => Date;
}

const TABLE = COLLECTORS_REASON_STATUS;
const CLAUDE_INSTALL: SetupAction = { kind: "copy-command", command: "claude-hooks-install" };
const GO_SECURITY: SetupAction = { kind: "go-to-section", section: "security" };
const GO_INTEGRATIONS: SetupAction = { kind: "go-to-section", section: "integrations" };

function telemetryPart(status: ClaudeIntegrationStatus, minimum: string): Part {
  switch (status.telemetry.kind) {
    case "ok":
      return partOf(TABLE, "telemetry", "telemetry-ok");
    case "shape-changed":
      return partOf(TABLE, "telemetry", "telemetry-shape-changed");
    case "unsupported-version": {
      const claudeVersion = dottedVersion(status.telemetry.version);
      const minimumVersion = dottedVersion(minimum);
      return partOf(TABLE, "telemetry", "telemetry-unsupported-version", {
        facts: {
          ...(claudeVersion === undefined ? {} : { claudeVersion }),
          ...(minimumVersion === undefined ? {} : { minimumVersion }),
        },
      });
    }
  }
}

function statusLinePart(status: ClaudeIntegrationStatus): Part {
  if (status.statusLine === "unknown") {
    return partOf(TABLE, "status-line", "statusline-state-unreadable");
  }
  if (status.statusLine === "not-installed") {
    return partOf(TABLE, "status-line", "statusline-not-installed", {
      setupAction: CLAUDE_INSTALL,
    });
  }
  return partOf(
    TABLE,
    "status-line",
    status.statusLineReported ? "statusline-reporting" : "statusline-awaiting-report",
  );
}

function transcriptPart(status: ClaudeIntegrationStatus): Part {
  return status.transcriptAnalysis.enabled
    ? partOf(TABLE, "transcript-analysis", "analysis-on")
    : partOf(TABLE, "transcript-analysis", "analysis-off", { setupAction: GO_SECURITY });
}

function spoolPart(observation: SpoolObservation): Part {
  if (observation.count === 0) return partOf(TABLE, "spool", "spool-clean");
  // A count kept as a fact whether or not it just rose; only a rise is news (D-37).
  const facts = {
    dropCount: observation.count,
    ...(observation.since === null ? {} : { dropsSince: observation.since }),
  };
  return partOf(TABLE, "spool", observation.rose ? "spool-dropped-records" : "spool-clean", {
    facts,
  });
}

function codexParts(codex: CodexIntegrationStatus): Part[] {
  const install = codex.codex.installed
    ? partOf(TABLE, "codex-install", "codex-installed")
    : partOf(TABLE, "codex-install", "codex-not-installed");

  const hooksReason = {
    installed: "codex-hooks-receiving",
    "installed-no-events": "codex-hooks-no-events",
    "not-installed": "codex-hooks-not-installed",
    unknown: "codex-hooks-state-unreadable",
  } as const;
  const hooksState = codex.hooks.state;
  const hooks = partOf(
    TABLE,
    "codex-hooks",
    hooksReason[hooksState],
    hooksState === "not-installed"
      ? { setupAction: { kind: "copy-command", command: "codex-hooks-install" } }
      : {},
  );

  const bridgeReason = {
    installed: "codex-bridge-ready",
    "installed-idle": "codex-bridge-ready",
    "not-installed": "codex-bridge-not-installed",
    outdated: "codex-bridge-outdated",
    "different-folder": "codex-bridge-different-folder",
  } as const;
  const bridgeState = codex.bridge.state;
  const bridgeReady = bridgeState === "installed" || bridgeState === "installed-idle";
  const bridge = partOf(
    TABLE,
    "codex-bridge",
    bridgeReason[bridgeState],
    bridgeReady ? {} : { setupAction: { kind: "copy-command", command: "codex-bridge-install" } },
  );

  const doctorReason = {
    ok: "codex-doctor-ok",
    warning: "codex-doctor-warning",
    fail: "codex-doctor-failed",
    unrecognised: "codex-doctor-unrecognised",
  } as const;
  const doctor =
    codex.doctor === null
      ? partOf(TABLE, "codex-doctor", "codex-doctor-not-run", { setupAction: GO_INTEGRATIONS })
      : partOf(
          TABLE,
          "codex-doctor",
          doctorReason[codex.doctor.overall],
          codex.doctor.overall === "warning" || codex.doctor.overall === "fail"
            ? { setupAction: GO_INTEGRATIONS }
            : {},
        );

  return [install, hooks, bridge, doctor];
}

export async function probeCollectors(
  ports: CollectorsProbePorts,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const claude = await bounded(signal, () => ports.integration());
  if (claude.kind === "timeout") return noAnswer("collectors", "probe-timeout");
  if (claude.kind === "error") return noAnswer("collectors", "probe-error");
  const codex = await bounded(signal, () => ports.codexStatus.status());
  if (codex.kind === "timeout") return noAnswer("collectors", "probe-timeout");
  if (codex.kind === "error") return noAnswer("collectors", "probe-error");

  const status = claude.value;
  const observation = ports.spoolTracker.observe(status.spoolDropCount, ports.now());
  const parts: Part[] = [
    telemetryPart(status, ports.minimumClaudeVersion),
    statusLinePart(status),
    transcriptPart(status),
    spoolPart(observation),
    ...codexParts(codex.value),
  ];
  return rowOfParts("collectors", parts, COLLECTORS_PASSIVE_PART_IDS);
}
