import { expect, type Page, test } from "@playwright/test";

/**
 * The contrast guard (Phase 7 live-UAT trial, run da14049b; accessibility constraint "minimum
 * text size and contrast"). It renders the real destinations from the same isolated harness as
 * the pixel specs, once under a LIGHT and once under a DARK stand-in for Obsidian's own control
 * and theme rules (`harness/obsidian-base.css`, loaded by `?host=light|dark`), and measures the
 * rendered colours. It takes no screenshot and writes no baseline.
 *
 * Why it exists. The command center is a dark surface inside Obsidian. Obsidian's global
 * `button`, `select`, `textarea` and `input` rules out-rank a plain class selector, so a control
 * kept the command center's light ink but took the theme's light face: the active tab label,
 * the pill buttons, the source chips and the Description field came out nearly invisible. The
 * pixel baselines never loaded those rules, so they could not see it.
 *
 * What it checks, per page and per host theme (WCAG 2.2):
 *   - SC 1.4.3  every visible text, form value and placeholder: 4.5:1, or 3:1 for large text;
 *   - SC 1.4.11 a form field's edge (or its fill) against its surround: 3:1;
 *   - SC 1.4.11 the keyboard focus ring of the tab, a pill button and a form field: 3:1.
 * Disabled controls are exempt (SC 1.4.3), as the standard says; a control that only looks
 * disabled (`aria-disabled`) is exempt too, because it carries no action. The measured colours are
 * the browser's computed ones, composited over every background behind them. Gradients are not
 * sampled: the only one is the decorative atmosphere layer, `pointer-events: none` and below
 * the content.
 *
 * `contrast-guard` tests carry no `baseline` annotation on purpose: they own no image.
 */

const HARNESS_PAGE = new URL("../harness/index.html", import.meta.url);

/** An annotation that tells `scripts/list-visual-baselines.mjs` this test owns no image. */
const NO_BASELINE_ANNOTATION = "contrast-guard";

