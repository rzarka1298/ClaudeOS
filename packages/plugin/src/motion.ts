import { signal } from "@preact/signals";
import type { HostRegistry } from "./host-registry.js";

/**
 * Reduced motion, resolved exactly once (ADR-0023 `## Reduced motion`, D-19,
 * A11Y-03).
 *
 * The decision is stateful — it has two inputs, the plugin setting and the OS
 * `prefers-reduced-motion` query — so it lives in TypeScript, in this one
 * function. Its effect is token-level, so it lives in CSS, in the one
 * `[data-motion="reduced"]` block of `styles.css`. Between them sits a single
 * `data-motion` attribute on the `.ccc-command-center` root.
 *
 * The rejected alternative is a per-component `matchMedia` check. That is how
 * a codebase ends up with three components that respect the setting and one
 * that does not, and it is forbidden by D-19. `motion.test.ts` enforces the
 * prohibition mechanically: it walks the real `packages/plugin/src` tree and
 * asserts the OS query literal sits on exactly one production code line.
 */

/** What the owner asked for in Settings. `auto` defers to the OS. */
export type MotionPreference = "auto" | "reduced";

/** What the root attribute ends up carrying. */
export type MotionMode = "full" | "reduced";

/**
 * The whole decision, in one expression: either input asking to reduce wins.
 *
 * `preference` is untrusted input — it arrives from a hand-edited or stale
 * `data.json` (threat T-03-12) — so anything that is not the literal
 * `"reduced"` is treated as `auto` and defers to the OS, rather than throwing
 * or silently forcing reduced motion.
 */
export function resolveMotionMode(
  preference: MotionPreference,
  osPrefersReduced: boolean,
): MotionMode {
  return preference === "reduced" || osPrefersReduced ? "reduced" : "full";
}

/**
 * The single resolved mode the shell root renders into `data-motion`.
 * Starts `full`; `attachOsMotionPreference()` corrects it synchronously at
 * load, before the view's first paint.
 */
export const motionMode = signal<MotionMode>("full");

/**
 * The subset of `MediaQueryList` this module reads. Structurally identical to
 * `host-registry.ts`'s `DomTargetLike` on the listener side, which is why a
 * real `MediaQueryList` can be handed straight to `registry.domEvent`.
 */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: string, handler: (ev: unknown) => void): void;
  removeEventListener(type: string, handler: (ev: unknown) => void): void;
}

/**
 * Recomputes {@link motionMode} from the two inputs and writes it. The only
 * place either input is combined; everything else reads the signal.
 */
export function applyMotionPreference(
  preference: MotionPreference,
  mql: Pick<MediaQueryListLike, "matches">,
): MotionMode {
  const mode = resolveMotionMode(preference, mql.matches);
  motionMode.value = mode;
  return mode;
}

/**
 * Subscribes the resolved mode to the OS preference, through the host registry
 * so the listener is released on unload like every other registration
 * (PLUG-03, threat T-03-07 — the twenty-cycle proof in `lifecycle.test.ts`
 * covers it).
 *
 * Reads `mql.matches` immediately rather than waiting for the first change
 * event, so the very first paint already carries the right mode.
 *
 * `settings` is a getter, not a value: the owner can change the plugin setting
 * at any time, and the listener must combine the OS answer with whatever the
 * setting says *then* — not with whatever it said at load.
 *
 * The media query string itself is written in exactly one production place,
 * `main.ts`. That is D-19's "resolved once, never per component", and
 * `motion.test.ts` walks the real source tree to keep it true.
 */
export function attachOsMotionPreference(
  registry: HostRegistry,
  settings: () => MotionPreference,
  mql: MediaQueryListLike,
): void {
  applyMotionPreference(settings(), mql);
  registry.domEvent(mql, "change", (event) => {
    // A real `change` event carries the new `matches`; the deprecated
    // listener shape and a synthetic dispatch may not, so fall back to
    // reading the query itself rather than assuming `false`.
    const matches =
      typeof event === "object" && event !== null && "matches" in event
        ? Boolean(event.matches)
        : mql.matches;
    motionMode.value = resolveMotionMode(settings(), matches);
  });
}
