import type { ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { researchApi } from "../research/api.js";
import { requestDestination } from "./navigation-request.js";
import { SERVICE_AWAY_REASON } from "./settings-controls.js";
import { requestSettingsSection } from "./settings-sections.js";

/**
 * The Schedules section (plan 08-18 Task 2; 08-UI-SPEC S2 Schedules and G9, OD-3, ADR-0013):
 * read-only. Runs are manual in this version and nothing runs on a timer, so there is no
 * schedule, timer, run or source-edit control here: only the topic and the configured sources
 * the service reports, the manual-only line, a link to the research view and a footnote saying
 * where the source list is edited.
 *
 * The status is fetched when the section opens (and again when the service comes back), through
 * the research API, never from the Research view's signal, which resets when that view unmounts.
 * The section starts no timer and polls nothing. A failed fetch reads `Couldn't load the schedule
 * details.` with a link to diagnostics and shows no guessed values; with the service away the
 * values read `Unknown`. Labels come from the owner's configuration and are shown as text,
 * capped at 80 characters with the full text in `title`; hosts are mono and wrap.
 */

export const SCHEDULES_DESCRIPTION = "Runs are manual in this version. Nothing runs on a timer.";
export const MANUAL_ONLY_LINE = "Manual trigger only in this version.";
export const SCHEDULES_FOOTNOTE =
  "The source list is edited in the companion service's research settings.";
export const NO_SOURCES_TEXT =
  "No sources are configured. A run would fail with no source to fetch.";
export const SOURCES_UNREADABLE_TEXT = "The source list couldn't be read.";
export const SCHEDULES_ERROR_HEADING = "Couldn't load the schedule details.";
export const SCHEDULES_ERROR_FOLLOW_UP = "Check the service in the diagnostics section.";
export const DEFAULT_TOPIC_LABEL = "Research sources";
export const OPEN_RESEARCH_LABEL = "Open the research view";
export const GO_TO_DIAGNOSTICS_LABEL = "Go to the diagnostics section";

/** The most characters of a topic or source label that are shown (UI-SPEC G9 long-text). */
export const SCHEDULE_TEXT_MAX = 80;

const PLURAL = new Intl.PluralRules("en");

/** `0 sources configured`, `1 source configured`, `n sources configured`. */
export function sourcesConfiguredText(count: number): string {
  return `${count} ${PLURAL.select(count) === "one" ? "source" : "sources"} configured`;
}

interface Capped {
  readonly shown: string;
  /** The whole text when it was cut, for the `title`; otherwise `undefined`. */
  readonly full: string | undefined;
}

/** `text` cut to {@link SCHEDULE_TEXT_MAX} characters (ending in `…`), counted by code point. */
export function capText(text: string): Capped {
  const characters = Array.from(text);
  if (characters.length <= SCHEDULE_TEXT_MAX) return { shown: text, full: undefined };
  return { shown: `${characters.slice(0, SCHEDULE_TEXT_MAX - 1).join("")}…`, full: text };
}

type ScheduleView =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: ResearchStatusResponse }
  | { readonly kind: "error" };

const LOADING: ScheduleView = { kind: "loading" };
const FAILED: ScheduleView = { kind: "error" };

export interface SchedulesSectionProps {
  /** Read during render so the section follows the service coming and going. */
  readonly connection: ConnectionState;
  readonly now?: number | undefined;
  /** The destination's status line; this section has no outcome to post. */
  readonly notify?: ((message: string) => void) | undefined;
}

function CappedText({ text }: { readonly text: string }): VNode {
  const { shown, full } = capText(text);
  return <span title={full}>{shown}</span>;
}

function Unknown({ reason }: { readonly reason?: string | undefined }): VNode {
  return (
    <>
      <p className="ccc-setting-unknown">Unknown</p>
      {reason !== undefined && <p>{reason}</p>}
    </>
  );
}

function SourcesValue({ status }: { readonly status: ResearchStatusResponse }): VNode {
  const sources = status.configuredSources;
  if (sources === null) return <Unknown reason={SOURCES_UNREADABLE_TEXT} />;
  return (
    <>
      <p>{sourcesConfiguredText(sources.length)}</p>
      {sources.length === 0 ? (
        <p>{NO_SOURCES_TEXT}</p>
      ) : (
        <ul className="ccc-schedule-sources">
          {sources.map((source, index) => (
            // The list is the service's order and has no id of its own; an index is its identity.
            <li key={index}>
              <CappedText text={source.label} /> <code className="ccc-mono">{source.host}</code>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function SchedulesSection({ connection }: SchedulesSectionProps): VNode {
  const live = connection.kind === "live";
  const [view, setView] = useState<ScheduleView>(LOADING);

  // Fetched when the section opens with the service up, and again when the service comes back.
  // `cancelled` drops an answer that arrives after the section closed or the service went away.
  useEffect(() => {
    if (!live) {
      setView(LOADING);
      return;
    }
    let cancelled = false;
    setView(LOADING);
    // `new Promise` also turns a synchronous throw in the API into a rejection.
    new Promise<ResearchStatusResponse>((resolve) => {
      resolve(researchApi().status());
    }).then(
      (status) => {
        if (!cancelled) setView({ kind: "ready", status });
      },
      () => {
        if (!cancelled) setView(FAILED);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [live]);

  const loading = live && view.kind === "loading";
  const failed = live && view.kind === "error";
  const status = live && view.kind === "ready" ? view.status : null;

  function value(render: (ready: ResearchStatusResponse) => VNode): VNode {
    if (!live) return <Unknown reason={SERVICE_AWAY_REASON} />;
    if (loading) return <div className="ccc-skeleton-line" aria-hidden="true" />;
    if (status === null) return <Unknown />;
    return render(status);
  }

  return (
    <>
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Schedules
      </h3>
      <p>{SCHEDULES_DESCRIPTION}</p>
      {failed && (
        <div className="ccc-health-error">
          <p>
            <span className="ccc-error-glyph" aria-hidden="true">
              ▲
            </span>{" "}
            {SCHEDULES_ERROR_HEADING}
          </p>
          <p>{SCHEDULES_ERROR_FOLLOW_UP}</p>
          <p>
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="tertiary"
              onClick={() => requestSettingsSection("diagnostics")}
            >
              {GO_TO_DIAGNOSTICS_LABEL}
            </button>
          </p>
        </div>
      )}
      <dl className="ccc-detail-fields" aria-busy={loading ? "true" : undefined}>
        <dt>Topic</dt>
        <dd>
          {value((ready) => (
            <CappedText text={ready.topicLabel ?? DEFAULT_TOPIC_LABEL} />
          ))}
        </dd>
        <dt>Sources</dt>
        <dd>
          {value((ready) => (
            <SourcesValue status={ready} />
          ))}
        </dd>
        <dt>Scheduling</dt>
        <dd>{MANUAL_ONLY_LINE}</dd>
      </dl>
      <p>
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="tertiary"
          onClick={() => requestDestination("research")}
        >
          {OPEN_RESEARCH_LABEL}
        </button>
      </p>
      <p className="ccc-field-help">{SCHEDULES_FOOTNOTE}</p>
    </>
  );
}
