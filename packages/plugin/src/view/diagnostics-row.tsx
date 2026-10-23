import type { Freshness } from "@ccc/domain";
import {
  COLLECTORS_PASSIVE_PART_IDS,
  type HealthFacts,
  SCHEDULER_PASSIVE_PART_IDS,
  type SetupAction,
  type SubsystemStatus,
} from "@ccc/domain/diagnostics.js";
import type { VNode } from "preact";
import { useId, useState } from "preact/hooks";
import { type ShownRow, shownFreshness } from "../health/state.js";
import { FRESHNESS_GLYPH } from "../widgets/footer.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import {
  type AnyReason,
  COLLECTORS_GROUPS,
  chipFor,
  displayedAction,
  HIDE_DETAILS_LABEL,
  hideDetailsName,
  PART_NAMES,
  ROW_NAMES,
  reasonText,
  SCHEDULER_FIXED_LINE,
  SETUP_ACTION_COPY,
  SETUP_COMMANDS,
  setupActionLabel,
  showDetailsLabel,
  showDetailsName,
} from "./diagnostics-copy.js";
import { requestDestination } from "./navigation-request.js";
import type { SettingsHost } from "./settings-host.js";
import { useActionGate } from "./settings-pending.js";
import { requestSettingsSection } from "./settings-sections.js";

/**
 * One subsystem row of the health list, its parts and its setup actions (plan 08-13; D-06, D-07,
 * D-08, D-39, 08-UI-SPEC S3 "The health list"). Markup follows the 08-10 stylesheet:
 * `li.ccc-health-row` > (name + chip, reason block, then full-width blocks).
 *
 * A setup action does exactly one of three things and nothing installs or changes a credential:
 * copy a repository-relative command (shown on the row, never run), deep-link to a Settings
 * section or the Research destination, or invoke the existing `Set up vault` command (which owns
 * its own confirm modal). All text is plugin-owned; the service sends only the closed action.
 */

/** A part as the row draws it (the strict schema guarantees these members). */
export interface ShownPart {
  readonly partId: string;
  readonly status: SubsystemStatus;
  readonly reasonCode: AnyReason;
  readonly setupAction?: SetupAction;
  readonly facts?: HealthFacts;
}

const FRESHNESS_LABEL: Readonly<Record<Freshness, string>> = {
  live: "Live",
  cached: "Cached",
  stale: "Stale",
  unavailable: "Unavailable",
};

export function StatusChip({
  status,
  subsystem,
}: {
  readonly status: SubsystemStatus;
  readonly subsystem: string;
}): VNode {
  const { glyph, word } = chipFor(status, subsystem);
  return (
    <span className="ccc-badge" data-status={status}>
      <span className="ccc-visually-hidden">Status: </span>
      <span className="ccc-badge-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="ccc-badge-label">{word}</span>
    </span>
  );
}

