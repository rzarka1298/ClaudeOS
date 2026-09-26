import type { SizeHint } from "@ccc/domain";
import type { ComponentChildren, VNode } from "preact";
import { useId } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { QuickActionDescriptor, WidgetDefinition, WidgetState } from "./contract.js";
import { WidgetFooter } from "./footer.js";
import type { CardPresentation, FooterModel } from "./presentation.js";
import { resolveCardPresentation } from "./presentation.js";
import { formatRelativeTime } from "./relative-time.js";

/**
 * The shared card (UI-06 by construction).
 *
 * Widgets render BODIES; this frame renders the card — header, body slot and
 * footer — so no widget can ship a card without provenance, because no widget
 * renders a card. `data-presentation` and `data-size` are the ONLY styling
 * hooks: there is no inline `style` and no HTML sink anywhere in this tree,
 * which is what keeps untrusted future payloads escaped by Preact and the
 * command center's visuals inside its own root (UI-SPEC Non-Negotiables 1–3).
 */

export interface WidgetFrameProps<T> {
  readonly definition: WidgetDefinition<T>;
  readonly state: WidgetState<T>;
  readonly connection: ConnectionState;
  readonly size?: SizeHint;
  readonly now: number;
  readonly onQuickAction?: (descriptor: QuickActionDescriptor) => void;
}

/** A title used mid-sentence: `Service health` → `service health`. */
function lowerFirst(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}

/** The footer a card shows before its first observation has arrived. */
function pendingFooter(definition: WidgetDefinition<unknown>): FooterModel {
  return {
    observedAt: null,
    freshness: null,
    partiality: null,
    sources: definition.dataKeys.map((key) => ({ label: key.sourceLabel, status: "ok" as const })),
  };
}

export function WidgetFrame<T>({
  definition,
  state,
  connection,
  size,
  now,
  onQuickAction,
}: WidgetFrameProps<T>): VNode {
  const presentation: CardPresentation = resolveCardPresentation(
    state,
    connection,
    definition.dataKeys,
  );
  const hint: SizeHint = size ?? definition.preferredSize;
  const titleId = `${useId()}-title`;
  const panel = lowerFirst(definition.title);
  const Body = definition.renderBody;
  const Empty = definition.renderEmpty;

  const body: ComponentChildren = ((): ComponentChildren => {
    switch (presentation.kind) {
      case "loading":
        return (
          <>
            <div className="ccc-skeleton-line" />
            <div className="ccc-skeleton-line" />
            <div className="ccc-skeleton-line" />
            <span className="ccc-visually-hidden">{`Loading ${panel}`}</span>
          </>
        );
      case "empty":
        return (
          <>
            <p className="ccc-state-heading">Nothing here yet</p>
            <p className="ccc-state-body">
              {`${definition.title} has no items right now. New items appear as they arrive.`}
            </p>
            <Empty />
          </>
        );
      case "ready":
      case "stale":
        return state.kind === "ready" ? <Body data={state.data} /> : null;
      case "disconnected":
        return (
          <>
            <p className="ccc-state-heading">Service disconnected</p>
            <p className="ccc-state-body">
              {presentation.lastGood?.observedAt == null
                ? "They may be out of date."
                : `Showing the last values received ${formatRelativeTime(
                    presentation.lastGood.observedAt,
                    now,
                  )}. They may be out of date.`}
            </p>
            {state.kind === "ready" ? <Body data={state.data} /> : null}
          </>
        );
      case "error":
        return (
          <>
            <p className="ccc-state-heading">
              {/* The glyph is decorative reinforcement only — the danger colour
                  is never the sole signal, and the text stands without it
                  (A11Y-04). */}
              <span className="ccc-error-glyph" aria-hidden="true">
                ▲
              </span>
              <span>{`Couldn't load ${panel}.`}</span>
            </p>
            <p className="ccc-state-body">
              Check the service in Settings → Diagnostics, then refresh.
            </p>
          </>
        );
      case "permission-required": {
        const source = presentation.sourceLabel;
        const capability = presentation.capability;
        return (
          <>
            <p className="ccc-state-heading">{`${source} isn't connected`}</p>
            <p className="ccc-state-body">{`Connect ${source} to see ${panel} here.`}</p>
            {/* A DESCRIPTOR goes to one handler prop and nothing runs here
                (C-11, APPR-01, T-03-13). In this phase the dispatcher resolves
                it to the shell's settings destination; Phase 6/7 replaces that
                resolution without touching this button or the contract. */}
            <button
              type="button"
              className="ccc-connect-button"
              onClick={() =>
                onQuickAction?.({
                  id: `connect-${capability}`,
                  label: `Connect ${source}`,
                  capability: `connect:${capability}`,
                })
              }
            >
              {`Connect ${source}`}
            </button>
          </>
        );
      }
      case "unavailable":
        return (
          <>
            <p className="ccc-state-heading">No source yet</p>
            <p className="ccc-state-body">
              {`${definition.title} has no data source in this build. It fills in once its source is available.`}
            </p>
          </>
        );
    }
  })();

  const footerModel: FooterModel =
    presentation.kind === "loading"
      ? pendingFooter(definition as WidgetDefinition<unknown>)
      : presentation.kind === "disconnected"
        ? (presentation.lastGood ?? pendingFooter(definition as WidgetDefinition<unknown>))
        : presentation.footer;

  const showsActions =
    definition.quickActions.length > 0 &&
    (presentation.kind === "ready" || presentation.kind === "stale");

  return (
    <section
      className="ccc-card"
      data-presentation={presentation.kind}
      data-size={hint}
      aria-labelledby={titleId}
      aria-busy={presentation.kind === "loading" ? "true" : undefined}
    >
      <header className="ccc-card-header">
        <h3 id={titleId}>{definition.title}</h3>
      </header>
      <div
        className="ccc-card-body"
        data-dimmed={presentation.kind === "disconnected" ? "true" : undefined}
        // A `tall` card's body is the one scrollable region in the card
        // (`overflow-y: auto` in styles.css). A scroll container that is not
        // in the tab order cannot be scrolled without a mouse, so it takes a
        // tabindex — and the focus ring that goes with it (A11Y-01).
        tabIndex={hint === "tall" ? 0 : undefined}
      >
        {body}
        {showsActions && (
          <div className="ccc-card-actions">
            {/* A DESCRIPTOR goes to one handler prop; the frame runs nothing.
                `dispatchQuickAction` is the single place that descriptor is
                resolved, and the single place Phase 6's approval check is
                inserted (C-11, APPR-01, T-03-13). */}
            {definition.quickActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="ccc-quick-action"
                onClick={() => onQuickAction?.(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <WidgetFooter
        model={footerModel}
        panelTitle={panel}
        now={now}
        dimmed={presentation.kind === "disconnected"}
        disabled={presentation.kind === "loading"}
      />
    </section>
  );
}
