import { TASK_FILTERS, type TaskFilter } from "@ccc/domain/tasks.js";
import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { nextToolbarIndex } from "../widgets/toolbar-keys.js";
import { chipName, chipText, TASK_FILTERS_LABEL } from "./tasks-copy.js";

/**
 * The filter chip toolbar (UI-SPEC S3 "Filter chips", S4, R-12, accessibility
 * floors 1 and 10). One `role="toolbar"` Tab stop with a roving tabindex driven
 * by the same pure helper the Phase 4 toolbars use, so wrap-around and
 * Home/End never diverge from them.
 *
 * Props-driven so the global destination and a project panel share it and
 * share no state: the parent says which chips exist, which is pressed and what
 * the counts are. It imports no signal, service client or `obsidian`.
 */
export interface TaskChipsProps {
  readonly active: TaskFilter;
  /** Every chip's count, or `null` while they load (the chips then render without counts). */
  readonly counts: Readonly<Partial<Record<TaskFilter, number>>> | null;
  /** The chips to show, in order. Defaults to all eight; a project panel omits Project. */
  readonly filters?: readonly TaskFilter[] | undefined;
  readonly onSelect: (filter: TaskFilter) => void;
}

export function TaskChips({
  active,
  counts,
  filters = TASK_FILTERS,
  onSelect,
}: TaskChipsProps): VNode {
  const activeIndex = filters.indexOf(active);
  const [focusedIndex, setFocusedIndex] = useState(Math.max(0, activeIndex));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // The tab stop follows the pressed chip when the parent changes it.
  useEffect(() => {
    if (activeIndex >= 0) setFocusedIndex(activeIndex);
  }, [activeIndex]);

  function handleKeyDown(event: KeyboardEvent, index: number): void {
    const next = nextToolbarIndex(index, event.key, filters.length);
    if (next === index) return;
    event.preventDefault();
    setFocusedIndex(next);
    buttons.current[next]?.focus();
  }

  return (
    <div role="toolbar" aria-label={TASK_FILTERS_LABEL} className="ccc-filter-group">
      {filters.map((filter, index) => {
        const count = counts?.[filter] ?? null;
        return (
          <button
            key={filter}
            type="button"
            className="ccc-filter-chip"
            data-filter={filter}
            aria-pressed={filter === active ? "true" : "false"}
            aria-label={count === null ? undefined : chipName(filter, count)}
            tabIndex={index === focusedIndex ? 0 : -1}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            onFocus={() => setFocusedIndex(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onClick={() => onSelect(filter)}
          >
            {chipText(filter, count)}
          </button>
        );
      })}
    </div>
  );
}