/** The freshness badge, shared with the Security section's Keychain chips (plan 08-15, R-F5). */
export function FreshnessBadge({ freshness }: { readonly freshness: Freshness }): VNode {
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
function RowMeta({
  checkedAt,
  freshness,
  now,
}: {
  readonly checkedAt: string | null;
  readonly freshness: Freshness;
  readonly now: number;
}): VNode {
  const absoluteId = useId();
  if (checkedAt === null) {
    return (
      <p className="ccc-health-meta">
        <span>Not checked</span> <FreshnessBadge freshness={freshness} />
      </p>
    );
  }
  const absolute = formatAbsoluteTime(checkedAt);
  return (
    <p className="ccc-health-meta">
      <span>Checked </span>
      <time dateTime={checkedAt} title={absolute} aria-describedby={absoluteId}>
        {formatRelativeTime(checkedAt, now)}
      </time>
      <span id={absoluteId} className="ccc-visually-hidden">
        {absolute}
      </span>{" "}
      <FreshnessBadge freshness={freshness} />
    </p>
  );
}

// ---------------------------------------------------------------------------
// Setup actions

interface ActionProps {
  readonly action: SetupAction;
  readonly host: SettingsHost;
  readonly notify: (message: string) => void;
}

/**
 * One setup action: its button, and for `copy-command` the command text on the row. The press
 * copies, navigates or runs the vault-setup command and does nothing else (T-08-35).
 */
function SetupActionView({ action, host, notify }: ActionProps): VNode {
  const gate = useActionGate(
    action.kind === "run-plugin-command" ? `diagnostics:${action.command}` : undefined,
  );

  async function press(): Promise<void> {
    switch (action.kind) {
      case "copy-command": {
        try {
          await host.copyText(SETUP_COMMANDS[action.command]);
          notify(SETUP_ACTION_COPY.copied(action));
        } catch {
          notify(SETUP_ACTION_COPY.copyFailed);
        }
        return;
      }
      case "go-to-section": {
        if (action.section === "research") requestDestination("research");
        else requestSettingsSection(action.section);
        return;
      }
      case "run-plugin-command": {
        // The existing flow: it plans, asks in its own modal and applies. This only invokes it.
        if (!gate.begin()) return;
        try {
          await host.runVaultSetup();
        } catch {
          // The flow reports its own failures; nothing of the error is shown here.
        } finally {
          gate.end();
        }
      }
    }
  }

  return (
    <>
      {action.kind === "copy-command" && (
        <code className="ccc-health-command ccc-mono">{SETUP_COMMANDS[action.command]}</code>
      )}
      <div className="ccc-card-actions">
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          aria-busy={gate.busy ? "true" : undefined}
          aria-disabled={gate.busy ? "true" : undefined}
          onClick={() => void press()}
        >
          {setupActionLabel(action)}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Parts

const PASSIVE: Readonly<Record<string, readonly string[]>> = {
  collectors: COLLECTORS_PASSIVE_PART_IDS,
  scheduler: SCHEDULER_PASSIVE_PART_IDS,
};

/** The part that decided the row: its status and reason, an active part before a passive one. */
function decidingPart(
  row: { readonly id: string; readonly status: SubsystemStatus; readonly reasonCode: AnyReason },
  parts: readonly ShownPart[],
): ShownPart | undefined {
  const passive = PASSIVE[row.id] ?? [];
  const matching = parts.filter(
    (part) => part.status === row.status && part.reasonCode === row.reasonCode,
  );
  return matching.find((part) => !passive.includes(part.partId)) ?? matching[0];
}

function PartView({
  part,
  now,
  isDeciding,
  host,
  notify,
}: {
  readonly part: ShownPart;
  readonly now: number;
  readonly isDeciding: boolean;
  readonly host: SettingsHost;
  readonly notify: (message: string) => void;
}): VNode {
  const { reason, nextStep } = reasonText(part.reasonCode, { facts: part.facts, now });
  const action = displayedAction(part.reasonCode, part.setupAction);
  return (
    <li
      className="ccc-health-part"
      data-part={part.partId}
      data-status={part.status}
      data-reason={part.reasonCode}
    >
      <div className="ccc-health-part-head">
        <span className="ccc-health-part-name">{PART_NAMES[part.partId] ?? part.partId}</span>
        <StatusChip status={part.status} subsystem={part.partId} />
      </div>
      <p>{reason}</p>
      {/* The deciding part's next step and action live on the row: nothing appears twice. */}
      {!isDeciding && nextStep !== null && <p>{nextStep}</p>}
      {!isDeciding && action !== undefined && (
        <SetupActionView action={action} host={host} notify={notify} />
      )}
    </li>
  );
}

function PartsList({
  parts,
  deciding,
  now,
  host,
  notify,
}: {
  readonly parts: readonly ShownPart[];
  readonly deciding: ShownPart | undefined;
  readonly now: number;
  readonly host: SettingsHost;
  readonly notify: (message: string) => void;
}): VNode {
  return (
    <ul className="ccc-health-parts">
      {parts.map((part) => (
        <PartView
          key={part.partId}
          part={part}
          now={now}
          isDeciding={part === deciding}
          host={host}
          notify={notify}
        />
      ))}
    </ul>
  );
}

function PartsDisclosure({
  rowName,
  parts,
  collectors,
  deciding,
  defaultOpen,
  now,
  host,
  notify,
}: {
  readonly rowName: string;
  readonly parts: readonly ShownPart[];
  /** Usage collectors groups its parts under two labels (D-41). */
  readonly collectors: boolean;
  readonly deciding: ShownPart | undefined;
  readonly defaultOpen: boolean;
  readonly now: number;
  readonly host: SettingsHost;
  readonly notify: (message: string) => void;
}): VNode {
  const panelId = useId();
  // The owner's choice wins once made; until then a degraded or failing row opens by itself.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? defaultOpen;

  return (
    <div>
      <button
        type="button"
        className="ccc-connect-button"
        data-variant="tertiary"
        aria-expanded={open ? "true" : "false"}
        aria-controls={panelId}
        aria-label={
          open ? hideDetailsName(rowName, parts.length) : showDetailsName(rowName, parts.length)
        }
        onClick={() => setChosen(!open)}
      >
        {open ? HIDE_DETAILS_LABEL : showDetailsLabel(parts.length)}
      </button>
      <div id={panelId} hidden={!open}>
        {collectors ? (
          COLLECTORS_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="ccc-section-label ccc-section-label--muted">{group.label}</p>
              <PartsList
                parts={parts.filter((part) => group.partIds.includes(part.partId))}
                deciding={deciding}
                now={now}
                host={host}
                notify={notify}
              />
            </div>
          ))
        ) : (
          <PartsList parts={parts} deciding={deciding} now={now} host={host} notify={notify} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The row

/** The facts that read on a row's detail line, beyond the part that spoke. */
function schedulerLine(parts: readonly ShownPart[], now: number): string {
  const lastRun = parts.find((part) => part.partId === "last-run");
  const success = lastRun?.facts?.lastSuccessAt;
  const failure = lastRun?.facts?.lastFailureAt;
  return [
    SCHEDULER_FIXED_LINE,
    success === undefined ? null : `Last successful run ${formatRelativeTime(success, now)}.`,
    failure === undefined ? null : `Last failed run ${formatRelativeTime(failure, now)}.`,
  ]
    .filter((sentence): sentence is string => sentence !== null)
    .join(" ");
}

export interface HealthRowProps {
  readonly row: ShownRow;
  readonly now: number;
  readonly host: SettingsHost;
  readonly notify: (message: string) => void;
  /** The service row's version and start time, when live and answered. */
  readonly serviceDetail: string | null;
  /** The first answer is still on its way: the name shows, nothing is claimed about the row. */
  readonly pending: boolean;
}

export function HealthRow({
  row,
  now,
  host,
  notify,
  serviceDetail,
  pending,
}: HealthRowProps): VNode {
  const name = ROW_NAMES[row.id];
  if (pending) {
    // Names at once; chip, reason and meta are static skeletons (no spinner, no pulse). The list
    // carries `aria-busy` and one hidden "Loading diagnostics", so this adds nothing to read out.
    return (
      <li className="ccc-health-row" data-subsystem={row.id}>
        <div>
          <h5 className="ccc-settings-item-title">{name}</h5>
          <div className="ccc-skeleton-line" aria-hidden="true" />
        </div>
        <div>
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <div className="ccc-skeleton-line" aria-hidden="true" />
        </div>
      </li>
    );
  }

  const parts: readonly ShownPart[] | undefined = "parts" in row ? row.parts : undefined;
  const deciding = parts === undefined ? undefined : decidingPart(row, parts);
  // The service sends the deciding part's action and facts on the row; either source will do.
  const facts = ("facts" in row ? row.facts : undefined) ?? deciding?.facts;
  const action = displayedAction(
    row.reasonCode,
    ("setupAction" in row ? row.setupAction : undefined) ?? deciding?.setupAction,
  );
  const { reason, nextStep } = reasonText(row.reasonCode, { facts, now });

  let detail: string | null = serviceDetail;
  if (row.id === "scheduler") detail = schedulerLine(parts ?? [], now);
  if (row.id === "collectors" && deciding !== undefined) {
    detail = `Reported by: ${PART_NAMES[deciding.partId] ?? deciding.partId}`;
  }

  return (
    <li
      className="ccc-health-row"
      data-status={row.status}
      data-subsystem={row.id}
      data-reason={row.reasonCode}
    >
      <div>
        <h5 className="ccc-settings-item-title">{name}</h5>
        <StatusChip status={row.status} subsystem={row.id} />
      </div>
      <div>
        <p>{reason}</p>
        {detail !== null && <p className="ccc-health-detail">{detail}</p>}
        <RowMeta checkedAt={row.checkedAt} freshness={shownFreshness(row, now)} now={now} />
      </div>
      {(nextStep !== null || action !== undefined) && (
        <div className="ccc-setup-callout">
          {nextStep !== null && <p className="ccc-state-body">{nextStep}</p>}
          {action !== undefined && <SetupActionView action={action} host={host} notify={notify} />}
        </div>
      )}
      {parts !== undefined && parts.length > 0 && (
        <PartsDisclosure
          rowName={name}
          parts={parts}
          collectors={row.id === "collectors"}
          deciding={deciding}
          defaultOpen={row.status === "degraded" || row.status === "failing"}
          now={now}
          host={host}
          notify={notify}
        />
      )}
    </li>
  );
}