function harnessUrl(params: Readonly<Record<string, string>>): string {
  const url = new URL(HARNESS_PAGE);
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

const TEXT_FLOOR = 4.5;
const LARGE_TEXT_FLOOR = 3;
const NON_TEXT_FLOOR = 3;

type Host = "light" | "dark";
const HOSTS: readonly Host[] = ["light", "dark"];

interface PageSpec {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  /** Text every page must show, so an empty or wrong render can never pass. */
  readonly mustSample: readonly string[];
}

const PAGES: readonly PageSpec[] = [
  {
    name: "research reader and tabs",
    params: { view: "research", case: "research-report-full", width: "full", nav: "1" },
    mustSample: [
      "RESEARCH",
      "Overview",
      "Back to reports",
      "Open note",
      "Cached",
      "[1]",
      "Quoted from source",
    ],
  },
  {
    name: "research reader narrow",
    params: { view: "research", case: "research-report-full", width: "narrow", nav: "1" },
    mustSample: ["Back to reports", "Open note"],
  },
  {
    name: "research list and run button",
    params: { view: "research", case: "research-empty", width: "full", nav: "1" },
    mustSample: ["Run now"],
  },
  {
    name: "tasks create form",
    params: { view: "tasks", case: "tasks-create-form-error", width: "full" },
    mustSample: [],
  },
  {
    name: "task detail form",
    params: { view: "tasks", case: "tasks-detail-conflict", width: "full" },
    mustSample: [],
  },
  {
    name: "tasks list",
    params: { view: "tasks", case: "tasks-today", width: "full" },
    mustSample: [],
  },
  {
    name: "approvals",
    params: { view: "agent-runs", case: "approvals-pending-destructive", width: "full" },
    mustSample: [],
  },
  {
    name: "tab strip with count",
    params: { view: "agent-runs", case: "shell-nav-count", width: "full" },
    mustSample: ["AGENT RUNS", "RESEARCH"],
  },
  {
    name: "project tasks panel",
    params: { view: "projects", case: "project-tasks", width: "full" },
    mustSample: [],
  },
];

/** One thing the page drew, as the browser computed it. */
interface Sample {
  readonly kind: "text" | "value" | "placeholder";
  readonly where: string;
  readonly text: string;
  readonly color: string;
  /** The element's own background, then each ancestor's, outward. */
  readonly backgrounds: readonly string[];
  readonly opacity: number;
  readonly fontPx: number;
  readonly bold: boolean;
}

interface FieldEdge {
  readonly where: string;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly backgrounds: readonly string[];
  /** The parent's backgrounds, outward, for what the field sits on. */
  readonly surround: readonly string[];
}

interface Harvest {
  readonly samples: readonly Sample[];
  readonly fields: readonly FieldEdge[];
  readonly unreadable: readonly string[];
}

/** Runs in the page: collects the rendered colours. No assertion lives here. */
async function harvest(page: Page): Promise<Harvest> {
  return page.evaluate(() => {
    const root = document.querySelector(".ccc-command-center");
    if (root === null) return { samples: [], fields: [], unreadable: ["no command center root"] };
    const describe = (el: Element): string => {
      const own = el.getAttribute("class");
      const first = own === null ? "" : `.${own.trim().split(/\s+/).slice(0, 2).join(".")}`;
      const role = el.getAttribute("role");
      return `${el.tagName.toLowerCase()}${first}${role === null ? "" : `[role=${role}]`}`;
    };
    const chain = (el: Element, from: "self" | "parent"): string[] => {
      const out: string[] = [];
      let node: Element | null = from === "self" ? el : el.parentElement;
      while (node !== null) {
        out.push(getComputedStyle(node).backgroundColor);
        node = node.parentElement;
      }
      return out;
    };
    const opacityOf = (el: Element): number => {
      let product = 1;
      let node: Element | null = el;
      while (node !== null) {
        product *= Number.parseFloat(getComputedStyle(node).opacity);
        node = node.parentElement;
      }
      return product;
    };
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      let node: Element | null = el;
      while (node !== null) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        node = node.parentElement;
      }
      return !el.closest(".ccc-visually-hidden");
    };
    const exempt = (el: Element): boolean =>
      el.closest(":disabled, [aria-disabled='true'], [disabled]") !== null;
    const samples: Sample[] = [];
    const fields: FieldEdge[] = [];
    const unreadable: string[] = [];
    for (const el of root.querySelectorAll("*")) {
      if (!visible(el) || exempt(el)) continue;
      const style = getComputedStyle(el);
      const base = {
        where: describe(el),
        color: style.color,
        backgrounds: chain(el, "self"),
        opacity: opacityOf(el),
        fontPx: Number.parseFloat(style.fontSize),
        bold: Number.parseInt(style.fontWeight, 10) >= 600,
      };
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const type = el.getAttribute("type");
        if (type === "radio" || type === "checkbox" || type === "hidden") continue;
        const field = el as HTMLInputElement;
        samples.push({ ...base, kind: "value", text: field.value || `(empty ${tag})` });
        if (el.getAttribute("placeholder") !== null && field.value === "") {
          const holder = getComputedStyle(el, "::placeholder");
          samples.push({
            ...base,
            kind: "placeholder",
            text: el.getAttribute("placeholder") ?? "",
            color: holder.color,
          });
        }
        fields.push({
          where: describe(el),
          borderColor: style.borderTopColor,
          borderWidth: Number.parseFloat(style.borderTopWidth),
          backgrounds: chain(el, "self"),
          surround: chain(el, "parent"),
        });
        continue;
      }
      let own = "";
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) own += node.textContent ?? "";
      }
      own = own.replace(/\s+/g, " ").trim();
      if (own !== "") samples.push({ ...base, kind: "text", text: own.slice(0, 60) });
    }
    return { samples, fields, unreadable };
  });
}

