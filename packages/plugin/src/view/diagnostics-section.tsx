import type { DiagnosticsHealthResponse, SubsystemStatus } from "@ccc/domain/diagnostics.js";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useId, useLayoutEffect, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import {
  anyStale,
  healthPhase,
  healthResponse,
  healthVaultCheck,
  refreshHealth,
  registerHealthView,
  rowsFor,
} from "../health/state.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import {
  CHECKING_LINE,
  checkedLine,
  DESCRIPTION,
  ERROR_FOLLOW_UP,
  ERROR_HEADING,
  LOADING_TEXT,
  NOT_IN_VERSION_HEADING,
  NOT_IN_VERSION_MARK,
  NOT_IN_VERSION_NAMES,
  NOT_IN_VERSION_SENTENCE,
  NOT_IN_VERSION_TAG,
  RUN_CHECKS_LABEL,
  RUN_CHECKS_NAME,
  STALE_LINE,
  summaryFor,
} from "./diagnostics-copy.js";
import { HealthRow } from "./diagnostics-row.js";
import { SERVICE_AWAY_REASON } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";
import { useActionGate } from "./settings-pending.js";

/**
 * The Diagnostics section of Settings (plan 08-13; D-01, D-03, D-05, D-43, DIAG-02, DIAG-03,
 * 08-UI-SPEC S3): six subsystem rows in a fixed order, each a status chip (glyph plus word), a
 * reason sentence, a detail line and `Checked {relative}` with a freshness badge, a summary, and
 * the three `Not part of this version` rows.
 *
 * Fetch triggers: the section opening (here, trigger `gesture`: an owner action), `Run checks
 * again` (also `gesture`) and a reconnect (the hook in `health/state.ts`, trigger `reconnect`).
 * Never a timer: staleness is derived from the shared clock tick the destination passes as `now`.
 * The health state decides what the rows say; this file only draws them.
 *
 * States (UI-SPEC G10, G11): loading (names at once, skeleton chips, reasons and meta, the list
 * `aria-busy`), populated, stale (a badge on every row and one line), probe timeout (a row is
 * unknown), a failed request (`Couldn't run the checks.`, rows cleared) and disconnected (the
 * service row failing, every other row cleared with no last-good value).
 *
 * Headings: `h3` Diagnostics, `h4` Subsystems and Not part of this version, `h5` row names (the
 * FIX2B classes). The destination's status line is the only live region; this section adds none
 * and posts every outcome through `notify`. Nothing here uses the native `disabled` attribute.
 */

export interface DiagnosticsSectionProps {
  readonly host: SettingsHost;
  readonly connection: ConnectionState;
  readonly now: number;
  /** Posts an outcome to the destination's one status line. */
  readonly notify: (message: string) => void;
  /** Blocks that follow the health list, such as the diagnostic bundle (plan 08-16). */
  readonly children?: ComponentChildren;
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

/** `Checked {relative}` beside the button: the answer's own time, or `Not checked`. */
function ToolbarTime({
  checkedAt,
  now,
}: {
  readonly checkedAt: string | null;
  readonly now: number;
}): VNode {
  const absoluteId = useId();
  if (checkedAt === null) return <p>Not checked</p>;
  const absolute = formatAbsoluteTime(checkedAt);
  return (
    <p>
      <span>Checked </span>
      <time dateTime={checkedAt} title={absolute} aria-describedby={absoluteId}>
        {formatRelativeTime(checkedAt, now)}
      </time>
      <span id={absoluteId} className="ccc-visually-hidden">
        {absolute}
      </span>
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
  children,
}: DiagnosticsSectionProps): VNode {
  const response = healthResponse.value;
  const phase = healthPhase.value;
  const vaultCheck = healthVaultCheck.value;
  const live = connection.kind === "live";
  const rows = rowsFor(connection, response, vaultCheck);
  // The first answer is still on its way: show the names and say nothing about the rows.
  const loading = live && response === null && phase !== "error";
  // The request failed while the service is up: the rows are cleared and the error says why.
  const failed = live && response === null && phase === "error";
  const cleared = !live || failed;
  const stale = !loading && anyStale(rows, now);

  const gate = useActionGate("diagnostics:run-checks");
  const checking = gate.busy;
  const awayId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusedRef = useRef<Element | null>(null);
  const mountedRef = useRef(true);

  // Opening the section is an owner action, so this is the one fetch allowed to be a `gesture`.
  // The connection is read once, at mount: a service that comes up later is the reconnect hook's.
  const openedLive = useRef(live);
  useEffect(() => {
    mountedRef.current = true;
    const release = registerHealthView({ vaultBasePath: () => host.display.vaultBasePath });
    if (openedLive.current) {
      void refreshHealth("gesture", { vaultBasePath: host.display.vaultBasePath });
    }
    return () => {
      mountedRef.current = false;
      release();
    };
  }, [host]);

  // When the rows are cleared, a focused control inside them is removed with them: focus falls
  // back to the section heading rather than to the page (UI-SPEC focus rules). Focus that was
  // somewhere else, such as on the button, is left alone.
  useLayoutEffect(() => {
    if (!cleared) return;
    const lost = focusedRef.current;
    const active = document.activeElement;
    if (lost !== null && !lost.isConnected && (active === null || active === document.body)) {
      headingRef.current?.focus();
    }
    focusedRef.current = null;
  }, [cleared]);

  // The press claims the gate before any await, so the button reads busy and a second press is
  // ignored; the outcome goes to the one status line, and the button keeps focus throughout.
  async function runChecks(): Promise<void> {
    if (!live || !gate.begin()) return;
    notify(CHECKING_LINE);
    const outcome = await refreshHealth("gesture", { vaultBasePath: host.display.vaultBasePath });
    gate.end();
    if (!mountedRef.current) return;
    if (outcome.kind === "ok") notify(checkedLine(outcome.timedOut));
    else if (outcome.kind === "error") notify(ERROR_HEADING);
  }

  return (
    <>
      <h3 ref={headingRef} tabIndex={-1} className="ccc-settings-section-title">
        Diagnostics
      </h3>
      <p>{DESCRIPTION}</p>
      <div className="ccc-health-toolbar">
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          aria-label={RUN_CHECKS_NAME}
          aria-busy={checking ? "true" : undefined}
          aria-disabled={checking || !live ? "true" : undefined}
          aria-describedby={live ? undefined : awayId}
          onClick={() => void runChecks()}
        >
          {RUN_CHECKS_LABEL}
        </button>
        {live && response !== null ? (
          <ToolbarTime checkedAt={response.generatedAt} now={now} />
        ) : (
          <p>Not checked</p>
        )}
        {!live && <p id={awayId}>{SERVICE_AWAY_REASON}</p>}
      </div>
      <div
        className="ccc-health"
        aria-busy={loading ? "true" : undefined}
        onFocusIn={(event) => {
          focusedRef.current = event.target as Element;
        }}
      >
        {loading && <p className="ccc-visually-hidden">{LOADING_TEXT}</p>}
        {failed && (
          <div className="ccc-health-error">
            <p>
              <span className="ccc-error-glyph" aria-hidden="true">
                ▲
              </span>{" "}
              {ERROR_HEADING}
            </p>
            <p>{ERROR_FOLLOW_UP}</p>
          </div>
        )}
        {stale && <p className="ccc-health-stale">{STALE_LINE}</p>}
        {loading ? (
          <div className="ccc-skeleton-line" aria-hidden="true" />
        ) : (
          <Summary rows={rows} />
        )}
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
      {children}
    </>
  );
}
