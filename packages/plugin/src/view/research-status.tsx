import type { ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import { RUN_STATE_DISPLAY } from "@ccc/domain/session.js";
import type { ComponentChildren, VNode } from "preact";
import { useId, useState } from "preact/hooks";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { UntrustedText } from "./approval-text.js";
import {
  CURRENT_RUN_LABEL,
  eachRunLine,
  failureCopy,
  HIDE_SOURCES_LABEL,
  isFailureCode,
  LAST_FAILURE_LABEL,
  LAST_SUCCESS_LABEL,
  NONE,
  NONE_YET,
  OPEN_REPORT_LABEL,
  RUN_STATUS_HEADING,
  SETUP_BODY,
  SETUP_HEADING,
  SOURCES_FOOTNOTE,
  STAGE_TEXT,
  showSourcesLabel,
  TEXT_SHORTENED,
  UNKNOWN_RUN_LABEL,
  UNKNOWN_RUN_SENTENCE,
} from "./research-copy.js";
import { formatRunTime, sourcesText } from "./research-format.js";

/**
 * The Run status section (plan 07-11; UI-SPEC R2, DIAG-05): the current run, the
 * last successful run, the last failed run and, only while a stale run is the
 * newest, an Unknown run row; then the configured sources disclosure and the
 * summariser setup callout. Props-driven: the status the service reported, the
 * clock and the zone, and one function. It reads no port, so it can never touch
 * the keychain, and it shows only what the run record says: a missing count is
 * omitted, never zero, and a stale run is Unknown, never an invented outcome.
 *
 * Every run state word and glyph is `RUN_STATE_DISPLAY`, and partiality is the
 * orthogonal Partial badge. Reasons come from the closed error-code map in
 * `research-copy.ts`; no remote string is ever rendered.
 */

/** The longest configured source label shown (UI-SPEC "Display caps"). */
const SOURCE_LABEL_MAX = 80;

export interface ResearchStatusSectionProps {
  /** The last status the service reported, or null before the first answer. */
  readonly status: ResearchStatusResponse | null;
  /** True when the first load failed and there is nothing to show yet. */
  readonly loadFailed: boolean;
  readonly now: number;
  readonly zone: string;
  readonly onOpenReport: (noteId: string) => void;
}

type Status = ResearchStatusResponse;

function ms(iso: string): number {
  return Date.parse(iso);
}

/** The failure record, unless it is `interrupted`, which is an Unknown run and not a failure. */
function realFailure(status: Status): NonNullable<Status["lastFailure"]> | null {
  const failure = status.lastFailure;
  return failure !== null && isFailureCode(failure.errorCode) ? failure : null;
}

/** The instant of the Unknown run, when one is the newest run (UI-SPEC R-06); otherwise null. */
function unknownRunAt(status: Status): string | null {
  const candidates: string[] = [];
  if (status.latestUnknown !== null) candidates.push(status.latestUnknown.startedAt);
  if (status.lastFailure !== null && !isFailureCode(status.lastFailure.errorCode)) {
    candidates.push(status.lastFailure.endedAt);
  }
  if (candidates.length === 0) return null;
  const at = candidates.reduce((newest, next) => (ms(next) > ms(newest) ? next : newest));
  const failure = realFailure(status);
  if (status.lastSuccess !== null && ms(at) <= ms(status.lastSuccess.endedAt)) return null;
  if (failure !== null && ms(at) <= ms(failure.endedAt)) return null;
  if (status.inFlight !== null && ms(status.inFlight.startedAt) > ms(at)) return null;
  return at;
}

/** The setup callout shows only for the newest failure being unconfigured with no newer success. */
function needsSetup(status: Status): boolean {
  const failure = status.lastFailure;
  if (failure === null || failure.errorCode !== "summariser-unconfigured") return false;
  return status.lastSuccess === null || ms(status.lastSuccess.endedAt) <= ms(failure.endedAt);
}

function StateWord(props: { readonly state: keyof typeof RUN_STATE_DISPLAY }): VNode {
  const display = RUN_STATE_DISPLAY[props.state];
  return (
    <span className="ccc-research-state" data-state={props.state}>
      <span aria-hidden="true">{display.glyph}</span> <span>{display.label}</span>
    </span>
  );
}

function PartialBadge(props: { readonly unavailable: number }): VNode {
  const noun = props.unavailable === 1 ? "source" : "sources";
  return (
    <span className="ccc-badge" data-badge="partial">
      <span className="ccc-badge-glyph" aria-hidden="true">
        ◈
      </span>
      <span className="ccc-badge-label">Partial</span>
      <span className="ccc-visually-hidden">{` — ${props.unavailable} ${noun} didn't respond`}</span>
    </span>
  );
}

/** The absolute time in a `time` element, with the relative time in `title` and a hidden description. */
function RunTime(props: {
  readonly iso: string;
  readonly now: number;
  readonly zone: string;
}): VNode {
  const describedBy = useId();
  const relative = formatRelativeTime(props.iso, props.now);
  return (
    <>
      <time
        dateTime={props.iso}
        title={relative}
        aria-describedby={describedBy}
        className="ccc-research-time"
      >
        {formatRunTime(props.iso, props.now, props.zone)}
      </time>
      <span id={describedBy} className="ccc-visually-hidden">
        {relative}
      </span>
    </>
  );
}

function Segments(props: { readonly parts: readonly ComponentChildren[] }): VNode {
  const nodes: ComponentChildren[] = [];
  props.parts.forEach((part, index) => {
    if (index > 0) nodes.push(" · ");
    nodes.push(part);
  });
  return <>{nodes}</>;
}

function Skeleton(): VNode {
  return <span className="ccc-skeleton-line" aria-hidden="true" />;
}

function capped(text: string, max: number): { text: string; shortened: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), shortened: true }
    : { text, shortened: false };
}

