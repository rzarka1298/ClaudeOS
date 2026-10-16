import { REPORT_ITEM_KIND_DISPLAY } from "@ccc/domain/research.js";
import type { ResearchReportItem } from "@ccc/domain/research-routes.js";
import type { VNode } from "preact";
import { UntrustedText } from "./approval-text.js";
import {
  CITATION_TITLE_MAX,
  CITATIONS_LABEL,
  citationName,
  FINDING_TEXT_MAX,
  findingPrefix,
  NO_SOURCE_CITED,
  QUOTE_TEXT_MAX,
  quoteCaption,
  TEXT_SHORTENED,
} from "./research-copy.js";
import { capText } from "./research-format.js";

/**
 * One finding of a report (plan 07-13; UI-SPEC R4 "A finding", RSRCH-04, D-23): a list item with a
 * hidden prefix that names its kind first, the kind tag (glyph and word from the one display map),
 * the text, an optional quote under its caption, and the citation buttons.
 *
 * The finding's text, the quote and every citation title are untrusted: they render through
 * `UntrustedText` as text nodes, capped at their display caps, and never reach an attribute other
 * than a `title` (which holds text) or an accessible name. The start rule's shape comes from
 * `data-kind` and the stylesheet; nothing about it is derived from the text.
 */

export interface ReportFindingProps {
  readonly item: ResearchReportItem;
  /** Called when a citation button is activated: the cited source number and the button itself. */
  readonly onCite: (sourceNumber: number, itemIndex: number) => void;
}

function Shortened(): VNode {
  return <span className="ccc-field-help">{` ${TEXT_SHORTENED}`}</span>;
}

export function ReportFinding(props: ReportFindingProps): VNode {
  const { item } = props;
  const display = REPORT_ITEM_KIND_DISPLAY[item.kind];
  const text = capText(item.text, FINDING_TEXT_MAX);
  const quote = item.quote === null ? null : capText(item.quote, QUOTE_TEXT_MAX);
  return (
    <li className="ccc-report-item" data-kind={item.kind}>
      <span className="ccc-visually-hidden">{findingPrefix(item.index, display.label)}</span>
      <p className="ccc-report-kind">
        <span aria-hidden="true">{display.glyph}</span> <span>{display.label}</span>
      </p>
      <p className="ccc-report-text">
        <UntrustedText text={text.text} />
        {text.shortened ? <Shortened /> : null}
      </p>
      {quote === null || item.quoteSourceNumber === null ? null : (
        <>
          <p className="ccc-report-quote-caption">{quoteCaption(item.quoteSourceNumber)}</p>
          <blockquote className="ccc-report-quote">
            <UntrustedText text={quote.text} />
            {quote.shortened ? <Shortened /> : null}
          </blockquote>
        </>
      )}
      {item.citations.length === 0 ? (
        <p className="ccc-report-citations">{NO_SOURCE_CITED}</p>
      ) : (
        <p className="ccc-report-citations">
          <span>{CITATIONS_LABEL}</span>{" "}
          {item.citations.map((citation, position) => {
            const title = capText(citation.title, CITATION_TITLE_MAX);
            return (
              <button
                // The position keeps the key unique even if a source is cited twice.
                key={`${item.index}-${citation.number}-${position}`}
                type="button"
                className="ccc-connect-button"
                data-variant="tertiary"
                data-cite={`${item.index}-${citation.number}`}
                aria-label={citationName(citation.number, title.text)}
                title={title.text}
                onClick={() => props.onCite(citation.number, item.index)}
              >
                {`[${citation.number}] `}
                <UntrustedText text={title.text} />
              </button>
            );
          })}
        </p>
      )}
    </li>
  );
}
