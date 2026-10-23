import type { DiagnosticsHealthResponse, SubsystemStatus } from "@ccc/domain/diagnostics.js";
import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import {
  healthPhase,
  healthResponse,
  healthVaultCheck,
  refreshHealth,
  registerHealthView,
  rowsFor,
} from "../health/state.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import {
  NOT_IN_VERSION_HEADING,
  NOT_IN_VERSION_MARK,
  NOT_IN_VERSION_NAMES,
  NOT_IN_VERSION_SENTENCE,
  NOT_IN_VERSION_TAG,
  summaryFor,
} from "./diagnostics-copy.js";
import { HealthRow } from "./diagnostics-row.js";
import type { SettingsHost } from "./settings-host.js";

/**
 * The Diagnostics section of Settings (plan 08-13; D-01, D-03, D-05, D-43, DIAG-02, DIAG-03,
 * 08-UI-SPEC S3): six subsystem rows in a fixed order, each a status chip (glyph plus word), a
 * reason sentence, a detail line and `Checked {relative}` with a freshness badge, a summary, and
 * the three `Not part of this version` rows.
 *
 * Fetch triggers: the section opening (here, trigger `gesture`: an owner action), `Run checks
 * again` (also `gesture`) and a reconnect (the hook in `health/state.ts`, trigger `reconnect`).
 * Never a timer. The health state decides what the rows say; this file only draws them.
 *
 * Headings: `h3` Diagnostics, `h4` Subsystems and Not part of this version, `h5` row names (the
 * FIX2B classes). The destination's status line is the only live region; this section adds none
 * and posts every outcome through `notify`.
 */

export interface DiagnosticsSectionProps {
  readonly host: SettingsHost;
  readonly connection: ConnectionState;
  readonly now: number;
  /** Posts an outcome to the destination's one status line. */
  readonly notify: (message: string) => void;
}

function serviceDetailOf(
  live: boolean,
  response: DiagnosticsHealthResponse | null,
  now: number,
): string | null {
  if (!live || response === null) return null;
  return `Version ${response.service.version} · started ${formatRelativeTime(response.service.startedAt, now)}`;
}

function Summary({
  rows,
}: {
  readonly rows: readonly { readonly status: SubsystemStatus }[];
}): VNode {
  const { lead, chips } = summaryFor(rows);
  return (
    <p className="ccc-health-summary">
      <span>{lead}</span>
      {chips.map((chip) => (
        <span key={chip.status}>
          {" "}
          <span className="ccc-badge" data-status={chip.status}>
            <span className="ccc-badge-glyph" aria-hidden="true">
              {chip.glyph}
            </span>{" "}
            <span className="ccc-badge-label">{chip.text}</span>
          </span>
        </span>
      ))}
    </p>
  );
}

function NotInVersion(): VNode {
  return (
    <>
      <h4 className="ccc-settings-group-title">{NOT_IN_VERSION_HEADING}</h4>
      <ul className="ccc-health-list">
        {NOT_IN_VERSION_NAMES.map((name) => (
          <li key={name} className="ccc-health-row" data-scope="not-in-version">
            <div>
              <h5 className="ccc-settings-item-title">{name}</h5>
              <span className="ccc-badge" data-status="not-in-version">
                <span className="ccc-visually-hidden">Status: </span>
                <span className="ccc-badge-glyph" aria-hidden="true">
                  {NOT_IN_VERSION_MARK}
                </span>{" "}
                <span className="ccc-badge-label">{NOT_IN_VERSION_TAG}</span>
              </span>
            </div>
            <div>
              <p>{NOT_IN_VERSION_SENTENCE}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function DiagnosticsSection({
  host,
  connection,
  now,
  notify,
}: DiagnosticsSectionProps): VNode {
  const response = healthResponse.value;
  const phase = healthPhase.value;
  const vaultCheck = healthVaultCheck.value;
  const live = connection.kind === "live";
  const rows = rowsFor(connection, response, vaultCheck);
  // The first answer is still on its way: show the names and say nothing about the rows.
  const loading = live && response === null && phase !== "error";

  // Opening the section is an owner action, so this is the one fetch allowed to be a `gesture`.
  // The connection is read once, at mount: a service that comes up later is the reconnect hook's.
  const openedLive = useRef(live);
  useEffect(() => {
    const release = registerHealthView({ vaultBasePath: () => host.display.vaultBasePath });
    if (openedLive.current) {
      void refreshHealth("gesture", { vaultBasePath: host.display.vaultBasePath });
    }
    return release;
  }, [host]);

  return (
    <>
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Diagnostics
      </h3>
      <p>
        Whether each part of the command center is working, and what to do when it isn't. Checks
        only read; nothing is installed, launched or sent.
      </p>
      <button
        type="button"
        className="ccc-connect-button"
        data-variant="secondary"
        aria-label="Run checks again: re-run the read-only checks"
        onClick={() => {
          void refreshHealth("gesture", { vaultBasePath: host.display.vaultBasePath });
        }}
      >
        Run checks again
      </button>
      <div className="ccc-health">
        {loading ? <p className="ccc-health-summary" /> : <Summary rows={rows} />}
        <h4 className="ccc-settings-group-title">Subsystems</h4>
        <ul className="ccc-health-list">
          {rows.map((row) => (
            <HealthRow
              key={row.id}
              row={row}
              now={now}
              host={host}
              notify={notify}
              serviceDetail={row.id === "service" ? serviceDetailOf(live, response, now) : null}
              pending={loading}
            />
          ))}
        </ul>
        <NotInVersion />
      </div>
    </>
  );
}
