import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  closeReader,
  openReader,
  type ReaderState,
  readerState,
} from "../research/reader-state.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { UntrustedText } from "./approval-text.js";
import { ReportFinding } from "./report-finding.js";
import { ReportSources } from "./report-sources.js";
import { formatRunTime } from "./research-format.js";

/**
 * The report reader (plan 07-13; UI-SPEC R4, RSRCH-03/04/05/10, D-23): one article that renders
 * only the service-built, paged view model. It reads the reader state (`research/reader-state.ts`),
 * which loads the findings pages and the sources page in order, and renders every string that came
 * from a source or a model through `UntrustedText` as a text node. It never parses Markdown, never
 * builds a link, an image or a frame, and never writes an inline style.
 *
 * Focus moves to the title once it renders; a citation moves focus to the cited source's heading
 * (an instant scroll, never smooth) and that entry offers the way back to the citation.
 */

export interface ReportReaderProps {
  readonly noteId: string;
  /** Closes the reader and returns to the list. */
  readonly onBack: () => void;
  readonly now: number;
  readonly zone: string;
}

interface CiteOrigin {
  readonly sourceNumber: number;
  readonly itemIndex: number;
}

function readerFor(noteId: string): ReaderState | null {
  const state = readerState.value;
  return state !== null && state.noteId === noteId ? state : null;
}

export function ReportReader(props: ReportReaderProps): VNode {
  const titleId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const focusedFor = useRef<string | null>(null);
  const [backTo, setBackTo] = useState<CiteOrigin | null>(null);
  const { noteId } = props;

  useEffect(() => {
    focusedFor.current = null;
    setBackTo(null);
    void openReader(noteId);
    return () => {
      closeReader();
    };
  }, [noteId]);

  const state = readerFor(noteId);
  const header = state?.header ?? null;

  // Focus moves to the title once it renders, once per opened report.
  useEffect(() => {
    if (header !== null && focusedFor.current !== noteId) {
      focusedFor.current = noteId;
      titleRef.current?.focus();
    }
  }, [header, noteId]);

  function jumpToSource(sourceNumber: number, itemIndex: number): void {
    const target = rootRef.current?.querySelector<HTMLElement>(
      `li.ccc-report-source[data-source="${sourceNumber}"] h5`,
    );
    if (target === null || target === undefined) return;
    target.scrollIntoView({ block: "nearest" });
    target.focus({ preventScroll: true });
    setBackTo({ sourceNumber, itemIndex });
  }

  function backToFinding(itemIndex: number, sourceNumber: number): void {
    rootRef.current
      ?.querySelector<HTMLElement>(`button[data-cite="${itemIndex}-${sourceNumber}"]`)
      ?.focus();
    setBackTo(null);
  }

  if (state === null || header === null) {
    return (
      <article
        className="ccc-report-reader"
        aria-labelledby={titleId}
        aria-busy="true"
        ref={rootRef}
      >
        <span id={titleId} className="ccc-visually-hidden">
          Loading report
        </span>
        <span className="ccc-skeleton-line" aria-hidden="true" />
      </article>
    );
  }

  return (
    <article className="ccc-report-reader" aria-labelledby={titleId} ref={rootRef}>
      <h3 id={titleId} tabIndex={-1} ref={titleRef}>
        <UntrustedText text={header.title} />
      </h3>
      <p className="ccc-report-meta">
        {`Generated ${formatRunTime(header.generatedAt, props.now, props.zone)} (${formatRelativeTime(header.generatedAt, props.now)})`}
      </p>
      <section>
        <h4>Findings</h4>
        <ol className="ccc-report-items">
          {state.items.map((item) => (
            <ReportFinding key={item.index} item={item} onCite={jumpToSource} />
          ))}
        </ol>
        {state.itemsTruncated ? (
          <p className="ccc-report-truncated">
            Some items were too long to show here. Open the note to read them in full.
          </p>
        ) : null}
      </section>
      <section>
        <h4>Sources</h4>
        {state.sources === null ? null : (
          <ReportSources sources={state.sources} backTo={backTo} onBackToFinding={backToFinding} />
        )}
      </section>
    </article>
  );
}
