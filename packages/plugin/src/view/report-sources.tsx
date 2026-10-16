import type { ResearchReportSource } from "@ccc/domain/research-routes.js";
import type { VNode } from "preact";
import { UntrustedText } from "./approval-text.js";
import { backToFindingLabel, SOURCE_TITLE_MAX, TEXT_SHORTENED } from "./research-copy.js";
import { capText } from "./research-format.js";

/**
 * The Sources section of the reader (plan 07-13; UI-SPEC R4 "A source entry", RSRCH-03): one
 * numbered entry per source reference, in report order. Each entry is a list item whose heading is
 * a focus target (`tabindex="-1"`) for the citation buttons; the entry a citation jumped to offers
 * `Back to finding {i}`.
 */

export interface ReportSourcesProps {
  readonly sources: readonly ResearchReportSource[];
  /** The finding whose citation jumped to a source, so that entry can offer the way back. */
  readonly backTo: { readonly sourceNumber: number; readonly itemIndex: number } | null;
  readonly onBackToFinding: (itemIndex: number, sourceNumber: number) => void;
}

export function ReportSources(props: ReportSourcesProps): VNode {
  return (
    <ol className="ccc-report-sources">
      {props.sources.map((source) => {
        const title = capText(source.title, SOURCE_TITLE_MAX);
        const back = props.backTo?.sourceNumber === source.number ? props.backTo : null;
        return (
          <li key={source.number} className="ccc-report-source" data-source={source.number}>
            <h5 tabIndex={-1}>
              {`${source.number}. `}
              <UntrustedText text={title.text} />
              {title.shortened ? (
                <span className="ccc-field-help">{` ${TEXT_SHORTENED}`}</span>
              ) : null}
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
          </li>
        );
      })}
    </ol>
  );
}
