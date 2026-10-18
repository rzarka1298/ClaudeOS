import { describe, expect, it, vi } from "vitest";
import {
  type ContrastHarvest,
  contrastFailures,
  lowestRatios,
  measureHarvest,
  paint,
  parseColour,
  ratio,
  readContrastInBothThemes,
  rendererHarvestContrast,
  rendererSetBase,
} from "./contrast-probe.js";

/**
 * The live-Obsidian contrast probe (Phase 7 live-UAT trial, run da14049b). The arithmetic is pinned
 * on the trial's own numbers: the active tab label, a cream label on the light theme's pale button
 * face, measured 1.15:1; a muted pill label on that face 2.93:1.
 */

const DARK_PAGE = "rgb(11, 11, 15)";
const LIGHT_FACE = "rgb(255, 255, 255)";

function sample(over: Partial<ContrastHarvest["samples"][number]> = {}) {
  return {
    kind: "text" as const,
    where: "button.ccc-nav-item[role=tab]",
    text: "Research",
    color: "rgb(244, 239, 230)",
    backgrounds: [DARK_PAGE],
    opacity: 1,
    fontPx: 13,
    bold: false,
    ...over,
  };
}

describe("parseColour and paint", () => {
  it("reads the notations Chromium computes", () => {
    expect(parseColour("rgb(244, 239, 230)")).toEqual({ r: 244, g: 239, b: 230, a: 1 });
    expect(parseColour("rgba(21, 21, 27, 0.72)")).toEqual({ r: 21, g: 21, b: 27, a: 0.72 });
    expect(parseColour("color(srgb 1 0.5 0 / 0.5)")).toEqual({ r: 255, g: 127.5, b: 0, a: 0.5 });
    expect(parseColour("oklch(0.5 0.1 200)")).toBeNull();
  });

  it("composites backgrounds from the outermost in, over white when none is opaque", () => {
    expect(paint(["rgba(0, 0, 0, 0)", DARK_PAGE])).toMatchObject({ r: 11, g: 11, b: 15 });
    expect(paint(["rgba(0, 0, 0, 0)"])).toMatchObject({ r: 255, g: 255, b: 255 });
    expect(paint(["rgba(0, 0, 0, 0.5)", LIGHT_FACE])).toMatchObject({ r: 127.5 });
    expect(paint(["oklch(0.5 0.1 200)"])).toBeNull();
  });
});

describe("ratio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(ratio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 5);
    expect(ratio({ r: 9, g: 9, b: 9, a: 1 }, { r: 9, g: 9, b: 9, a: 1 })).toBe(1);
  });
});

describe("measureHarvest", () => {
  it("reproduces the trial's unreadable tab label: cream ink on the light theme's button face", () => {
    const found: ContrastHarvest = {
      samples: [sample({ backgrounds: [LIGHT_FACE, DARK_PAGE] })],
      fields: [],
      unreadable: [],
    };
    const { measured } = measureHarvest(found);
    expect(measured[0]?.ratio).toBeCloseTo(1.15, 1);
    expect(contrastFailures(measured)).toEqual([
      expect.stringMatching(
        /^1\.1\d:1 < 4\.5:1 {2}text button\.ccc-nav-item\[role=tab\] "Research"$/,
      ),
    ]);
  });

  it("passes the command center's own ink on its own page, and reads large text against 3:1", () => {
    const { measured } = measureHarvest({
      samples: [sample(), sample({ color: "rgb(154, 148, 166)", fontPx: 30, text: "Heading" })],
      fields: [],
      unreadable: [],
    });
    expect(measured.map((entry) => entry.floor)).toEqual([4.5, 3]);
    expect(contrastFailures(measured)).toEqual([]);
  });

  it("dims the ink by the element's opacity", () => {
    const { measured } = measureHarvest({
      samples: [sample({ opacity: 0.4 })],
      fields: [],
      unreadable: [],
    });
    expect(measured[0]?.ratio).toBeLessThan(4.5);
  });

  it("measures a form field by its edge or its fill against what it sits on, and flags an unreadable colour", () => {
    const { measured, problems } = measureHarvest({
      samples: [sample({ color: "oklch(0.5 0.1 200)" })],
      fields: [
        {
          where: "textarea.ccc-text-input",
          borderColor: "rgb(228, 228, 228)",
          borderWidth: 1,
          backgrounds: ["rgb(255, 255, 255)"],
          surround: ["rgb(255, 255, 255)"],
        },
        {
          where: "input.ccc-text-input",
          borderColor: "rgb(154, 148, 166)",
          borderWidth: 1,
          backgrounds: ["rgb(21, 21, 27)"],
          surround: [DARK_PAGE],
        },
      ],
      unreadable: [],
    });
    expect(problems).toHaveLength(1);
    expect(contrastFailures(measured)).toEqual([
      expect.stringMatching(/field edge textarea\.ccc-text-input$/),
    ]);
    expect(lowestRatios(measured, 1)).toHaveLength(1);
  });

  it("carries the renderer's own complaints through", () => {
    expect(
      measureHarvest({ samples: [], fields: [], unreadable: ["no element matches .x"] }).problems,
    ).toEqual(["no element matches .x"]);
  });
});

