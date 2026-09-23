/**
 * WCAG 2.2 relative luminance and contrast ratio — the arithmetic behind
 * SC 1.4.3 (contrast minimum, 4.5:1 body text / 3:1 large text) and
 * SC 1.4.11 (non-text contrast, 3:1 for focus rings, badge outlines and any
 * boundary needed to identify a control).
 *
 * Deliberately NOT a dependency. This is the one place where hand-rolling is
 * the correct call: the function IS the thing being asserted, so importing it
 * would mean the accessibility floor is only as trustworthy as a transitive
 * package nobody in this repository reads. Twenty-five lines of arithmetic,
 * transcribed from a public specification and pinned on both sides of the 4.5
 * boundary by its own test, is cheaper to audit than a supply-chain review —
 * and it adds nothing to a bundle that is already 824 KB.
 *
 * Pure and Obsidian-free by design: plan 03-04 reuses this exact seam to
 * audit the real token block in `styles.css`, and `contrast.test.ts` already
 * runs it against the prototype palette so a contrast conflict surfaces at
 * ADR-10 rather than at UAT (research assumption A9).
 */

/** sRGB channel values, 0-255, from a fully opaque colour. */
interface Channels {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FUNCTIONAL =
  /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/**
 * Parses `#rgb`, `#rrggbb`, `rgb(r, g, b)` and `rgba(r, g, b, 1)`.
 *
 * Throws on an alpha below 1, and on any other notation. Both refusals are
 * deliberate. A translucent colour has no single contrast ratio — it depends
 * entirely on what is composited behind it — so returning a number for one
 * would be inventing the very value the caller is asking the test to verify.
 * `--ccc-border` is translucent by design and is therefore excluded from
 * every text pair rather than silently approximated. Named colours and other
 * notations throw rather than defaulting, because a token that fails to parse
 * must fail the audit, never skip it.
 */
function parseColor(color: string): Channels {
  const value = color.trim();

  const short = HEX_SHORT.exec(value);
  if (short?.[1] && short[2] && short[3]) {
    return {
      r: Number.parseInt(`${short[1]}${short[1]}`, 16),
      g: Number.parseInt(`${short[2]}${short[2]}`, 16),
      b: Number.parseInt(`${short[3]}${short[3]}`, 16),
    };
  }

  const long = HEX_LONG.exec(value);
  if (long?.[1] && long[2] && long[3]) {
    return {
      r: Number.parseInt(long[1], 16),
      g: Number.parseInt(long[2], 16),
      b: Number.parseInt(long[3], 16),
    };
  }

  const functional = RGB_FUNCTIONAL.exec(value);
  if (functional?.[1] && functional[2] && functional[3]) {
    const alpha = functional[4] === undefined ? 1 : Number.parseFloat(functional[4]);
    if (alpha < 1) {
      throw new Error(
        `contrast: refusing a translucent colour (alpha ${alpha}) — "${color}" has no single ` +
          "contrast ratio; it depends on what is behind it.",
      );
    }
    return {
      r: Number.parseFloat(functional[1]),
      g: Number.parseFloat(functional[2]),
      b: Number.parseFloat(functional[3]),
    };
  }

  throw new Error(
    `contrast: unsupported colour notation "${color}". Use #rgb, #rrggbb, rgb(r, g, b) ` +
      "or rgba(r, g, b, 1).",
  );
}

/**
 * Linearises one 8-bit sRGB channel, per the WCAG 2.2 definition: divide by
 * 12.92 below the 0.03928 knee, otherwise apply the 2.4 gamma curve.
 */
function linearise(channel8Bit: number): number {
  const channel = channel8Bit / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * Relative luminance per WCAG 2.2: the ITU-R BT.709 luma coefficients applied
 * to the linearised channels. 0 for black, 1 for white.
 *
 * @throws if the colour is translucent or in an unsupported notation.
 */
export function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/**
 * Contrast ratio per WCAG 2.2: `(Llighter + 0.05) / (Ldarker + 0.05)`, which
 * ranges from 1 (identical) to 21 (black against white).
 *
 * Symmetric by construction — the lighter colour is selected rather than
 * assumed to be the first argument — so a caller cannot get a ratio below 1
 * by passing foreground and background the other way round.
 *
 * @throws if either colour is translucent or in an unsupported notation.
 */
export function contrastRatio(a: string, b: string): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}
