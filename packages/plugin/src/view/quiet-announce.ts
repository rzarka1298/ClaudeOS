import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * How the flows the Settings destination embeds stay quiet (FIX2B M1).
 *
 * The destination owns the one live region (its status line). A flow that is given an
 * {@link Announce} keeps showing its status words in a plain, non-live element (no `role`, no
 * `aria-live`) and hands the same words to `announce` whenever its status changes, so every
 * outcome is spoken once, by the one line. Without it (the Projects destination, a standalone
 * mount) the flow keeps its own `role="status"` region exactly as before.
 */

/** Posts a message to the destination's one status line. */
export type Announce = (message: string) => void;

/** The `role` a flow's status element carries: a live region on its own, none when it is quiet. */
export function statusRole(announce: Announce | undefined): "status" | undefined {
  return announce === undefined ? "status" : undefined;
}

/**
 * What a screen reader would say for `element`: the text without `aria-hidden` glyphs (the
 * decorative triangle and tick), blocks and line breaks read as separate sentences, whitespace
 * collapsed.
 */
export function accessibleText(element: Element | null): string {
  if (element === null) return "";
  const clone = element.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  for (const block of clone.querySelectorAll("br, p, div, li")) block.after(" ");
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Returns a ref for the status element and, when `announce` is set, posts its text each time
 * `change` takes a new identity AFTER the first render: mounting a section never announces what
 * it was already holding (a section change is not an outcome). `change` must be a new value for
 * every event, so a repeated identical outcome announces again. `enabled` lets a caller skip
 * changes that are not outcomes (an automatic detection on open).
 */
export function useAnnounceOnChange<T extends Element>(
  announce: Announce | undefined,
  change: unknown,
  enabled: () => boolean = () => true,
): RefObject<T> {
  const ref = useRef<T>(null);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const say = announceRef.current;
    if (say === undefined || !enabledRef.current()) return;
    const text = accessibleText(ref.current);
    if (text !== "") say(text);
  }, [change]);
  return ref;
}