describe("rendererSetBase", () => {
  it("swaps the theme class on body and reports the one it found", () => {
    const classes = new Set(["theme-dark", "other"]);
    vi.stubGlobal("document", {
      body: {
        classList: {
          contains: (name: string) => classes.has(name),
          add: (name: string) => classes.add(name),
          remove: (name: string) => classes.delete(name),
        },
      },
    });
    expect(rendererSetBase("theme-light")).toEqual({ was: "theme-dark", now: "theme-light" });
    expect([...classes].sort()).toEqual(["other", "theme-light"]);
    expect(rendererSetBase(null)).toEqual({ was: "theme-light", now: null });
    expect([...classes]).toEqual(["other"]);
    vi.unstubAllGlobals();
    expect(rendererSetBase("theme-dark")).toEqual({ was: null, now: null });
  });
});

describe("rendererHarvestContrast", () => {
  it("says so when the root is missing instead of reading nothing", () => {
    vi.stubGlobal("document", { querySelector: () => null });
    expect(rendererHarvestContrast(".ccc-command-center").unreadable).toEqual([
      "no element matches .ccc-command-center",
    ]);
    vi.unstubAllGlobals();
  });

  it("collects visible text, a field and its placeholder, and skips hidden, disabled and visually hidden elements", () => {
    interface Fake {
      tagName: string;
      parentElement: Fake | null;
      cls: string | null;
      role?: string;
      childNodes: Array<{ nodeType: number; textContent: string | null }>;
      value?: string;
      placeholder?: string;
      type?: string;
      size: { width: number; height: number };
      closestMatches: string[];
      style: Record<string, string>;
      kids: Fake[];
    }
    const page: Fake = {
      tagName: "DIV",
      parentElement: null,
      cls: "ccc-command-center",
      childNodes: [],
      size: { width: 100, height: 100 },
      closestMatches: [],
      style: { display: "block", visibility: "visible", opacity: "1", backgroundColor: DARK_PAGE },
      kids: [],
    };
    const make = (over: Partial<Fake>): Fake => {
      const el: Fake = {
        tagName: "SPAN",
        parentElement: page,
        cls: null,
        childNodes: [],
        size: { width: 10, height: 10 },
        closestMatches: [],
        style: {
          display: "inline",
          visibility: "visible",
          opacity: "1",
          backgroundColor: "rgba(0, 0, 0, 0)",
        },
        kids: [],
        ...over,
      };
      page.kids.push(el);
      return el;
    };
    make({
      tagName: "BUTTON",
      cls: "ccc-nav-item",
      role: "tab",
      childNodes: [{ nodeType: 3, textContent: " Research " }],
    });
    make({ tagName: "TEXTAREA", cls: "ccc-text-input", value: "", placeholder: "Describe it" });
    make({ tagName: "INPUT", type: "radio", cls: "ccc-radio" });
    make({
      tagName: "SPAN",
      childNodes: [{ nodeType: 3, textContent: "hidden" }],
      style: {
        display: "none",
        visibility: "visible",
        opacity: "1",
        backgroundColor: "rgba(0, 0, 0, 0)",
      },
    });
    make({
      tagName: "SPAN",
      childNodes: [{ nodeType: 3, textContent: "off" }],
      closestMatches: [":disabled, [aria-disabled='true'], [disabled]"],
    });
    make({
      tagName: "SPAN",
      childNodes: [{ nodeType: 3, textContent: "sr only" }],
      closestMatches: [".ccc-visually-hidden"],
    });
    make({
      tagName: "SPAN",
      childNodes: [{ nodeType: 3, textContent: "flat" }],
      size: { width: 0, height: 0 },
    });
    const wrap = (el: Fake): unknown => ({
      tagName: el.tagName,
      get parentElement() {
        return el.parentElement === null ? null : wrap(el.parentElement);
      },
      childNodes: el.childNodes,
      value: el.value,
      getAttribute: (name: string) =>
        name === "class"
          ? el.cls
          : name === "role"
            ? (el.role ?? null)
            : name === "type"
              ? (el.type ?? null)
              : name === "placeholder"
                ? (el.placeholder ?? null)
                : null,
      getBoundingClientRect: () => el.size,
      closest: (selector: string) => (el.closestMatches.includes(selector) ? {} : null),
      querySelectorAll: () => el.kids.map(wrap),
      __style: el.style,
    });
    vi.stubGlobal("document", { querySelector: () => wrap(page) });
    vi.stubGlobal(
      "getComputedStyle",
      (element: { __style: Record<string, string> }, pseudo?: string) => ({
        color: pseudo === "::placeholder" ? "rgb(154, 148, 166)" : "rgb(244, 239, 230)",
        fontSize: "13px",
        fontWeight: "400",
        borderTopColor: "rgb(154, 148, 166)",
        borderTopWidth: "1px",
        ...element.__style,
      }),
    );
    const found = rendererHarvestContrast(".ccc-command-center");
    expect(found.unreadable).toEqual([]);
    expect(found.samples.map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
      "text:Research",
      "value:(empty textarea)",
      "placeholder:Describe it",
    ]);
    expect(found.fields).toHaveLength(1);
    expect(found.samples[0]?.where).toBe("button.ccc-nav-item[role=tab]");
    vi.unstubAllGlobals();
  });
});

describe("readContrastInBothThemes", () => {
  it("reads light then dark and puts the window back in the theme it was in", async () => {
    const bases: Array<string | null> = [];
    const browser = {
      async execute(fn: (...args: never[]) => unknown, ...args: unknown[]) {
        if (fn.name === "rendererSetBase") {
          bases.push(args[0] as string | null);
          return { was: "theme-dark", now: args[0] } as never;
        }
        return {
          samples: [
            sample({ backgrounds: [bases.at(-1) === "theme-light" ? LIGHT_FACE : DARK_PAGE] }),
          ],
          fields: [],
          unreadable: [],
        } as never;
      },
    };
    const readings = await readContrastInBothThemes(browser, ".ccc-command-center");
    expect(readings.map((reading) => reading.base)).toEqual(["theme-light", "theme-dark"]);
    expect(bases).toEqual(["theme-light", "theme-light", "theme-dark", "theme-dark"]);
    expect(readings[0] && contrastFailures(readings[0].measured)).toHaveLength(1);
    expect(readings[1] && contrastFailures(readings[1].measured)).toEqual([]);
    expect(readings[1]?.texts).toEqual(["Research"]);
  });
});
