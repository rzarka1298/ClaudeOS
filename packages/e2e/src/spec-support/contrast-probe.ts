/**
 * The live-Obsidian contrast probe (Phase 7 live-UAT trial, run da14049b; accessibility constraint
 * "minimum text size and contrast"). Obsidian's own `button`, `select`, `textarea` and `input`
 * rules out-rank a plain `.ccc-*` class, so in the light theme the active tab label and the pill
 * buttons were nearly invisible. The pixel baselines never load those rules; this probe reads the
 * REAL rendered colours in the real Obsidian window, in the theme it runs and in the other one.
 *
 * Two halves, so the browser side stays trivial and the arithmetic is unit-tested:
 *   - `rendererHarvestContrast` runs in the renderer and only collects computed colours (no named
 *     inner functions or const-bound arrows: wdio's keepNames helper, Wave 2 HIGH-1);
 *   - `measureHarvest` and `contrastFailures` run in Node (WCAG 2.2 SC 1.4.3 and 1.4.11).
 * The same arithmetic lives in packages/test-fixtures/visual/contrast.spec.ts, which runs the
 * stylesheet against stand-ins for both Obsidian themes in the visual harness; a spec there may
 * import only the plugin barrel, so the two are kept in step by hand and by the same numbers.
 */

export const TEXT_FLOOR = 4.5;
export const LARGE_TEXT_FLOOR = 3;
export const NON_TEXT_FLOOR = 3;

/** One thing the page drew, as the browser computed it. */
export interface ContrastSample {
  kind: "text" | "value" | "placeholder";
  where: string;
  text: string;
  color: string;
  /** The element's own background, then each ancestor's, outward. */
  backgrounds: string[];
  opacity: number;
  fontPx: number;
  bold: boolean;
}

export interface FieldEdge {
  where: string;
  borderColor: string;
  borderWidth: number;
  backgrounds: string[];
  surround: string[];
}

export interface ContrastHarvest {
  samples: ContrastSample[];
  fields: FieldEdge[];
  unreadable: string[];
}

/** The theme classes Obsidian puts on `body`. */
export type ObsidianBase = "theme-light" | "theme-dark";

/** What the renderer found out about the theme before the probe changed it. */
export interface ThemeSwitch {
  /** The base the window was in (null when neither class was on `body`). */
  was: ObsidianBase | null;
  /** The base it is in now. */
  now: ObsidianBase | null;
}

/**
 * Puts `body` in the given Obsidian base theme by swapping its class (the theme variables hang off
 * `.theme-light` and `.theme-dark`), or, with `null`, takes the class off, and reports what it was.
 * The caller puts the old base back; nothing is written to Obsidian's settings.
 */
export function rendererSetBase(base: ObsidianBase | null): ThemeSwitch {
  const body = (
    globalThis as {
      document?: {
        body?: {
          classList: {
            contains: (name: string) => boolean;
            add: (name: string) => void;
            remove: (name: string) => void;
          };
        };
      };
    }
  ).document?.body;
  if (body === undefined) return { was: null, now: null };
  let was: ObsidianBase | null = null;
  if (body.classList.contains("theme-light")) was = "theme-light";
  else if (body.classList.contains("theme-dark")) was = "theme-dark";
  body.classList.remove("theme-light");
  body.classList.remove("theme-dark");
  if (base !== null) body.classList.add(base);
  return { was, now: base };
}

/** The slice of the DOM the harvest reads; the e2e package carries no DOM lib. */
interface HarvestStyle {
  display: string;
  visibility: string;
  opacity: string;
  backgroundColor: string;
  color: string;
  fontSize: string;
  fontWeight: string;
  borderTopColor: string;
  borderTopWidth: string;
}

interface HarvestElement {
  tagName: string;
  parentElement: HarvestElement | null;
  childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
  value?: string;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { width: number; height: number };
  closest: (selector: string) => unknown;
  querySelectorAll: (selector: string) => ArrayLike<HarvestElement>;
}

