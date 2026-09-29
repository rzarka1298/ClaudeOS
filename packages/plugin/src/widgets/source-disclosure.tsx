import type { VNode } from "preact";
import { useId, useRef, useState } from "preact/hooks";

/**
 * The per-section Source disclosure (UI-SPEC "Per-number Source", USAGE-04,
 * D-37, R-09). Mirrors `footer.tsx`'s WidgetFooter disclosure mechanics
 * exactly: a real `<button aria-expanded aria-controls>`, Enter/Space
 * toggles, Escape closes and returns focus, no native `popover`, no
 * tooltip. Its accessible name is "Source" plus a visually hidden suffix
 * ("for plan usage" / "for token activity" / "for estimated cost"), so the
 * three per-card buttons are distinguishable to assistive technology.
 */

export interface SourceDisclosureRow {
  readonly numberLabel: string;
  readonly source: string;
  readonly range: string;
  readonly observed: string;
  readonly freshness: string;
  /** Only present when this number's own value is partial. */
  readonly partial?: string | undefined;
}

export interface SourceDisclosureProps {
  readonly srSuffix: string;
  readonly rows: readonly SourceDisclosureRow[];
  /** aria-disabled while the section has no observation yet (Phase 3
   * footer rule, UI-SPEC "Accessibility additions" #5). */
  readonly disabled?: boolean;
}

export function SourceDisclosure({ srSuffix, rows, disabled }: SourceDisclosureProps): VNode {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelId = `${useId()}-source-panel`;

  function toggle(): void {
    if (disabled === true) return;
    setOpen((wasOpen) => !wasOpen);
  }

  /** Enter and Space are handled explicitly AND their default is
   * prevented — mirrors `footer.tsx`'s handler (jsdom does not synthesize
   * the activation click, and a real browser would otherwise double-fire). */
  function handleButtonKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  }

  /** Escape closes the panel and hands focus back (A11Y-01 floor 5). */
  function handleContainerKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the Escape handler is a keyboard-only affordance for the disclosure this element owns; the element itself is not interactive and gains no role or tabindex.
    <div data-source-disclosure onKeyDown={handleContainerKeyDown}>
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
        {"Source"} <span className="ccc-visually-hidden">{srSuffix}</span>
      </button>
      <div id={panelId} className="ccc-source-panel" hidden={!open}>
        <ul className="ccc-source-list">
          {rows.map((row) => (
            <li key={row.numberLabel} className="ccc-source-row">
              <p>{row.numberLabel}</p>
              <p>{`Source: ${row.source}`}</p>
              <p>{`Range: ${row.range}`}</p>
              <p>{`Observed: ${row.observed}`}</p>
              <p>{`Freshness: ${row.freshness}`}</p>
              {row.partial !== undefined && <p>{`Partial: ${row.partial}`}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
