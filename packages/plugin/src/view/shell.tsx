import { useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { connectionState, lastEvent } from "../connection-state.js";
import { DESTINATIONS, type DestinationId, nextDestination } from "./destinations.js";

export interface ShellProps {
  /** The destination selected before this render — usually the last-saved one (PLUG-05). */
  initialDestination?: DestinationId;
  /** Called whenever the user selects a different destination, so the host can persist it. */
  onDestinationChange?: (id: DestinationId) => void;
}

function connectionStatusText(state: ConnectionState): string {
  switch (state.kind) {
    case "live":
      return "Live";
    case "disconnected":
      return `Disconnected — ${state.reason}`;
    default:
      return "Connecting…";
  }
}

/**
 * The structural command-center shell (PLUG-01, PLUG-02, PLUG-04, PERF-01).
 * Renders synchronously from {@link connectionState}'s current signal value
 * and never awaits a client — see `command-center-view.ts` for where the
 * connection probe actually happens, always after this component's first
 * paint. Structural markup and Obsidian's own CSS custom properties only;
 * the visual direction is selected from prototypes in Phase 3.
 */
export function Shell({ initialDestination, onDestinationChange }: ShellProps) {
  const [activeId, setActiveId] = useState<DestinationId>(initialDestination ?? "overview");
  const tabRefs = useRef<Partial<Record<DestinationId, HTMLButtonElement>>>({});

  function select(id: DestinationId): void {
    setActiveId(id);
    onDestinationChange?.(id);
  }

  function handleNavKeyDown(event: KeyboardEvent): void {
    let direction: "next" | "previous" | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") direction = "next";
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") direction = "previous";
    if (!direction) return;
    event.preventDefault();
    const nextId = nextDestination(activeId, direction);
    select(nextId);
    tabRefs.current[nextId]?.focus();
  }

  const active = DESTINATIONS.find((d) => d.id === activeId) ?? DESTINATIONS[0];
  const status = connectionState.value;
  const event = lastEvent.value;

  return (
    <div className="ccc-command-center">
      <div className="ccc-connection-status" data-state={status.kind}>
        <span className="ccc-status-dot" aria-hidden="true" />
        <span className="ccc-status-text">{connectionStatusText(status)}</span>
        {event && (
          <span className="ccc-last-event-text">
            {`Last event: ${event.type} at ${event.occurredAt}`}
          </span>
        )}
      </div>
      <div
        role="tablist"
        aria-label="Command center destinations"
        className="ccc-nav"
        onKeyDown={handleNavKeyDown}
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
                if (el) tabRefs.current[destination.id] = el;
              }}
              onClick={() => select(destination.id)}
            >
              {destination.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`ccc-panel-${active.id}`}
        aria-labelledby={`ccc-tab-${active.id}`}
        className="ccc-content"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the WAI-ARIA tabs pattern requires the tabpanel to be focusable (A11Y-01) — Biome doesn't know role="tabpanel" makes this interactive.
        tabIndex={0}
      >
        <h2>{active.label}</h2>
        <p>{active.description}</p>
      </div>
    </div>
  );
}