interface HarvestWindow {
  document?: { querySelector: (selector: string) => HarvestElement | null };
  getComputedStyle: (element: HarvestElement, pseudo?: string) => HarvestStyle;
}

/**
 * Collects the computed colours of every visible text, form value and placeholder under the
 * command center, and of every form field's edge. Disabled controls are exempt (SC 1.4.3); a
 * control that only looks disabled (`aria-disabled`) carries no action and is exempt too.
 */
export function rendererHarvestContrast(rootSelector: string): ContrastHarvest {
  const win = globalThis as unknown as HarvestWindow;
  const root = win.document?.querySelector(rootSelector) ?? null;
  const samples: ContrastSample[] = [];
  const fields: FieldEdge[] = [];
  const unreadable: string[] = [];
  if (root === null) {
    return { samples, fields, unreadable: [`no element matches ${rootSelector}`] };
  }
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (el.closest(".ccc-visually-hidden") !== null) continue;
    if (el.closest(":disabled, [aria-disabled='true'], [disabled]") !== null) continue;
    const style = win.getComputedStyle(el);
    let hidden = false;
    let opacity = 1;
    const own: string[] = [];
    const above: string[] = [];
    let node: HarvestElement | null = el;
    while (node !== null) {
      const nodeStyle = win.getComputedStyle(node);
      if (nodeStyle.display === "none" || nodeStyle.visibility === "hidden") hidden = true;
      opacity *= Number.parseFloat(nodeStyle.opacity);
      own.push(nodeStyle.backgroundColor);
      if (node !== el) above.push(nodeStyle.backgroundColor);
      node = node.parentElement;
    }
    if (hidden) continue;
    const where = `${el.tagName.toLowerCase()}${
      el.getAttribute("class") === null
        ? ""
        : `.${(el.getAttribute("class") ?? "").trim().split(/\s+/).slice(0, 2).join(".")}`
    }${el.getAttribute("role") === null ? "" : `[role=${el.getAttribute("role")}]`}`;
    const base = {
      where,
      color: style.color,
      backgrounds: own,
      opacity,
      fontPx: Number.parseFloat(style.fontSize),
      bold: Number.parseInt(style.fontWeight, 10) >= 600,
    };
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = el.getAttribute("type");
      if (type === "radio" || type === "checkbox" || type === "hidden") continue;
      const field = el;
      const typed = field.value ?? "";
      samples.push({ ...base, kind: "value", text: typed === "" ? `(empty ${tag})` : typed });
      if (el.getAttribute("placeholder") !== null && typed === "") {
        samples.push({
          ...base,
          kind: "placeholder",
          text: el.getAttribute("placeholder") ?? "",
          color: win.getComputedStyle(el, "::placeholder").color,
        });
      }
      fields.push({
        where,
        borderColor: style.borderTopColor,
        borderWidth: Number.parseFloat(style.borderTopWidth),
        backgrounds: own,
        surround: above,
      });
      continue;
    }
    let text = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) text += child.textContent ?? "";
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text !== "") samples.push({ ...base, kind: "text", text: text.slice(0, 60) });
  }
  return { samples, fields, unreadable };
}

// ---------------------------------------------------------------------------
// The arithmetic, in Node.
// ---------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function alphaOf(raw: string | undefined): number {
  if (raw === undefined) return 1;
  return raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
}