// ---------------------------------------------------------------------------
// The arithmetic, in Node. WCAG 2.2 relative luminance and contrast ratio; the same
// formulas as packages/plugin/src/contrast.ts, kept here because a spec may import only
// {@ccc/plugin, @playwright/test} (harness-purity.test.ts).
// ---------------------------------------------------------------------------

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parses the forms Chromium serialises a computed colour as; null for anything else. */
function parseColour(css: string): Rgba | null {
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

function alphaOf(raw: string | undefined): number {
  if (raw === undefined) return 1;
  return raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

const CANVAS: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** The colour a stack of backgrounds (own first, then outward) paints; null when one is unreadable. */
function paint(backgrounds: readonly string[]): Rgba | null {
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

function ratio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface Measured {
  readonly label: string;
  readonly ratio: number;
  readonly floor: number;
}

function isLarge(sample: Sample): boolean {
  return sample.fontPx >= 24 || (sample.bold && sample.fontPx >= 18.66);
}

function measureSamples(found: Harvest): { measured: Measured[]; problems: string[] } {
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
    const alpha = ink.a * sample.opacity;
    const shown = over({ ...ink, a: alpha }, background);
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

/** The focus ring of one control, measured against what it sits on. */
async function focusRing(page: Page, selector: string): Promise<Measured | null> {
  const target = page.locator(selector).first();
  if ((await target.count()) === 0) return null;
  await target.focus();
  // A keyboard press makes `:focus-visible` apply to a script focus.
  await page.keyboard.press("Shift");
  const facts = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    const chain: string[] = [];
    let node: Element | null = el;
    while (node !== null) {
      chain.push(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    return {
      matches: el.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      backgrounds: chain,
    };
  });
  const label = `focus ring ${selector}`;
  if (!facts.matches || facts.outlineStyle === "none" || facts.outlineWidth < 2) {
    return { label: `${label} (no visible ring)`, ratio: 0, floor: NON_TEXT_FLOOR };
  }
  const background = paint(facts.backgrounds);
  const ring = parseColour(facts.outlineColor);
  if (background === null || ring === null) {
    return { label: `${label} (unreadable colour)`, ratio: 0, floor: NON_TEXT_FLOOR };
  }
  return { label, ratio: ratio(over(ring, background), background), floor: NON_TEXT_FLOOR };
}

const FOCUS_TARGETS = [
  ".ccc-nav-item[aria-selected='true']",
  ".ccc-nav-item[aria-selected='false']",
  ".ccc-command-center button.ccc-connect-button",
  ".ccc-command-center button.ccc-filter-chip",
  ".ccc-report-citations button",
  ".ccc-command-center textarea.ccc-text-input",
  ".ccc-command-center input.ccc-text-input",
];

function summarise(host: Host, name: string, measured: readonly Measured[]): string {
  const worst = [...measured].sort((a, b) => a.ratio - b.ratio).slice(0, 5);
  return [
    `[${host}] ${name}: ${measured.length} measurements; lowest five:`,
    ...worst.map((m) => `  ${m.ratio.toFixed(2)}:1 (needs ${m.floor}) ${m.label}`),
  ].join("\n");
}

for (const host of HOSTS) {
  for (const spec of PAGES) {
    test(`contrast - ${spec.name} - host ${host}`, {
      annotation: { type: NO_BASELINE_ANNOTATION, description: `${spec.name}/${host}` },
    }, async ({ page }) => {
      test.setTimeout(90_000);
      await page.goto(harnessUrl({ ...spec.params, host }));
      await page.locator("html[data-harness-ready=true]").waitFor({ state: "attached" });
      await expect(page.locator(".ccc-command-center")).toHaveCount(1);

      const found = await harvest(page);
      const { measured, problems } = measureSamples(found);
      const rings: Measured[] = [];
      for (const selector of FOCUS_TARGETS) {
        const ring = await focusRing(page, selector);
        if (ring !== null) rings.push(ring);
      }
      const all = [...measured, ...rings];
      const report = summarise(host, spec.name, all);
      test.info().annotations.push({ type: "lowest-contrast", description: report });
      console.log(report);

      // Not vacuous: the page drew text, and the named subjects are among what was measured.
      expect(found.samples.length).toBeGreaterThan(5);
      for (const wanted of spec.mustSample) {
        expect(
          found.samples.some((sample) => sample.text.toLowerCase().includes(wanted.toLowerCase())),
          `${wanted} was not on the page`,
        ).toBe(true);
      }
      expect(problems).toEqual([]);
      const failures = all
        .filter((m) => m.ratio < m.floor)
        .map((m) => `${m.ratio.toFixed(2)}:1 < ${m.floor}:1  ${m.label}`);
      expect(failures).toEqual([]);
    });
  }
}
