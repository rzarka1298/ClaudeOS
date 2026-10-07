import { TASK_PAGE_SIZE, type TaskAttentionItem } from "@ccc/domain/tasks.js";
import type { VNode } from "preact";
import { useId } from "preact/hooks";
import {
  ATTENTION_HEADING,
  DISCONNECTED_REASON,
  formatCount,
  showMoreLabel,
} from "./tasks-copy.js";
import {
  ATTENTION_INTRO,
  ATTENTION_MISSING_ID,
  ATTENTION_UNREADABLE,
  attentionDuplicate,
  OPEN_NOTE_LABEL,
} from "./tasks-forms-copy.js";

/**
 * The notes-need-attention list (UI-SPEC S3 "Notes need attention list", D-37,
 * T-06-21): the task notes the index leaves out because they share an id, lack
 * one or cannot be read. Props-driven: the loaded entries, the service's total,
 * the connection fact and two functions. It offers exactly two controls, Open
 * note and Show more; nothing here mints, rewrites or merges an id, and nothing
 * is resolved for the owner.
 *
 * Titles, file names and paths are untrusted text and render as text nodes only.
 * `Open note` stays enabled while the service is away (UI-SPEC R-32); `Show
 * more` needs the service and is `aria-disabled` with the standard reason.
 */
export interface AttentionListProps {
  /** The entries loaded so far. */
  readonly items: readonly TaskAttentionItem[];
  /** The service's total, which may exceed the loaded entries. */
  readonly total: number;
  readonly hasMore: boolean;
  readonly connected: boolean;
  readonly onShowMore: () => void;
  readonly onOpenNote: (path: string) => void;
}

/** The last path segment: the file name. */
function fileName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

function reasonLine(item: TaskAttentionItem): string {
  switch (item.reason) {
    case "duplicate-id":
      return attentionDuplicate(item.otherPaths.map(fileName));
    case "missing-id":
      return ATTENTION_MISSING_ID;
    case "unreadable":
      return ATTENTION_UNREADABLE;
  }
}

export function AttentionList(props: AttentionListProps): VNode | null {
  const uid = useId();
  if (props.total === 0 && props.items.length === 0) return null;
  const headingId = `${uid}-heading`;
  const reasonId = `${uid}-reason`;
  const remaining = Math.max(0, props.total - props.items.length);

  return (
    <section className="ccc-attention" aria-labelledby={headingId}>
      <h3 id={headingId}>{`${ATTENTION_HEADING} (${formatCount(props.total)})`}</h3>
      <p className="ccc-field-help">{ATTENTION_INTRO}</p>
      <ul className="ccc-attention-list">
        {props.items.map((item) => {
          const name = item.title ?? fileName(item.path);
          return (
            <li className="ccc-attention-row" key={item.path}>
              <span className="ccc-attention-title" title={name}>
                {name}
              </span>
              <span className="ccc-field-help">{reasonLine(item)}</span>
              <span className="ccc-attention-path">{item.path}</span>
              <button
                type="button"
                className="ccc-connect-button"
                data-variant="secondary"
                aria-label={`${OPEN_NOTE_LABEL}: ${name}`}
                onClick={() => props.onOpenNote(item.path)}
              >
                {OPEN_NOTE_LABEL}
              </button>
            </li>
          );
        })}
      </ul>
      {!props.connected && props.hasMore && (
        <p className="ccc-field-help" id={reasonId}>
          {DISCONNECTED_REASON}
        </p>
      )}
      {props.hasMore && remaining > 0 && (
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          aria-disabled={props.connected ? undefined : "true"}
          aria-describedby={props.connected ? undefined : reasonId}
          onClick={() => {
            if (props.connected) props.onShowMore();
          }}
        >
          {showMoreLabel(Math.min(TASK_PAGE_SIZE, remaining))}
        </button>
      )}
    </section>
  );
}
