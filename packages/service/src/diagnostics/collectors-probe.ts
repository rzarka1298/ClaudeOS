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
 * instant the dropped-records file was last written.
 */

/**
 * The dropped-records file as a fact (FIX2A F6, D-37a): its byte count and the instant it was last
 * written, as a UTC instant (null when the file is absent, empty or has no usable time). It comes from
 * the file's size and mtime, so it does not depend on when this service started or on any earlier
 * probe.
 */
export interface SpoolFacts {
  readonly count: number;
  readonly lastDropAt: string | null;
}

/** A drop counts as news for this long after the file was last written (D-37a). */
export const SPOOL_DROP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CollectorsProbePorts {
  /**
   * Re-reads Claude's settings facts and answers the status (the same read the hooks probe uses).
   * Asynchronous since FIX2A F1: it receives the probe's signal and must make no synchronous
   * file-system call.
   */
  readonly integration: (signal: AbortSignal) => Promise<ClaudeIntegrationStatus>;
  /** The dropped-records file's count and last-write instant, read asynchronously (FIX2A F6). */
  readonly spoolFacts: (signal: AbortSignal) => Promise<SpoolFacts>;
  /** The cached Codex integration status. Only this read exists on the port. */
  readonly codexStatus: { status(): CodexIntegrationStatus };
  /** The oldest Claude Code version the usage tracking supports, as a dotted string. */
  readonly minimumClaudeVersion: string;
  readonly now: () => Date;
}

const TABLE = COLLECTORS_REASON_STATUS;
const CLAUDE_INSTALL: SetupAction = { kind: "copy-command", command: "claude-hooks-install" };
const GO_SECURITY: SetupAction = { kind: "go-to-section", section: "security" };
// `Check Codex health` lives in the launchers section (D-44), so the doctor reasons send the owner
// there; the plugin shows the action as sent (FIX3A MINOR-7).
const GO_LAUNCHERS: SetupAction = { kind: "go-to-section", section: "launchers" };

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

/**
 * The spool part (D-37a). Stateless: `degraded` while the dropped-records file is non-empty AND was
 * written within the last 24 hours, otherwise `ok` with the count kept as a fact. No first-seen
 * baseline, no trigger: drops made while the service was down read degraded on the first probe, a
 * reconnect consumes nothing, and a day-old drop stops being news without anyone clearing the file.
 * A time in the future (clock skew) counts as recent, so a drop is never hidden by it.
 */
function spoolPart(facts: SpoolFacts, now: Date): Part {
  if (facts.count === 0) return partOf(TABLE, "spool", "spool-clean");
  const lastDropAt = facts.lastDropAt === null ? undefined : isoInstant(new Date(facts.lastDropAt));
  const recent =
    lastDropAt !== undefined && now.getTime() - Date.parse(lastDropAt) <= SPOOL_DROP_WINDOW_MS;
  return partOf(TABLE, "spool", recent ? "spool-dropped-records" : "spool-clean", {
    facts: { dropCount: facts.count, ...(lastDropAt === undefined ? {} : { lastDropAt }) },
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
      ? partOf(TABLE, "codex-doctor", "codex-doctor-not-run", { setupAction: GO_LAUNCHERS })
      : partOf(
          TABLE,
          "codex-doctor",
          doctorReason[codex.doctor.overall],
          codex.doctor.overall === "warning" || codex.doctor.overall === "fail"
            ? { setupAction: GO_LAUNCHERS }
            : {},
        );

  return [install, hooks, bridge, doctor];
}

export async function probeCollectors(
  ports: CollectorsProbePorts,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  const claude = await bounded(signal, () => ports.integration(signal));
  if (claude.kind === "timeout") return noAnswer("collectors", "probe-timeout");
  if (claude.kind === "error") return noAnswer("collectors", "probe-error");
  const codex = await bounded(signal, () => ports.codexStatus.status());
  if (codex.kind === "timeout") return noAnswer("collectors", "probe-timeout");
  if (codex.kind === "error") return noAnswer("collectors", "probe-error");
  const spool = await bounded(signal, () => ports.spoolFacts(signal));
  if (spool.kind === "timeout") return noAnswer("collectors", "probe-timeout");

  const status = claude.value;
  const parts: Part[] = [
    telemetryPart(status, ports.minimumClaudeVersion),
    statusLinePart(status),
    transcriptPart(status),
    spool.kind === "error"
      ? partOf(TABLE, "spool", "probe-error")
      : spoolPart(spool.value, ports.now()),
    ...codexParts(codex.value),
  ];
  return rowOfParts("collectors", parts, COLLECTORS_PASSIVE_PART_IDS);
}