/** Parses the forms Chromium serialises a computed colour as; null for anything else. */
export function parseColour(css: string): Rgba | null {
  const text = css.trim();
  const legacy =
    /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (legacy !== null) {
    return {
      r: Number(legacy[1]),
      g: Number(legacy[2]),
      b: Number(legacy[3]),
      a: alphaOf(legacy[4]),
    };
  }
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(
    text,
  );
  if (srgb !== null) {
    return {
      r: Number(srgb[1]) * 255,
      g: Number(srgb[2]) * 255,
      b: Number(srgb[3]) * 255,
      a: alphaOf(srgb[4]),
    };
  }
  return null;
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

const CANVAS: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** What a stack of backgrounds (own first, then outward) paints; null when one is unreadable. */
export function paint(backgrounds: readonly string[]): Rgba | null {
  let result: Rgba = CANVAS;
  for (let index = backgrounds.length - 1; index >= 0; index -= 1) {
    const layer = parseColour(backgrounds[index] ?? "");
    if (layer === null) return null;
    result = over(layer, result);
  }
  return result;
}

function luminance(c: Rgba): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2.2 contrast ratio of two opaque colours. */
export function ratio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Measured {
  label: string;
  ratio: number;
  floor: number;
}

function isLarge(sample: ContrastSample): boolean {
  return sample.fontPx >= 24 || (sample.bold && sample.fontPx >= 18.66);
}

/** The contrast of every sample and field edge in a harvest, and what could not be read. */
export function measureHarvest(found: ContrastHarvest): {
  measured: Measured[];
  problems: string[];
} {
  const measured: Measured[] = [];
  const problems = [...found.unreadable];
  for (const sample of found.samples) {
    const label = `${sample.kind} ${sample.where} "${sample.text}"`;
    const background = paint(sample.backgrounds);
    const ink = parseColour(sample.color);
    if (background === null || ink === null) {
      problems.push(`${label}: unreadable colour (${sample.color} on ${sample.backgrounds[0]})`);
      continue;
    }
    const shown = over({ ...ink, a: ink.a * sample.opacity }, background);
    measured.push({
      label,
      ratio: ratio(shown, background),
      floor: isLarge(sample) ? LARGE_TEXT_FLOOR : TEXT_FLOOR,
    });
  }
  for (const field of found.fields) {
    const surround = paint(field.surround);
    const fill = paint(field.backgrounds);
    const edge = parseColour(field.borderColor);
    if (surround === null || fill === null || edge === null) {
      problems.push(`field ${field.where}: unreadable colour`);
      continue;
    }
    const edgeRatio = field.borderWidth > 0 ? ratio(over(edge, surround), surround) : 0;
    measured.push({
      label: `field edge ${field.where}`,
      ratio: Math.max(edgeRatio, ratio(fill, surround)),
      floor: NON_TEXT_FLOOR,
    });
  }
  return { measured, problems };
}

/** Every measurement under its floor, worst first, as lines a failure can print. */
export function contrastFailures(measured: readonly Measured[]): string[] {
  return measured
    .filter((entry) => entry.ratio < entry.floor)
    .sort((a, b) => a.ratio - b.ratio)
    .map((entry) => `${entry.ratio.toFixed(2)}:1 < ${entry.floor}:1  ${entry.label}`);
}

/** The five lowest ratios, for the log of a passing run. */
export function lowestRatios(measured: readonly Measured[], count = 5): string[] {
  return [...measured]
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, count)
    .map((entry) => `${entry.ratio.toFixed(2)}:1 (needs ${entry.floor}) ${entry.label}`);
}

/** The slice of the wdio browser the probe uses. */
export interface ContrastBrowser {
  execute<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<Awaited<T>>;
}

export interface ThemeReading {
  base: ObsidianBase;
  measured: Measured[];
  problems: string[];
  /** The text of the samples, so a spec can check the named subjects were measured. */
  texts: string[];
}

/**
 * Reads the contrast of what is on screen under `rootSelector` in both Obsidian base themes, and
 * puts the window back in the one it was in. Theme switching swaps the class on `body`; nothing
 * is written to Obsidian's configuration.
 */
export async function readContrastInBothThemes(
  browser: ContrastBrowser,
  rootSelector: string,
): Promise<ThemeReading[]> {
  const readings: ThemeReading[] = [];
  const first = await browser.execute(rendererSetBase, "theme-light");
  try {
    for (const base of ["theme-light", "theme-dark"] as const) {
      await browser.execute(rendererSetBase, base);
      const found = await browser.execute(rendererHarvestContrast, rootSelector);
      const { measured, problems } = measureHarvest(found);
      readings.push({ base, measured, problems, texts: found.samples.map((s) => s.text) });
    }
  } finally {
    await browser.execute(rendererSetBase, first.was);
  }
  return readings;
}
