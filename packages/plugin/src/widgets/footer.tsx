import type { Freshness } from "@ccc/domain";
import type { VNode } from "preact";
import { useId, useRef, useState } from "preact/hooks";
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
export const FRESHNESS_GLYPH: Readonly<Record<Freshness, string>> = {
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

/**
 * The partial chip's detail, pluralised with `Intl.PluralRules` so the count
 * never reads "1 sources" (UI-SPEC zero-one-many row).
 */
const PLURAL = new Intl.PluralRules("en");

function missingSourcesText(missing: readonly string[]): string {
  const noun = PLURAL.select(missing.length) === "one" ? "source" : "sources";
  return `${missing.length} ${noun} didn't respond: ${missing.join(", ")}`;
}

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
  const [timeFocused, setTimeFocused] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();
  const panelId = `${baseId}-source-panel`;
  const absoluteId = `${baseId}-absolute-time`;

  const absolute = model.observedAt === null ? null : formatAbsoluteTime(model.observedAt);
  const relative = model.observedAt === null ? "—" : formatRelativeTime(model.observedAt, now);
  const missing = model.partiality?.partial === true ? (model.partiality.missingSources ?? []) : [];

  function toggle(): void {
    if (disabled === true) return;
    setOpen((wasOpen) => !wasOpen);
  }

  /**
   * Enter and Space are handled explicitly AND their default is prevented.
   * Without the handler the disclosure would be untestable under jsdom (which
   * does not synthesize the activation click); without `preventDefault` a real
   * browser would then fire that click too and toggle twice.
   */
  function handleButtonKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  }

  /** Escape closes the panel and hands focus back (A11Y-01 floor 5). */
  function handleFooterKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for the disclosure this footer owns; the footer itself is not interactive and gains no role or tabindex.
    <footer
      className="ccc-card-footer"
      data-dimmed={dimmed === true ? "true" : undefined}
      onKeyDown={handleFooterKeyDown}
    >
      {/* The absolute timestamp reaches HOVER through `title` and KEYBOARD
          FOCUS through this element (D-16, A11Y-01). `title` alone is not
          keyboard-reachable, and an `aria-describedby` on an element that can
          never take focus is never announced (judge-r1 finding 2), so the time
          joins the tab order whenever there is an absolute time to show, wears
          the shared focus ring, and while focused reveals that time as visible
          text rather than only as a description. */}
      <time
        className="ccc-footer-time"
        dateTime={model.observedAt ?? undefined}
        title={absolute ?? undefined}
        aria-describedby={absolute === null ? undefined : absoluteId}
        // Focusable only while a timestamp exists; it gains no role and no action.
        tabIndex={absolute === null ? undefined : 0}
        onFocus={() => setTimeFocused(true)}
        onBlur={() => setTimeFocused(false)}
      >
        {relative}
      </time>
      {absolute !== null && (
        <span
          id={absoluteId}
          className={timeFocused ? "ccc-footer-absolute" : "ccc-visually-hidden"}
        >
          {absolute}
        </span>
      )}
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
      {missing.length > 0 && (
        // An INDEPENDENT chip beside the freshness chip, never merged into it:
        // ADR-0002 makes partiality orthogonal to freshness, and two
        // same-shaped chips are what make that independence visible.
        <span className="ccc-badge" data-badge="partial">
          <span className="ccc-badge-glyph" aria-hidden="true">
            ◈
          </span>
          <span className="ccc-badge-label">Partial</span>
          <span className="ccc-visually-hidden">{` — ${missingSourcesText(missing)}`}</span>
        </span>
      )}
      <button
        type="button"
        className="ccc-source-button"
        ref={buttonRef}
        aria-expanded={open}
        aria-controls={panelId}
        aria-disabled={disabled === true ? "true" : undefined}
        onClick={toggle}
        onKeyDown={handleButtonKeyDown}
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
