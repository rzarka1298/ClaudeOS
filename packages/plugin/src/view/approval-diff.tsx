import { APPROVAL_TEXT_CAPS, type ViewChange } from "@ccc/domain/approval-view.js";
import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { UntrustedText } from "./approval-text.js";
import {
  ADDED_MARKER,
  CHANGES_LABEL,
  NO_CHANGE,
  REMOVED_MARKER,
  SHOW_FEWER_LINES,
  showAllLines,
  UNCHANGED_PREFIX,
  unchangedLines,
} from "./approvals-copy.js";

/**
 * The change block (UI-SPEC S2 "Diff block"): a plain monospace ordered list,
 * a visible glyph and word on changed lines, no colour, the first forty lines
 * and a disclosure for the rest. Every line is requester-derived or
 * engine-derived text and reaches the DOM only through {@link UntrustedText}.
 *
 * The markers are text, not CSS content, so they survive forced colours and a
 * screen reader reads them (A11Y-04).
 */

/** The lines shown before the disclosure. */
export const DIFF_COLLAPSED_LINES = 40;

interface Item {
  readonly kind: "added" | "removed" | "context" | "omitted";
  readonly text: string;
  readonly count: number | null;
}

function itemsOf(change: Exclude<ViewChange, { type: "none" }>): readonly Item[] {
  if (change.type === "diff") {
    return change.lines.slice(0, APPROVAL_TEXT_CAPS.diffLines).map((line) => ({
      kind: line.kind,
      text: line.text,
      count: line.count,
    }));
  }
  // A proposed payload is, by definition, a pure addition.
  return change.fields.slice(0, APPROVAL_TEXT_CAPS.diffLines).map((field) => ({
    kind: "added",
    text: `${field.label}: ${field.value}`,
    count: null,
  }));
}

/**
 * True when the change is past the display caps (500 lines or 20,000
 * characters). The service already marks such a view not reviewable; the pane
 * checks again so an over-cap change is never approvable because a flag was
 * wrong (D-16: never approve what you were not shown).
 */
export function changeExceedsCaps(change: ViewChange): boolean {
  if (change.type === "none") return false;
  const parts =
    change.type === "diff"
      ? change.lines.map((line) => line.text.length)
      : change.fields.map((field) => field.label.length + field.value.length + 2);
  const total = parts.reduce((sum, length) => sum + length, 0);
  return parts.length > APPROVAL_TEXT_CAPS.diffLines || total > APPROVAL_TEXT_CAPS.diffChars;
}

function Gutter({ item }: { readonly item: Item }): VNode {
  switch (item.kind) {
    case "added":
      return <span className="ccc-diff-gutter">{ADDED_MARKER}</span>;
    case "removed":
      return <span className="ccc-diff-gutter">{REMOVED_MARKER}</span>;
    case "context":
      return (
        <span className="ccc-diff-gutter">
          <span className="ccc-visually-hidden">{`${UNCHANGED_PREFIX} `}</span>
        </span>
      );
    case "omitted":
      return <span className="ccc-diff-gutter" />;
  }
}

export function ApprovalDiff({ change }: { readonly change: ViewChange }): VNode {
  const [expanded, setExpanded] = useState(false);
  if (change.type === "none") return <p>{NO_CHANGE}</p>;

  const items = itemsOf(change);
  const visible = expanded ? items : items.slice(0, DIFF_COLLAPSED_LINES);
  return (
    <>
      <ol className="ccc-diff" aria-label={CHANGES_LABEL}>
        {visible.map((item, index) => (
          <li className="ccc-diff-line" data-kind={item.kind} key={`${index}-${item.kind}`}>
            <Gutter item={item} />
            <span className="ccc-diff-text">
              {item.kind === "omitted" ? (
                item.count === null ? (
                  "… unchanged lines"
                ) : (
                  unchangedLines(item.count)
                )
              ) : (
                <UntrustedText text={item.text} />
              )}
            </span>
          </li>
        ))}
      </ol>
      {items.length > DIFF_COLLAPSED_LINES && (
        <button
          type="button"
          className="ccc-list-more"
          aria-expanded={expanded ? "true" : "false"}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? SHOW_FEWER_LINES : showAllLines(items.length)}
        </button>
      )}
    </>
  );
}
