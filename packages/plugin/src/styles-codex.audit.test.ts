import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
const MARKER = "/* ===== Phase 05.1: Codex card, reserve tick, pair status ===== */";
const START = SOURCE.indexOf(MARKER);
const SECTION = START < 0 ? "" : SOURCE.slice(START + MARKER.length);
const CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = [...CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: (match[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " ")),
  body: match[2] ?? "",
}));
const CLASSES = [
  "ccc-codex-sections",
  "ccc-headroom-strip",
  "ccc-headroom-cell",
  "ccc-reserve-meter-wrap",
  "ccc-reserve-meter",
  "ccc-reserve-tick",
  "ccc-reserve-legend",
  "ccc-codex-current",
  "ccc-launch-status-pair",
  "ccc-launch-agent-line",
];
function bodyFor(selector: string): string {
  return RULES.filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
    .join(";");
}
const ROOT = ".ccc-command-center";

describe("Phase 05.1 Codex CSS contract", () => {
  it("appends exactly one section with exactly the ten planned classes under the root", () => {
    expect(START).toBeGreaterThan(0);
    expect(SOURCE.split(MARKER)).toHaveLength(2);
    expect(SECTION).not.toMatch(/Phase \d/);
    const classes = new Set(
      RULES.flatMap((rule) =>
        rule.selectors.flatMap((selector) =>
          [...selector.matchAll(/\.(ccc-[a-z-]+)/g)].map((m) => m[1]),
        ),
      ),
    );
    classes.delete("ccc-command-center");
    expect([...classes].sort()).toEqual([...CLASSES].sort());
    for (const rule of RULES) {
      for (const selector of rule.selectors) expect(selector.startsWith(`${ROOT} `)).toBe(true);
    }
  });
  it("adds no tokens, colour literals, spacing pixels, breakpoint or animation", () => {
    expect(CODE).not.toMatch(
      /!important|#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|color)\(|--ccc-[\w-]+\s*:|\b\d+(?:\.\d+)?px\b|@media|@container|@keyframes|animation\s*:/i,
    );
    const tokens = new Set(
      [...SOURCE.slice(0, START).matchAll(/(--ccc-[a-z-]+)\s*:/g)].map((m) => m[1]),
    );
    for (const match of CODE.matchAll(/var\((--[a-z-]+)\)/g))
      expect(tokens.has(match[1] ?? "")).toBe(true);
    for (const rule of RULES) {
      for (const declaration of rule.body.split(";")) {
        const [property, value] = declaration.split(":").map((s) => s.trim());
        if (property === "color" || property === "background" || property === "background-color") {
          expect(value).toMatch(/^var\(--ccc-[a-z-]+\)$/);
        }
        // Let the browser's CSS parser recognise all named colours, including
        // aliases, rather than maintaining a partial list of colour words.
        const probe = new Option().style;
        const literalValue = (value ?? "").replace(/var\(--ccc-[a-z-]+\)/g, "");
        for (const word of literalValue.match(/[a-z][a-z0-9-]*/gi) ?? []) {
          probe.color = "";
          probe.color = word;
          expect(probe.color, `Colour literal in ${declaration}`).toBe("");
        }
        if (property === "font-size")
          expect(value).toMatch(/^var\(--ccc-text-(label|body|heading|display)\)$/);
        if (property === "transition") expect(value).toBe("none");
      }
    }
  });
  it("stacks sections with the section gap and hairline separators", () => {
    const section = bodyFor(`${ROOT} .ccc-codex-sections`);
    expect(section).toMatch(/flex-direction:\s*column/);
    expect(section).toMatch(/gap:\s*var\(--ccc-space-lg\)/);
    expect(bodyFor(`${ROOT} .ccc-codex-sections > * + *`)).toMatch(
      /border-block-start:\s*var\(--ccc-border-hairline\) solid var\(--ccc-border\)/,
    );
  });
  it("stacks headroom through auto-fit at a token-derived ten rem minimum", () => {
    expect(SOURCE).toMatch(/--ccc-space-md:\s*1rem/);
    expect(bodyFor(`${ROOT} .ccc-headroom-strip`)).toMatch(
      /repeat\(auto-fit, minmax\(min\(100%, calc\(10 \* var\(--ccc-space-md\)\)\), 1fr\)\)/,
    );
    expect(bodyFor(`${ROOT} .ccc-headroom-strip`)).toMatch(/gap:\s*var\(--ccc-space-md\)/);
    const cell = bodyFor(`${ROOT} .ccc-headroom-cell`);
    expect(cell).toMatch(/flex-direction:\s*column/);
    expect(cell).toMatch(/overflow-wrap:\s*anywhere/);
    expect(cell).toMatch(/min-width:\s*0/);
  });
  it("positions the reserve tick at 80 percent with token edges and overshoot", () => {
    const tick = bodyFor(`${ROOT} .ccc-reserve-tick`);
    expect(tick).toMatch(/position:\s*absolute/);
    expect(tick).toMatch(/left:\s*80%/);
    expect(tick).toMatch(/width:\s*var\(--ccc-focus-ring\)/);
    expect(tick).toMatch(/top:\s*calc\(-1 \* var\(--ccc-space-xs\)\)/);
    expect(tick).toMatch(/bottom:\s*calc\(-1 \* var\(--ccc-space-xs\)\)/);
    expect(tick).toMatch(/background:\s*var\(--ccc-ink\)/);
    expect(tick).toMatch(/border-inline:\s*var\(--ccc-border-hairline\) solid var\(--ccc-bg\)/);
    expect(tick).toMatch(/transition:\s*none/);
    expect(bodyFor(`${ROOT} .ccc-reserve-meter-wrap`)).toMatch(/position:\s*relative/);
    expect(bodyFor(`${ROOT} .ccc-reserve-meter`)).toMatch(/height:\s*var\(--ccc-space-sm\)/);
    for (const rule of RULES.filter((rule) =>
      rule.selectors.some((s) => s.includes(".ccc-reserve-meter")),
    )) {
      expect(rule.body).toMatch(/transition:\s*none/);
    }
  });
  it("keeps track, fill, legend and current run on the existing scale", () => {
    expect(bodyFor(`${ROOT} .ccc-reserve-meter::-webkit-meter-bar`)).toMatch(
      /background:\s*var\(--ccc-border\)/,
    );
    for (const pseudo of ["optimum", "suboptimum", "even-less-good"]) {
      expect(bodyFor(`${ROOT} .ccc-reserve-meter::-webkit-meter-${pseudo}-value`)).toMatch(
        /background:\s*var\(--ccc-ink\)/,
      );
    }
    const legend = bodyFor(`${ROOT} .ccc-reserve-legend`);
    expect(legend).toMatch(/justify-content:\s*flex-end/);
    expect(legend).toMatch(/color:\s*var\(--ccc-ink-muted\)/);
    expect(legend).toMatch(/font-size:\s*var\(--ccc-text-label\)/);
    expect(bodyFor(`${ROOT} .ccc-codex-current`)).toMatch(/padding:\s*var\(--ccc-space-md\)/);
  });
  it("pairs every tone with its own text in the consuming markup contract", () => {
    const tones = {
      opening: ["--ccc-ink-muted", "Opening a tab in Antigravity…"],
      setup: ["--ccc-ink-muted", "◌ Codex: Codex isn't set up yet."],
      success: ["--ccc-ink", "✓ Codex: Opened in an Antigravity tab"],
      error: ["--ccc-danger", "▲ Codex: {problem} {next step}"],
    };
    const toneSelectors = RULES.flatMap((rule) => rule.selectors).filter((s) =>
      s.includes("data-tone"),
    );
    expect(toneSelectors).toHaveLength(4);
    for (const [tone, [ink, text]] of Object.entries(tones)) {
      expect(bodyFor(`${ROOT} .ccc-launch-agent-line[data-tone="${tone}"]`)).toContain(
        `color: var(${ink})`,
      );
      expect(SECTION).toContain(`${tone}: ${text}`);
    }
    expect(bodyFor(`${ROOT} .ccc-launch-status-pair`)).toMatch(/gap:\s*var\(--ccc-space-sm\)/);
  });
});

describe("wave 4 spacing and legend alignment", () => {
  it("spreads the state line and legend, separates plan-usage windows and the disconnected explainer", () => {
    expect(bodyFor(`${ROOT} div.ccc-reserve-legend`)).toMatch(/justify-content:\s*space-between/);
    expect(bodyFor(`${ROOT} div.ccc-reserve-legend`)).toMatch(/flex-wrap:\s*wrap/);
    // The window and explainer spacing live outside the Phase 05.1 section,
    // beside the rules they extend, because the section's class set is pinned.
    expect(SOURCE).toMatch(
      /\.ccc-usage-row \+ \.ccc-usage-row \{\s*margin-block-start: var\(--ccc-space-md\);/,
    );
    expect(SOURCE).toMatch(
      /\.ccc-card\[data-presentation="disconnected"\] \.ccc-state-body \+ \.ccc-codex-sections \{\s*margin-top: var\(--ccc-space-md\);/,
    );
  });
});
