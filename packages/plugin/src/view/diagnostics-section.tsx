import type { Freshness } from "@ccc/domain";
import type { VNode } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import {
  healthPhase,
  healthResponse,
  refreshHealth,
  registerHealthView,
  rowsFor,
  type ShownRow,
} from "../health/state.js";
import { FRESHNESS_GLYPH } from "../widgets/footer.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import { chipFor, ROW_NAMES, reasonText } from "./diagnostics-copy.js";
import type { SettingsHost } from "./settings-host.js";

/**
 * The Diagnostics section of Settings (plan 08-13; D-01, D-03, D-05, D-43, DIAG-02, DIAG-03,
 * 08-UI-SPEC S3): six subsystem rows in a fixed order, each a status chip (glyph plus word), a
 * reason sentence, a detail line and `Checked {relative}` with a freshness badge.
 *
 * Fetch triggers: the section opening (here, trigger `gesture`: an owner action), `Run checks
 * again` (also `gesture`) and a reconnect (the hook in `health/state.ts`, trigger `reconnect`).
 * Never a timer. The health state decides what the rows say; this file only draws them.
 *
 * Headings: `h3` Diagnostics, `h4` Subsystems, `h5` row names (FIX2B classes). The destination's
 * status line is the only live region; this section adds none and posts every outcome through
 * `notify`.
 */

export interface DiagnosticsSectionProps {
  readonly host: SettingsHost;
  readonly connection: ConnectionState;
  readonly now: number;
  /** Posts an outcome to the destination's one status line. */
  readonly notify: (message: string) => void;
}

const FRESHNESS_LABEL: Readonly<Record<Freshness, string>> = {
  live: "Live",
  cached: "Cached",
  stale: "Stale",
  unavailable: "Unavailable",
};

function StatusChip({ row }: { readonly row: ShownRow }): VNode {
  const { glyph, word } = chipFor(row.status, row.id);
  return (
    <span className="ccc-badge" data-status={row.status}>
      <span className="ccc-visually-hidden">Status: </span>
      <span className="ccc-badge-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="ccc-badge-label">{word}</span>
    </span>
  );
}

function FreshnessBadge({ freshness }: { readonly freshness: Freshness }): VNode {
  return (
    <span className="ccc-badge" data-badge={freshness}>
      <span className="ccc-badge-glyph" aria-hidden="true">
        {FRESHNESS_GLYPH[freshness]}
      </span>
      <span className="ccc-visually-hidden">Freshness: </span>
      <span className="ccc-badge-label">{FRESHNESS_LABEL[freshness]}</span>
    </span>
  );
}

/** `Checked {relative}` with the absolute time in `title` and a hidden description, then the badge. */
function RowMeta({ row, now }: { readonly row: ShownRow; readonly now: number }): VNode {
  const absoluteId = useId();
  if (row.checkedAt === null) {
    return (
      <p className="ccc-health-meta">
        <span>Not checked</span> <FreshnessBadge freshness={row.freshness} />
      </p>
    );
  }
  const absolute = formatAbsoluteTime(row.checkedAt);
  return (
    <p className="ccc-health-meta">
      <span>Checked </span>
      <time dateTime={row.checkedAt} title={absolute} aria-describedby={absoluteId}>
        {formatRelativeTime(row.checkedAt, now)}
      </time>
      <span id={absoluteId} className="ccc-visually-hidden">
        {absolute}
      </span>{" "}
      <FreshnessBadge freshness={row.freshness} />
    </p>
  );
}

function HealthRow({
  row,
  now,
  detail,
  pending,
}: {
  readonly row: ShownRow;
  readonly now: number;
  readonly detail: string | null;
  /** The first answer is still on its way: the name shows, nothing is claimed about the row. */
  readonly pending: boolean;
}): VNode {
  const facts = "facts" in row ? row.facts : undefined;
  const { reason } = reasonText(row.reasonCode, { facts, now });
  if (pending && row.id !== "service") {
    return (
      <li className="ccc-health-row" data-subsystem={row.id}>
        <div>
          <h5 className="ccc-settings-item-title">{ROW_NAMES[row.id]}</h5>
        </div>
        <div />
      </li>
    );
  }
  return (
    <li className="ccc-health-row" data-status={row.status} data-subsystem={row.id}>
      <div>
        <h5 className="ccc-settings-item-title">{ROW_NAMES[row.id]}</h5>
        <StatusChip row={row} />
      </div>
      <div>
        <p>{reason}</p>
        {detail !== null && <p className="ccc-health-detail">{detail}</p>}
        <RowMeta row={row} now={now} />
      </div>
    </li>
  );
}

function serviceDetail(
  row: ShownRow,
  response: ReturnType<typeof healthResponse.peek>,
  now: number,
): string | null {
  if (row.id !== "service" || row.reasonCode !== "service-live" || response === null) return null;
  return `Version ${response.service.version} · started ${formatRelativeTime(response.service.startedAt, now)}`;
}

export function DiagnosticsSection({ host, connection, now }: DiagnosticsSectionProps): VNode {
  const response = healthResponse.value;
  const phase = healthPhase.value;
  const live = connection.kind === "live";
  const rows = rowsFor(connection, response);
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
        <p className="ccc-health-summary" />
        <h4 className="ccc-settings-group-title">Subsystems</h4>
        <ul className="ccc-health-list">
          {rows.map((row) => (
            <HealthRow
              key={row.id}
              row={row}
              now={now}
              detail={loading ? null : serviceDetail(row, response, now)}
              pending={loading}
            />
          ))}
        </ul>
      </div>
    </>
  );
}
