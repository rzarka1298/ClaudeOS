import { signal } from "@preact/signals";

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