export function ResearchStatusSection(props: ResearchStatusSectionProps): VNode {
  const headingId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const { status, now, zone } = props;
  const loading = status === null && !props.loadFailed;
  const success = status?.lastSuccess ?? null;
  const failure = status === null ? null : realFailure(status);
  const unknownAt = status === null ? null : unknownRunAt(status);
  const inFlight = status?.inFlight ?? null;
  const sources = status?.configuredSources ?? null;

  return (
    <section className="ccc-research-run-status" aria-labelledby={headingId}>
      <h3 id={headingId} className="ccc-section-label">
        {RUN_STATUS_HEADING}
      </h3>
      <dl className="ccc-detail-fields">
        {inFlight === null ? null : (
          <>
            <dt className="ccc-research-status-row">{CURRENT_RUN_LABEL}</dt>
            <dd className="ccc-research-status-row">
              <Segments
                parts={[
                  <StateWord key="state" state="running" />,
                  inFlight.stage === null ? null : STAGE_TEXT[inFlight.stage],
                  `started ${formatRelativeTime(inFlight.startedAt, now)}`,
                ].filter((part) => part !== null)}
              />
            </dd>
          </>
        )}
        <dt className="ccc-research-status-row">{LAST_SUCCESS_LABEL}</dt>
        <dd className="ccc-research-status-row">
          {loading ? (
            <Skeleton />
          ) : success === null ? (
            props.loadFailed ? null : (
              NONE_YET
            )
          ) : (
            <Segments
              parts={[
                <StateWord key="state" state="completed" />,
                success.outcome === "partial" ? (
                  <PartialBadge
                    key="partial"
                    unavailable={Math.max(0, success.sourceTotal - success.sourceCount)}
                  />
                ) : null,
                <RunTime key="time" iso={success.endedAt} now={now} zone={zone} />,
                success.sourceCount === success.sourceTotal
                  ? sourcesText(success.sourceCount)
                  : `${success.sourceCount} of ${success.sourceTotal} sources`,
                <button
                  key="open"
                  type="button"
                  className="ccc-connect-button"
                  data-variant="tertiary"
                  onClick={() => props.onOpenReport(success.reportNoteId)}
                >
                  {OPEN_REPORT_LABEL}
                </button>,
              ].filter((part) => part !== null)}
            />
          )}
        </dd>
        <dt className="ccc-research-status-row">{LAST_FAILURE_LABEL}</dt>
        <dd className="ccc-research-status-row">
          {loading ? (
            <Skeleton />
          ) : failure === null ? (
            props.loadFailed ? null : (
              NONE
            )
          ) : (
            <>
              <StateWord state="failed" /> {" · "}
              <RunTime iso={failure.endedAt} now={now} zone={zone} />
              <span className="ccc-research-reason-text">
                {` — ${failureCopy(failure.errorCode).reason}`}
              </span>
              {failure.errorCode === "summariser-unconfigured" ? null : (
                <span className="ccc-research-next-step">
                  {failureCopy(failure.errorCode).nextStep}
                </span>
              )}
            </>
          )}
        </dd>
        {unknownAt === null ? null : (
          <>
            <dt className="ccc-research-status-row">{UNKNOWN_RUN_LABEL}</dt>
            <dd className="ccc-research-status-row">
              <Segments
                parts={[
                  <StateWord key="state" state="stale" />,
                  <RunTime key="time" iso={unknownAt} now={now} zone={zone} />,
                  UNKNOWN_RUN_SENTENCE,
                ]}
              />
            </dd>
          </>
        )}
      </dl>
      {sources === null ? null : <p className="ccc-field-help">{eachRunLine(sources.length)}</p>}
      {sources === null ? null : (
        <div className="ccc-research-sources-config">
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="tertiary"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((wasOpen) => !wasOpen)}
          >
            {open ? HIDE_SOURCES_LABEL : showSourcesLabel(sources.length)}
          </button>
          <div id={panelId} hidden={!open}>
            {sources.length === 0 ? null : (
              <ul>
                {sources.map((source) => {
                  const label = capped(source.label, SOURCE_LABEL_MAX);
                  return (
                    <li key={`${source.host}|${source.label}`}>
                      <UntrustedText text={label.text} />
                      {label.shortened ? (
                        <span className="ccc-field-help">{` ${TEXT_SHORTENED}`}</span>
                      ) : null}{" "}
                      <span className="ccc-mono">{source.host}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="ccc-field-help">{SOURCES_FOOTNOTE}</p>
          </div>
        </div>
      )}
      {status !== null && needsSetup(status) ? (
        <div className="ccc-setup-callout" role="note">
          <p className="ccc-research-callout-heading">{SETUP_HEADING}</p>
          <p>{SETUP_BODY}</p>
        </div>
      ) : null}
    </section>
  );
}
