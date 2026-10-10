import type { VNode } from "preact";
import { DESTINATIONS, type DestinationId } from "./destinations.js";

/**
 * The command center's tab strip (WAI-ARIA tabs, A11Y-01), extracted from the
 * shell so the visual harness can render the real markup, including the Agent
 * runs count chip, without the shell's host dependencies.
 *
 * Presentational: it owns no state. The shell supplies the selection, the
 * pending count, the tab refs it focuses and the handlers.
 */

const COUNT_CAP = 9;
const COUNT_PLURALS = new Intl.PluralRules("en");

/**
 * The Agent runs tab's pending-approval chip (UI-SPEC S6, E13). A sibling of
 * the tab label, so the label itself is unchanged (SC-6): the visible number
 * is `aria-hidden` and capped at `9+`, and a visually hidden sentence carries
 * the true count into the tab's accessible name. Never accent, never danger.
 */
export function ApprovalCountChip({ count }: { readonly count: number }): VNode {
  const visible = count > COUNT_CAP ? `${COUNT_CAP}+` : String(count);
  const spoken =
    COUNT_PLURALS.select(count) === "one"
      ? `, ${count} approval request needs your decision`
      : `, ${count} approval requests need your decision`;
  return (
    <>
      <span className="ccc-nav-count" aria-hidden="true">
        {visible}
      </span>
      <span className="ccc-visually-hidden">{spoken}</span>
    </>
  );
}

export interface DestinationTabsProps {
  readonly activeId: DestinationId;
  /** Pending approval requests, or `null` before the first snapshot. */
  readonly pendingCount: number | null;
  readonly tabRefs?: { current: Partial<Record<DestinationId, HTMLButtonElement>> } | undefined;
  readonly onSelect?: ((id: DestinationId) => void) | undefined;
  readonly onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
}

export function DestinationTabs({
  activeId,
  pendingCount,
  tabRefs,
  onSelect,
  onKeyDown,
}: DestinationTabsProps): VNode {
  return (
    <div
      role="tablist"
      aria-label="Command center destinations"
      className="ccc-nav"
      onKeyDown={onKeyDown}
    >
      {DESTINATIONS.map((destination) => {
        const selected = destination.id === activeId;
        return (
          <button
            key={destination.id}
            type="button"
            role="tab"
            id={`ccc-tab-${destination.id}`}
            aria-selected={selected}
            aria-controls={`ccc-panel-${destination.id}`}
            tabIndex={selected ? 0 : -1}
            className="ccc-nav-item"
            ref={(el) => {
              if (el && tabRefs !== undefined) tabRefs.current[destination.id] = el;
            }}
            onClick={() => onSelect?.(destination.id)}
          >
            {destination.label}
            {destination.id === "agent-runs" && pendingCount !== null && pendingCount > 0 ? (
              <ApprovalCountChip count={pendingCount} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
