import { useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
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
 * paint.
 *
 * Every visual value comes from the one `--ccc-*` token block in
 * `styles.css` (ADR-0023, UI-03); this component contributes class names and
 * `data-*` attributes and nothing else — no inline style, no colour, no
 * duration. `data-motion` is the single channel by which the resolved
 * reduced-motion mode reaches CSS (D-19): the component reads the already
 * resolved signal and never checks the OS preference itself.
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
    <div className="ccc-command-center" data-motion={motionMode.value}>
      {/* Decorative atmosphere (D-20): CSS-only gradients plus a fixed set of
          twinkle points whose positions and delays live entirely in
          `styles.css`. Announced to nobody, and static under reduced motion. */}
      <div className="ccc-twinkle" aria-hidden="true">
        <span className="ccc-twinkle-point" key={0} />
        <span className="ccc-twinkle-point" key={1} />
        <span className="ccc-twinkle-point" key={2} />
        <span className="ccc-twinkle-point" key={3} />
        <span className="ccc-twinkle-point" key={4} />
        <span className="ccc-twinkle-point" key={5} />
        <span className="ccc-twinkle-point" key={6} />
        <span className="ccc-twinkle-point" key={7} />
        <span className="ccc-twinkle-point" key={8} />
        <span className="ccc-twinkle-point" key={9} />
        <span className="ccc-twinkle-point" key={10} />
        <span className="ccc-twinkle-point" key={11} />
      </div>
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
