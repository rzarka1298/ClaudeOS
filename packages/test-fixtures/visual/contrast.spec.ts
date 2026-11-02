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
  /**
   * Focus targets the page must carry (`FOCUS_TARGETS` entries). A ring is measured only when its
   * control is on the page, so naming it here keeps a missing control from passing unmeasured.
   */
  readonly focus?: readonly string[];
  /** Selectors that must NOT be on the page (a refused bundle renders no preview). */
  readonly absent?: readonly string[];
}

/**
 * The Phase 8 focus targets (UI-SPEC "Contrast pages"). The Today row is the list-row button the
 * card really uses (`.ccc-today-row` is not a class of this phase), scoped to the Today card; the
 * Technology card's one control is its `Open report` button.
 */
const NAV_ITEM = ".ccc-settings-nav-item";
const SWITCH = ".ccc-switch";
const SELECT = ".ccc-select";
const BUNDLE_PREVIEW = ".ccc-bundle-preview";
const HEALTH_ROW_BUTTON = ".ccc-health-row button.ccc-connect-button";
const TODAY_ROW = ".ccc-card:has(.ccc-today-section) button.ccc-list-primary";
const INTEL_BUTTON = ".ccc-intel-latest button.ccc-connect-button";

const PAGES: readonly PageSpec[] = [
  {
    name: "research reader and tabs",
    params: { view: "research", case: "research-report-full", width: "full", nav: "1" },
    mustSample: ["RESEARCH", "Overview", "Open note", "Cached", "[1]", "Quoted from source"],
  },
  {
    // Narrow, the open report replaces the list and the Back button appears.
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
  // Phase 9 (plan 09-22): a quiet idle session on the Agent runs destination and on the Active
  // sessions card. The quiet label is words beside a glyph, and it must read in both host themes.
  {
    name: "agent runs quiet session",
    params: { view: "agent-runs", case: "quiet-idle", width: "full" },
    mustSample: ["Idle — last event 41 min ago", "Last signal"],
  },
  {
    name: "active sessions card quiet session",
    params: { widget: "active-sessions", state: "quiet" },
    mustSample: ["Idle — last event 41 min ago", "1 quiet"],
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
  // Phase 8 (plan 08-21, D-31, D-32): the real Settings destination, one section per page.
  {
    name: "settings projects",
    params: { view: "settings", case: "settings-projects", width: "full", nav: "1" },
    mustSample: ["Projects", "Go to the projects view", "ExampleProjects"],
    focus: [NAV_ITEM],
  },
  {
    name: "settings launchers",
    params: { view: "settings", case: "settings-launchers", width: "full", nav: "1" },
    mustSample: ["Launchers", "Detect apps"],
    focus: [NAV_ITEM],
  },
  {
    name: "settings integrations",
    params: { view: "settings", case: "settings-integrations", width: "full", nav: "1" },
    mustSample: ["Integrations", "Copy install command", "Not part of this version"],
    focus: [NAV_ITEM],
  },
  {
    name: "settings approvals and tasks",
    params: { view: "settings", case: "settings-approvals-tasks", width: "full", nav: "1" },
    mustSample: ["Approval notifications", "Rebuild task index", "On"],
    focus: [NAV_ITEM, SWITCH],
  },
  {
    name: "settings paths",
    params: { view: "settings", case: "settings-paths", width: "full", nav: "1" },
    mustSample: ["Managed vault", "~/"],
    focus: [NAV_ITEM],
  },
  {
    name: "settings visual",
    params: { view: "settings", case: "settings-visual", width: "full", nav: "1" },
    mustSample: ["Reduced motion", "System"],
    focus: [NAV_ITEM, SELECT],
  },
  {
    // The tracer page. Security's `dl.ccc-detail-fields` reuses the Phase 5 facts-list rule inside
    // Settings, so this page is also where that rule's contrast is measured (UI-SPEC review item).
    name: "settings security",
    params: { view: "settings", case: "settings-security", width: "full", nav: "1" },
    mustSample: [
      "Transcript analysis",
      "Always allow",
      "Present",
      "Install secret in keychain",
      "Approval presence check",
      "Unavailable",
      "Key fingerprint",
    ],
    focus: [NAV_ITEM, SWITCH],
  },
  {
    name: "settings schedules",
    params: { view: "settings", case: "settings-schedules", width: "full", nav: "1" },
    mustSample: ["Manual trigger only", "Open the research view"],
    focus: [NAV_ITEM],
  },
  // The Diagnostics section in its states, and the bundle block.
  {
    name: "diagnostics fresh install",
    params: { view: "diagnostics", case: "diagnostics-fresh", width: "full", nav: "1" },
    mustSample: ["Run checks again", "Running", "Needs setup", "Not part of this version"],
    focus: [NAV_ITEM, HEALTH_ROW_BUTTON],
  },
  {
    name: "diagnostics every status kind",
    params: { view: "diagnostics", case: "diagnostics-mixed", width: "full", nav: "1" },
    mustSample: ["Degraded", "Failing", "Unknown", "Needs setup", "Running", "Codex hooks"],
    focus: [NAV_ITEM, HEALTH_ROW_BUTTON],
  },
  {
    name: "diagnostics disconnected",
    params: { view: "diagnostics", case: "diagnostics-disconnected", width: "full", nav: "1" },
    mustSample: ["Failing", "Can't be checked while"],
    focus: [NAV_ITEM],
  },
  {
    name: "diagnostics error",
    params: { view: "diagnostics", case: "diagnostics-error", width: "full", nav: "1" },
    mustSample: ["Couldn't run the checks"],
    focus: [NAV_ITEM],
  },
  {
    name: "diagnostics bundle preview",
    params: { view: "diagnostics", case: "diagnostics-bundle", width: "full", nav: "1" },
    // `Save bundle` is `aria-disabled` here (no save dialog in the harness), so it is exempt from the
    // text check like every disabled control; the reason it is described by is on the page and measured.
    mustSample: ["Copy bundle", "bundleVersion", "save dialog isn't available"],
    focus: [NAV_ITEM, BUNDLE_PREVIEW],
  },
  {
    // Phase 9 (09-22; D-09): the block's own status line after Copy bundle.
    name: "diagnostics bundle after copy",
    params: { view: "diagnostics", case: "diagnostics-bundle-after-copy", width: "full", nav: "1" },
    mustSample: ["Bundle copied.", "bundleVersion"],
    focus: [NAV_ITEM, BUNDLE_PREVIEW],
  },
  {
    name: "diagnostics bundle refused",
    params: { view: "diagnostics", case: "diagnostics-bundle-refused", width: "full", nav: "1" },
    mustSample: ["Bundle not offered", "refused by a privacy check"],
    focus: [NAV_ITEM],
    absent: [BUNDLE_PREVIEW],
  },
  {
    name: "settings narrow",
    params: { view: "settings", case: "settings-security", width: "narrow", nav: "1" },
    mustSample: ["Security"],
    focus: [NAV_ITEM],
  },
  // The Overview with the five slice cards in six of its eight states (loading and error carry
  // no new text and are covered by the pixel cells).
  {
    name: "overview slice ready",
    params: { view: "overview", case: "overview-slice-ready", nav: "1" },
    mustSample: [
      "Today",
      "Due today",
      "Overdue",
      "Technology and market intelligence",
      "Open report",
      "not part of this version",
    ],
    focus: [TODAY_ROW, INTEL_BUTTON],
  },
  {
    name: "overview slice next open",
    params: { view: "overview", case: "overview-slice-nextopen", nav: "1" },
    mustSample: ["Next open task", "Next due"],
    focus: [TODAY_ROW],
  },
  {
    name: "overview slice failure",
    params: { view: "overview", case: "overview-slice-failure", nav: "1" },
    mustSample: ["Research run failed", "Open the research view"],
    focus: [TODAY_ROW],
  },
  {
    name: "overview slice empty",
    params: { view: "overview", case: "overview-slice-empty", nav: "1" },
    mustSample: ["Nothing here yet", "No reports yet"],
  },
  {
    name: "overview slice stale and partial",
    params: { view: "overview", case: "overview-slice-partial-stale", nav: "1" },
    mustSample: ["Stale", "Partial", "Open the research view"],
    focus: [TODAY_ROW],
  },
  {
    name: "overview slice disconnected",
    params: { view: "overview", case: "overview-slice-disconnected", nav: "1" },
    mustSample: ["Service disconnected", "Unavailable"],
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
        // A select shows the label of its chosen option, not the option's value (`System`, not `auto`).
        const shown =
          tag === "select"
            ? ((el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "")
            : field.value;
        samples.push({ ...base, kind: "value", text: shown || `(empty ${tag})` });
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
      // A switch and the bundle preview region have an edge or a fill that tells them from what
      // they sit on (SC 1.4.11), so they are measured like a form field (Phase 8, D-32).
      if (el.matches("[role='switch'], .ccc-bundle-preview")) {
        fields.push({
          where: describe(el),
          borderColor: style.borderTopColor,
          borderWidth: Number.parseFloat(style.borderTopWidth),
          backgrounds: chain(el, "self"),
          surround: chain(el, "parent"),
        });
      }
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
  // Phase 8 (plan 08-21): the Settings nav, the switch, the select, the bundle preview region, the
  // health-row buttons, the Today rows and the Technology card's button.
  NAV_ITEM,
  SWITCH,
  SELECT,
  BUNDLE_PREVIEW,
  HEALTH_ROW_BUTTON,
  TODAY_ROW,
  INTEL_BUTTON,
];

function summarise(host: Host, name: string, measured: readonly Measured[]): string {
  const worst = [...measured].sort((a, b) => a.ratio - b.ratio).slice(0, 5);
  return [
    `[${host}] ${name}: ${measured.length} measurements; lowest five:`,
    ...worst.map((m) => `  ${m.ratio.toFixed(2)}:1 (needs ${m.floor}) ${m.label}`),
  ].join("\n");
}

interface Assessment {
  readonly report: string;
  /** Everything wrong with the page: a missing sample, an unreadable colour, a ratio below its floor. */
  readonly failures: readonly string[];
  readonly sampleCount: number;
}

/** Opens one page in one host theme, waits for the harness, and measures it. */
async function assessPage(page: Page, spec: PageSpec, host: Host): Promise<Assessment> {
  await page.goto(harnessUrl({ ...spec.params, host }));
  // A harness error (a typo in a case or a view) fails at once, with its text, instead of a timeout.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.querySelector(".ccc-harness-error")?.textContent ??
            (document.documentElement.getAttribute("data-harness-ready") === "true"
              ? "ready"
              : "waiting"),
        ),
      { timeout: 30_000 },
    )
    .toBe("ready");
  await expect(page.locator(".ccc-command-center")).toHaveCount(1);

  const found = await harvest(page);
  const { measured, problems } = measureSamples(found);
  const rings: Measured[] = [];
  const failures: string[] = [];
  for (const selector of FOCUS_TARGETS) {
    const ring = await focusRing(page, selector);
    if (ring !== null) rings.push(ring);
  }
  for (const wanted of spec.focus ?? []) {
    if ((await page.locator(wanted).count()) === 0) {
      failures.push(`focus target ${wanted} is not on the page, so its ring was not measured`);
    }
  }
  for (const unwanted of spec.absent ?? []) {
    if ((await page.locator(unwanted).count()) > 0) {
      failures.push(`${unwanted} is on the page and must not be`);
    }
  }
  const all = [...measured, ...rings];

  // Not vacuous: the page drew text, and the named subjects are among what was measured.
  if (found.samples.length <= 5) failures.push(`only ${found.samples.length} text samples`);
  for (const wanted of spec.mustSample) {
    if (!found.samples.some((sample) => sample.text.toLowerCase().includes(wanted.toLowerCase()))) {
      failures.push(`${wanted} was not on the page`);
    }
  }
  failures.push(...problems);
  failures.push(
    ...all
      .filter((m) => m.ratio < m.floor)
      .map((m) => `${m.ratio.toFixed(2)}:1 < ${m.floor}:1  ${m.label}`),
  );
  return { report: summarise(host, spec.name, all), failures, sampleCount: found.samples.length };
}

for (const host of HOSTS) {
  for (const spec of PAGES) {
    test(`contrast - ${spec.name} - host ${host}`, {
      annotation: { type: NO_BASELINE_ANNOTATION, description: `${spec.name}/${host}` },
    }, async ({ page }) => {
      test.setTimeout(90_000);
      const assessment = await assessPage(page, spec, host);
      test.info().annotations.push({ type: "lowest-contrast", description: assessment.report });
      console.log(assessment.report);
      expect(assessment.failures).toEqual([]);
    });
  }
}

// Non-vacuity (Phase 8, D-32): a page that draws the tab strip and none of what it must show fails
// through `mustSample`, so a harness that renders nothing can never pass a contrast page.
for (const host of HOSTS) {
  test(`contrast - a blank settings page fails through mustSample - host ${host}`, {
    annotation: { type: NO_BASELINE_ANNOTATION, description: `blank/${host}` },
  }, async ({ page }) => {
    const blank: PageSpec = {
      name: "blank settings",
      params: { view: "settings", case: "__empty", width: "full", nav: "1" },
      mustSample: ["Transcript analysis", "Always allow", "Present"],
      focus: [SWITCH],
    };
    const assessment = await assessPage(page, blank, host);
    // The tab strip gives it enough text to be a page, so only the named subjects fail.
    expect(assessment.sampleCount).toBeGreaterThan(5);
    for (const wanted of blank.mustSample) {
      expect(assessment.failures, wanted).toContain(`${wanted} was not on the page`);
    }
    expect(assessment.failures).toContain(
      `focus target ${SWITCH} is not on the page, so its ring was not measured`,
    );
  });
}
