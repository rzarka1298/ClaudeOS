import type { Freshness } from "@ccc/domain";
import type { VNode } from "preact";
import { useId, useState } from "preact/hooks";
import type { FooterModel, SourceStatus } from "./presentation.js";
import { formatAbsoluteTime, formatRelativeTime } from "./relative-time.js";

/**
 * The provenance strip every data-bearing card carries (UI-06, D-16).
 *
 * Four parts in a fixed order — relative time, freshness badge, the
 * independent partial chip, the Source disclosure — rendered by the FRAME, not
 * by the widget, so a widget author cannot ship a card without them.
 *
 * The Source affordance is a real disclosure `<button>` with `aria-expanded`
 * and `aria-controls`, never a tooltip and never the native `popover`
 * attribute: a tooltip is not keyboard-reachable (A11Y-01) and `popover` is
 * unsupported in jsdom, which would make the phase's most-repeated control
 * untestable (03-UI-SPEC "Freshness footer").
 */

const FRESHNESS_LABEL: Readonly<Record<Freshness, string>> = {
  live: "Live",
  cached: "Cached",
  stale: "Stale",
  unavailable: "Unavailable",
};

/**
 * A glyph beside every badge label, so nothing is carried by colour alone
 * (A11Y-04). The glyph is decorative reinforcement — `aria-hidden`, with the
 * label always present as text.
 */
const FRESHNESS_GLYPH: Readonly<Record<Freshness, string>> = {
  live: "●",
  cached: "◐",
  stale: "◔",
  unavailable: "○",
};

const SOURCE_STATUS_TEXT: Readonly<Record<SourceStatus, string>> = {
  ok: "ok",
  missing: "no response",
  disconnected: "disconnected",
  failed: "failed",
  "no-source": "no source yet",
  "not-connected": "not connected",
};

export interface WidgetFooterProps {
  readonly model: FooterModel;
  /** The owning card's title, lowercased for mid-sentence use. */
  readonly panelTitle: string;
  readonly now: number;
  readonly dimmed?: boolean;
  readonly disabled?: boolean;
}

export function WidgetFooter({
  model,
  panelTitle,
  now,
  dimmed,
  disabled,
}: WidgetFooterProps): VNode {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const panelId = `${baseId}-source-panel`;

  const absolute = model.observedAt === null ? null : formatAbsoluteTime(model.observedAt);
  const relative = model.observedAt === null ? "—" : formatRelativeTime(model.observedAt, now);

  function toggle(): void {
    if (disabled === true) return;
    setOpen((wasOpen) => !wasOpen);
  }

  return (
    <footer className="ccc-card-footer" data-dimmed={dimmed === true ? "true" : undefined}>
      <time
        className="ccc-footer-time"
        dateTime={model.observedAt ?? undefined}
        title={absolute ?? undefined}
      >
        {relative}
      </time>
      {model.freshness !== null && (
        <span className="ccc-badge" data-badge={model.freshness}>
          <span className="ccc-badge-glyph" aria-hidden="true">
            {FRESHNESS_GLYPH[model.freshness]}
          </span>
          {/* The accessible name is composed from a visually hidden prefix plus
              the visible label, not an `aria-label`: `aria-label` on a generic
              <span> is ignored by assistive technology (and is a lint error).
              The result reads "Freshness: Live" (A11Y-04). */}
          <span className="ccc-visually-hidden">Freshness: </span>
          <span className="ccc-badge-label">{FRESHNESS_LABEL[model.freshness]}</span>
        </span>
      )}
      <button
        type="button"
        className="ccc-source-button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-disabled={disabled === true ? "true" : undefined}
        onClick={toggle}
      >
        Source
      </button>
      <div id={panelId} className="ccc-source-panel" hidden={!open}>
        <p className="ccc-visually-hidden">{`Sources for ${panelTitle}`}</p>
        <ul className="ccc-source-list">
          {model.sources.map((source) => (
            <li key={source.label} className="ccc-source-row">
              {`${source.label} — ${SOURCE_STATUS_TEXT[source.status]}`}
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
