import type { ResearchReportSource } from "@ccc/domain/research-routes.js";
import { ACCESS_CLASS_DISPLAY, SOURCE_TYPE_DISPLAY } from "@ccc/domain/source-reference.js";
import type { VNode } from "preact";
import { UntrustedText } from "./approval-text.js";
import {
  AUTHOR_MAX,
  backToFindingLabel,
  COPY_ADDRESS_LABEL,
  NOT_PROVIDED,
  NOT_RECORDED,
  OPEN_SNAPSHOT_LABEL,
  removedSentence,
  SOURCE_FIELD_LABELS,
  SOURCE_TITLE_MAX,
  TEXT_SHORTENED,
} from "./research-copy.js";
import { capText, formatRunTime } from "./research-format.js";

/**
 * The Sources section of the reader (plan 07-13; UI-SPEC R4 "A source entry", RSRCH-03, R-10,
 * R-11): one numbered entry per source reference, in report order, each with every PRD 10.1 field
 * in the contracted order. Each entry is a list item whose heading is a focus target
 * (`tabindex="-1"`) for the citation buttons; the entry a citation jumped to offers
 * `Back to finding {i}`.
 *
 * The address is mono TEXT, never a link (D-06, R-10): the owner copies it deliberately with
 * `Copy address`. A private deep link shows as text with no action. Every source-derived string
 * (title, author, address, path) renders through `UntrustedText` as a text node; the hash, id and
 * path are mono with `overflow-wrap: anywhere` from the stylesheet. Nothing here reads a port: the
 * two actions are props.
 */

/** How many leading hash characters the entry shows; the full value is in `title` and a hidden span. */
const HASH_SHOWN = 12;

export interface ReportSourcesProps {
  readonly sources: readonly ResearchReportSource[];
  /** The finding whose citation jumped to a source, so that entry can offer the way back. */
  readonly backTo: { readonly sourceNumber: number; readonly itemIndex: number } | null;
  readonly onBackToFinding: (itemIndex: number, sourceNumber: number) => void;
  readonly onCopyAddress: (address: string) => void;
  /** Opens the raw snapshot note; the path is vault-relative. */
  readonly onOpenSnapshot: (path: string) => void;
  readonly now: number;
  readonly zone: string;
}

function Shortened(): VNode {
  return <span className="ccc-field-help">{` ${TEXT_SHORTENED}`}</span>;
}

function Instant(props: {
  readonly iso: string | null;
  readonly now: number;
  readonly zone: string;
  readonly absent: string;
}): VNode {
  if (props.iso === null) return <>{props.absent}</>;
  return <time dateTime={props.iso}>{formatRunTime(props.iso, props.now, props.zone)}</time>;
}

function SourceEntry(props: ReportSourcesProps & { readonly source: ResearchReportSource }): VNode {
  const { source } = props;
  const title = capText(source.title, SOURCE_TITLE_MAX);
  const author = source.author === null ? null : capText(source.author, AUTHOR_MAX);
  const access = ACCESS_CLASS_DISPLAY[source.accessClass];
  const address = source.canonicalUrl ?? source.deepLink ?? "";
  const back = props.backTo?.sourceNumber === source.number ? props.backTo : null;
  const hash = source.contentHash;
  return (
    <li className="ccc-report-source" data-source={source.number}>
      <h5 tabIndex={-1}>
        {`${source.number}. `}
        <UntrustedText text={title.text} />
        {title.shortened ? <Shortened /> : null}
      </h5>
      {back === null ? null : (
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="tertiary"
          data-back-to-finding={back.itemIndex}
          onClick={() => props.onBackToFinding(back.itemIndex, source.number)}
        >
          {backToFindingLabel(back.itemIndex)}
        </button>
      )}
      <dl className="ccc-detail-fields">
        <dt>{SOURCE_FIELD_LABELS.type}</dt>
        <dd>{SOURCE_TYPE_DISPLAY[source.sourceType]}</dd>
        <dt>{SOURCE_FIELD_LABELS.access}</dt>
        <dd>
          <span>{access.label}</span> <span className="ccc-field-help">{access.explanation}</span>
        </dd>
        <dt>{SOURCE_FIELD_LABELS.address}</dt>
        <dd>
          <span className="ccc-mono">
            <UntrustedText text={address} />
          </span>
          {source.canonicalUrl === undefined ? null : (
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="tertiary"
              onClick={() => props.onCopyAddress(address)}
            >
              {COPY_ADDRESS_LABEL}
            </button>
          )}
        </dd>
        <dt>{SOURCE_FIELD_LABELS.author}</dt>
        <dd>
          {author === null ? (
            NOT_PROVIDED
          ) : (
            <>
              <UntrustedText text={author.text} />
              {author.shortened ? <Shortened /> : null}
            </>
          )}
        </dd>
        <dt>{SOURCE_FIELD_LABELS.published}</dt>
        <dd>
          <Instant
            iso={source.publishedAt}
            now={props.now}
            zone={props.zone}
            absent={NOT_PROVIDED}
          />
        </dd>
        <dt>{SOURCE_FIELD_LABELS.retrieved}</dt>
        <dd>
          <Instant
            iso={source.retrievedAt}
            now={props.now}
            zone={props.zone}
            absent={NOT_RECORDED}
          />
        </dd>
        <dt>{SOURCE_FIELD_LABELS.contentHash}</dt>
        <dd>
          <span className="ccc-mono" title={hash}>
            {hash.slice(0, HASH_SHOWN)}
          </span>
          <span className="ccc-visually-hidden">{` Full value: ${hash}`}</span>
        </dd>
        <dt>{SOURCE_FIELD_LABELS.stableId}</dt>
        <dd>
          <span className="ccc-mono">{source.id}</span>
        </dd>
        <dt>{SOURCE_FIELD_LABELS.snapshot}</dt>
        <dd>
          <span className="ccc-mono">{source.snapshotPath}</span>
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="tertiary"
            onClick={() => props.onOpenSnapshot(source.snapshotPath)}
          >
            {OPEN_SNAPSHOT_LABEL}
          </button>
        </dd>
        <dt>{SOURCE_FIELD_LABELS.removed}</dt>
        <dd>{source.counts === null ? NOT_RECORDED : removedSentence(source.counts)}</dd>
      </dl>
    </li>
  );
}

export function ReportSources(props: ReportSourcesProps): VNode {
  return (
    <ol className="ccc-report-sources">
      {props.sources.map((source) => (
        <SourceEntry key={source.number} {...props} source={source} />
      ))}
    </ol>
  );
}
